package loans

import (
	"errors"
	"fmt"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/lib/pq"
	"github.com/mattn/go-sqlite3"
	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const (
	maximumRepositoryPageSize         = 100
	maximumActionPersistenceAttempts  = 8
	initialActionPersistenceRetryWait = 5 * time.Millisecond
)

// ContractCursor 是合同列表按更新时间和合同 ID 倒序分页的稳定游标。
type ContractCursor struct {
	UpdatedUnixTime int64
	ContractId      int64
}

// ContractPage 保存一页合同及可空下一页游标。
type ContractPage struct {
	Items      []*Contract
	NextCursor *ContractCursor
}

// InstallmentCursor 是逐期计划按期次和行 ID 正序分页的稳定游标。
type InstallmentCursor struct {
	InstallmentNumber int64
	InstallmentId     int64
}

// InstallmentPage 保存一页不可变逐期计划。
type InstallmentPage struct {
	Items      []*Installment
	NextCursor *InstallmentCursor
}

// AllocationCursor 是分配历史按更新时间和分配 ID 倒序分页的稳定游标。
type AllocationCursor struct {
	UpdatedUnixTime int64
	AllocationId    int64
}

// AllocationPage 保存一页当前或历史正式交易分配。
type AllocationPage struct {
	Items      []*TransactionAllocation
	NextCursor *AllocationCursor
}

// AllocationAggregate 是按期次与组件聚合的活动分配金额和笔数。
type AllocationAggregate struct {
	InstallmentId   *int64        `xorm:"installment_id"`
	ComponentType   ComponentType `xorm:"component_type"`
	AllocatedAmount int64         `xorm:"allocated_amount"`
	AllocationCount int64         `xorm:"allocation_count"`
}

// Repository 只访问当前 uid 所在 UserDataStore 分片。
// 所有读取和写入都通过 privacy session，并在 SQL 中同时限定 uid。
type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 是贷款仓储的受限隐私事务句柄。
type RepositoryTransaction struct {
	uid      int64
	database *datastore.Database
	session  *xorm.Session
}

// NewRepository 创建贷款持久层入口。
func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("loan repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("loan repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

// DoTransaction 在 uid 所在分片执行单一事务，并强制关闭 SQL 参数日志。
func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("loan repository transaction callback is required")
	}

	database, err := r.database(uid)

	if err != nil {
		return err
	}

	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		return fn(&RepositoryTransaction{uid: uid, database: database, session: sess})
	})
}

// FindContractById 按 uid 和合同 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindContractById(c core.Context, uid int64, contractId int64) (*Contract, error) {
	if uid < 1 || contractId < 1 {
		return nil, fmt.Errorf("invalid loan contract owner or id")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findContractById(sess, uid, contractId)
}

// FindContractById 在当前隐私事务中按固定 uid 查询合同。
func (tx *RepositoryTransaction) FindContractById(contractId int64) (*Contract, error) {
	if err := tx.validate(); err != nil || contractId < 1 {
		return nil, fmt.Errorf("invalid loan contract transaction lookup")
	}

	return findContractById(tx.session, tx.uid, contractId)
}

func findContractById(sess *xorm.Session, uid int64, contractId int64) (*Contract, error) {
	contract := new(Contract)
	found, err := sess.Where("uid=? AND contract_id=?", uid, contractId).Get(contract)

	if err != nil {
		return nil, fmt.Errorf("find loan contract: %w", err)
	}

	if !found {
		return nil, nil
	}

	return contract, nil
}

// ListContracts 按 status、更新时间和合同 ID 倒序稳定分页。
func (r *Repository) ListContracts(c core.Context, uid int64, status ContractStatus, cursor *ContractCursor, limit int) (*ContractPage, error) {
	if uid < 1 || !isContractStatus(status) || !isValidPageLimit(limit) || !isValidContractCursor(cursor) {
		return nil, fmt.Errorf("invalid loan contract page")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	contracts := make([]*Contract, 0, limit+1)
	query := sess.Where("uid=? AND status=?", uid, status)

	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND contract_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.ContractId)
	}

	if err := query.Desc("updated_unix_time", "contract_id").Limit(limit + 1).Find(&contracts); err != nil {
		return nil, fmt.Errorf("list loan contracts: %w", err)
	}

	page := &ContractPage{Items: contracts}

	if len(contracts) > limit {
		page.Items = contracts[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &ContractCursor{UpdatedUnixTime: last.UpdatedUnixTime, ContractId: last.ContractId}
	}

	return page, nil
}

// FindRevisionById 按 uid 和 revision ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindRevisionById(c core.Context, uid int64, revisionId int64) (*ContractRevision, error) {
	if uid < 1 || revisionId < 1 {
		return nil, fmt.Errorf("invalid loan revision owner or id")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findRevisionById(sess, uid, revisionId)
}

// FindRevisionById 在当前隐私事务中查询不可变 revision。
func (tx *RepositoryTransaction) FindRevisionById(revisionId int64) (*ContractRevision, error) {
	if err := tx.validate(); err != nil || revisionId < 1 {
		return nil, fmt.Errorf("invalid loan revision transaction lookup")
	}

	return findRevisionById(tx.session, tx.uid, revisionId)
}

func findRevisionById(sess *xorm.Session, uid int64, revisionId int64) (*ContractRevision, error) {
	revision := new(ContractRevision)
	found, err := sess.Where("uid=? AND revision_id=?", uid, revisionId).Get(revision)

	if err != nil {
		return nil, fmt.Errorf("find loan revision: %w", err)
	}

	if !found {
		return nil, nil
	}

	return revision, nil
}

// FindRevisionByActionId 读取一个 action 唯一产生的 revision。
func (r *Repository) FindRevisionByActionId(c core.Context, uid int64, actionId int64) (*ContractRevision, error) {
	if uid < 1 || actionId < 1 {
		return nil, fmt.Errorf("invalid loan revision action lookup")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	revision := new(ContractRevision)
	found, err := sess.Where("uid=? AND action_id=?", uid, actionId).Get(revision)

	if err != nil {
		return nil, fmt.Errorf("find loan revision by action: %w", err)
	}

	if !found {
		return nil, nil
	}

	return revision, nil
}

// FindInstallmentById 按 uid 和期次行 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindInstallmentById(c core.Context, uid int64, installmentId int64) (*Installment, error) {
	if uid < 1 || installmentId < 1 {
		return nil, fmt.Errorf("invalid loan installment owner or id")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findInstallmentById(sess, uid, installmentId)
}

// FindInstallmentById 在当前隐私事务中查询不可变期次。
func (tx *RepositoryTransaction) FindInstallmentById(installmentId int64) (*Installment, error) {
	if err := tx.validate(); err != nil || installmentId < 1 {
		return nil, fmt.Errorf("invalid loan installment transaction lookup")
	}

	return findInstallmentById(tx.session, tx.uid, installmentId)
}

func findInstallmentById(sess *xorm.Session, uid int64, installmentId int64) (*Installment, error) {
	installment := new(Installment)
	found, err := sess.Where("uid=? AND installment_id=?", uid, installmentId).Get(installment)

	if err != nil {
		return nil, fmt.Errorf("find loan installment: %w", err)
	}

	if !found {
		return nil, nil
	}

	return installment, nil
}

// ListInstallmentsByRevision 按期次和行 ID 正序稳定分页。
func (r *Repository) ListInstallmentsByRevision(c core.Context, uid int64, contractId int64, revisionId int64, cursor *InstallmentCursor, limit int) (*InstallmentPage, error) {
	if uid < 1 || contractId < 1 || revisionId < 1 || !isValidPageLimit(limit) || !isValidInstallmentCursor(cursor) {
		return nil, fmt.Errorf("invalid loan installment page")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	installments := make([]*Installment, 0, limit+1)
	query := sess.Where("uid=? AND contract_id=? AND revision_id=?", uid, contractId, revisionId)

	if cursor != nil {
		query = query.And("(installment_number>? OR (installment_number=? AND installment_id>?))", cursor.InstallmentNumber, cursor.InstallmentNumber, cursor.InstallmentId)
	}

	if err := query.Asc("installment_number", "installment_id").Limit(limit + 1).Find(&installments); err != nil {
		return nil, fmt.Errorf("list loan installments: %w", err)
	}

	page := &InstallmentPage{Items: installments}

	if len(installments) > limit {
		page.Items = installments[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &InstallmentCursor{InstallmentNumber: last.InstallmentNumber, InstallmentId: last.InstallmentId}
	}

	return page, nil
}

// FindActionById 按 uid 和 action ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindActionById(c core.Context, uid int64, actionId int64) (*Action, error) {
	if uid < 1 || actionId < 1 {
		return nil, fmt.Errorf("invalid loan action owner or id")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findActionById(sess, uid, actionId)
}

// FindActionById 在当前隐私事务中查询 action。
func (tx *RepositoryTransaction) FindActionById(actionId int64) (*Action, error) {
	if err := tx.validate(); err != nil || actionId < 1 {
		return nil, fmt.Errorf("invalid loan action transaction lookup")
	}

	return findActionById(tx.session, tx.uid, actionId)
}

func findActionById(sess *xorm.Session, uid int64, actionId int64) (*Action, error) {
	action := new(Action)
	found, err := sess.Where("uid=? AND action_id=?", uid, actionId).Get(action)

	if err != nil {
		return nil, fmt.Errorf("find loan action: %w", err)
	}

	if !found {
		return nil, nil
	}

	return action, nil
}

// FindActionByIdempotencyKeyDigest 按 uid 和摘要查询幂等命令。
func (r *Repository) FindActionByIdempotencyKeyDigest(c core.Context, uid int64, digest string) (*Action, error) {
	if uid < 1 || !isLowerHexSHA256(digest) {
		return nil, fmt.Errorf("invalid loan action idempotency lookup")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findActionByKey(sess, uid, digest)
}

func findActionByKey(sess *xorm.Session, uid int64, digest string) (*Action, error) {
	action := new(Action)
	found, err := sess.Where("uid=? AND idempotency_key_digest=?", uid, digest).Get(action)

	if err != nil {
		return nil, fmt.Errorf("find loan action by idempotency key: %w", err)
	}

	if !found {
		return nil, nil
	}

	return action, nil
}

// CreateOrFindAction 由 uid+idempotency_key_digest 唯一约束裁决并发幂等命令。
// created=false 时调用方必须比较持久 request digest 后再决定重放或拒绝。
func (r *Repository) CreateOrFindAction(c core.Context, candidate *Action) (action *Action, created bool, err error) {
	if err := validateNewAction(candidate); err != nil {
		return nil, false, err
	}

	database, err := r.database(candidate.Uid)

	if err != nil {
		return nil, false, err
	}

	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		action, created, err = createOrFindAction(sess, database.DatabaseType(), candidate)
		sess.Close()

		if err == nil {
			return action, created, nil
		}

		if attempt+1 == maximumActionPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), err) {
			return nil, false, err
		}

		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return nil, false, waitErr
		}
	}

	return nil, false, fmt.Errorf("loan action persistence retry limit reached")
}

// CreateOrFindAction 在当前隐私事务中使用同一数据库唯一裁决。
func (tx *RepositoryTransaction) CreateOrFindAction(candidate *Action) (*Action, bool, error) {
	if err := tx.validate(); err != nil || candidate == nil || candidate.Uid != tx.uid {
		return nil, false, fmt.Errorf("invalid loan action transaction insert")
	}

	if err := validateNewAction(candidate); err != nil {
		return nil, false, err
	}

	return createOrFindAction(tx.session, tx.database.DatabaseType(), candidate)
}

func createOrFindAction(sess *xorm.Session, databaseType string, candidate *Action) (*Action, bool, error) {
	statement := `INSERT INTO pf_loan_action (
		uid, contract_id, expected_contract_version, applied_contract_version,
		action_type, previous_action_id, idempotency_key_digest,
		idempotency_key_version, request_digest, request_digest_version,
		status, reason_codes_json, error_code, created_unix_time,
		updated_unix_time, started_unix_time, completed_unix_time,
		failed_unix_time, action_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch databaseType {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, idempotency_key_digest) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported loan action database type")
	}

	result, execErr := sess.Exec(statement,
		candidate.Uid, candidate.ContractId, candidate.ExpectedContractVersion, candidate.AppliedContractVersion,
		candidate.ActionType, candidate.PreviousActionId, candidate.IdempotencyKeyDigest,
		candidate.IdempotencyKeyVersion, candidate.RequestDigest, candidate.RequestDigestVersion,
		candidate.Status, candidate.ReasonCodesJson, candidate.ErrorCode, candidate.CreatedUnixTime,
		candidate.UpdatedUnixTime, candidate.StartedUnixTime, candidate.CompletedUnixTime,
		candidate.FailedUnixTime, candidate.ActionId,
	)

	if execErr != nil && (databaseType != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert loan action: %w", execErr)
	}

	if execErr == nil {
		affected, affectedErr := result.RowsAffected()

		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read loan action insert result")
		}

		if affected == 1 {
			return cloneAction(candidate), true, nil
		}
	}

	persisted, findErr := findActionByKey(sess, candidate.Uid, candidate.IdempotencyKeyDigest)

	if findErr != nil {
		return nil, false, findErr
	}

	if persisted == nil {
		if execErr != nil {
			return nil, false, fmt.Errorf("insert loan action: %w", execErr)
		}

		return nil, false, fmt.Errorf("idempotent loan action is missing after unique conflict")
	}

	return persisted, false, nil
}

// FindTransactionBindingByTransactionId 按正式交易行查询并发锚点。
func (r *Repository) FindTransactionBindingByTransactionId(c core.Context, uid int64, transactionId int64) (*TransactionBinding, error) {
	if uid < 1 || transactionId < 1 {
		return nil, fmt.Errorf("invalid loan transaction binding lookup")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findTransactionBindingByTransactionId(sess, uid, transactionId)
}

// FindTransactionBindingByTransactionId 在当前隐私事务中查询并发锚点。
func (tx *RepositoryTransaction) FindTransactionBindingByTransactionId(transactionId int64) (*TransactionBinding, error) {
	if err := tx.validate(); err != nil || transactionId < 1 {
		return nil, fmt.Errorf("invalid loan transaction binding transaction lookup")
	}

	return findTransactionBindingByTransactionId(tx.session, tx.uid, transactionId)
}

func findTransactionBindingByTransactionId(sess *xorm.Session, uid int64, transactionId int64) (*TransactionBinding, error) {
	binding := new(TransactionBinding)
	found, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(binding)

	if err != nil {
		return nil, fmt.Errorf("find loan transaction binding: %w", err)
	}

	if !found {
		return nil, nil
	}

	return binding, nil
}

// FindAllocationById 按 uid 和 allocation ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindAllocationById(c core.Context, uid int64, allocationId int64) (*TransactionAllocation, error) {
	if uid < 1 || allocationId < 1 {
		return nil, fmt.Errorf("invalid loan allocation owner or id")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findAllocationById(sess, uid, allocationId)
}

// FindAllocationById 在当前隐私事务中查询分配。
func (tx *RepositoryTransaction) FindAllocationById(allocationId int64) (*TransactionAllocation, error) {
	if err := tx.validate(); err != nil || allocationId < 1 {
		return nil, fmt.Errorf("invalid loan allocation transaction lookup")
	}

	return findAllocationById(tx.session, tx.uid, allocationId)
}

func findAllocationById(sess *xorm.Session, uid int64, allocationId int64) (*TransactionAllocation, error) {
	allocation := new(TransactionAllocation)
	found, err := sess.Where("uid=? AND allocation_id=?", uid, allocationId).Get(allocation)

	if err != nil {
		return nil, fmt.Errorf("find loan allocation: %w", err)
	}

	if !found {
		return nil, nil
	}

	return allocation, nil
}

// ListAllocations 按合同、状态、更新时间和分配 ID 倒序稳定分页。
func (r *Repository) ListAllocations(c core.Context, uid int64, contractId int64, status AllocationStatus, cursor *AllocationCursor, limit int) (*AllocationPage, error) {
	if uid < 1 || contractId < 1 || !isAllocationStatus(status) || !isValidPageLimit(limit) || !isValidAllocationCursor(cursor) {
		return nil, fmt.Errorf("invalid loan allocation page")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	allocations := make([]*TransactionAllocation, 0, limit+1)
	query := sess.Where("uid=? AND contract_id=? AND status=?", uid, contractId, status)

	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND allocation_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.AllocationId)
	}

	if err := query.Desc("updated_unix_time", "allocation_id").Limit(limit + 1).Find(&allocations); err != nil {
		return nil, fmt.Errorf("list loan allocations: %w", err)
	}

	page := &AllocationPage{Items: allocations}

	if len(allocations) > limit {
		page.Items = allocations[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &AllocationCursor{UpdatedUnixTime: last.UpdatedUnixTime, AllocationId: last.AllocationId}
	}

	return page, nil
}

// AggregateActiveAllocations 按期次和组件聚合当前合同的活动分配。
func (r *Repository) AggregateActiveAllocations(c core.Context, uid int64, contractId int64) ([]*AllocationAggregate, error) {
	if uid < 1 || contractId < 1 {
		return nil, fmt.Errorf("invalid loan allocation aggregate")
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return aggregateActiveAllocations(sess, uid, contractId)
}

// AggregateActiveAllocations 在当前隐私事务中读取活动分配聚合。
func (tx *RepositoryTransaction) AggregateActiveAllocations(contractId int64) ([]*AllocationAggregate, error) {
	if err := tx.validate(); err != nil || contractId < 1 {
		return nil, fmt.Errorf("invalid loan allocation transaction aggregate")
	}

	return aggregateActiveAllocations(tx.session, tx.uid, contractId)
}

func aggregateActiveAllocations(sess *xorm.Session, uid int64, contractId int64) ([]*AllocationAggregate, error) {
	aggregates := make([]*AllocationAggregate, 0)
	err := sess.Table(new(TransactionAllocation)).
		Select("installment_id, component_type, SUM(allocated_amount) AS allocated_amount, COUNT(*) AS allocation_count").
		Where("uid=? AND contract_id=? AND status=?", uid, contractId, ALLOCATION_STATUS_ACTIVE).
		GroupBy("installment_id, component_type").
		Asc("installment_id", "component_type").
		Find(&aggregates)

	if err != nil {
		return nil, fmt.Errorf("aggregate active loan allocations: %w", err)
	}

	return aggregates, nil
}

// CountActiveAllocations 返回当前合同仍然活动的分配行数。
func (r *Repository) CountActiveAllocations(c core.Context, uid int64, contractId int64) (int64, error) {
	if uid < 1 || contractId < 1 {
		return 0, fmt.Errorf("invalid active loan allocation count")
	}

	database, err := r.database(uid)

	if err != nil {
		return 0, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return countActiveAllocations(sess, uid, contractId)
}

// CountActiveAllocations 在当前隐私事务中读取活动分配行数。
func (tx *RepositoryTransaction) CountActiveAllocations(contractId int64) (int64, error) {
	if err := tx.validate(); err != nil || contractId < 1 {
		return 0, fmt.Errorf("invalid active loan allocation transaction count")
	}

	return countActiveAllocations(tx.session, tx.uid, contractId)
}

func countActiveAllocations(sess *xorm.Session, uid int64, contractId int64) (int64, error) {
	count, err := sess.Where("uid=? AND contract_id=? AND status=?", uid, contractId, ALLOCATION_STATUS_ACTIVE).Count(new(TransactionAllocation))

	if err != nil {
		return 0, fmt.Errorf("count active loan allocations: %w", err)
	}

	return count, nil
}

// CountAllocations 返回当前合同全部当前或历史分配行数。
func (r *Repository) CountAllocations(c core.Context, uid int64, contractId int64) (int64, error) {
	if uid < 1 || contractId < 1 {
		return 0, fmt.Errorf("invalid loan allocation history count")
	}

	database, err := r.database(uid)

	if err != nil {
		return 0, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return countAllocations(sess, uid, contractId)
}

// CountAllocations 在当前隐私事务中读取全部当前或历史分配行数。
func (tx *RepositoryTransaction) CountAllocations(contractId int64) (int64, error) {
	if err := tx.validate(); err != nil || contractId < 1 {
		return 0, fmt.Errorf("invalid loan allocation history transaction count")
	}

	return countAllocations(tx.session, tx.uid, contractId)
}

func countAllocations(sess *xorm.Session, uid int64, contractId int64) (int64, error) {
	count, err := sess.Where("uid=? AND contract_id=?", uid, contractId).Count(new(TransactionAllocation))

	if err != nil {
		return 0, fmt.Errorf("count loan allocation history: %w", err)
	}

	return count, nil
}

// InsertContract 在当前隐私事务中创建合同。
func (tx *RepositoryTransaction) InsertContract(contract *Contract) error {
	if err := tx.validate(); err != nil || !isValidNewContract(contract, tx.uid) {
		return fmt.Errorf("invalid loan contract insert")
	}

	inserted, err := tx.session.Insert(contract)

	if err != nil {
		return fmt.Errorf("insert loan contract: %w", err)
	}

	if inserted != 1 {
		return fmt.Errorf("loan contract was not inserted")
	}

	return nil
}

// UpdateContractCAS 使用 uid+contract_id+version 条件更新全部合同可变字段。
func (tx *RepositoryTransaction) UpdateContractCAS(expectedVersion int64, next *Contract) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.ContractId < 1 ||
		expectedVersion < 1 || next.Version != expectedVersion+1 || !isContractStatus(next.Status) || next.UpdatedUnixTime < 1 {
		return false, fmt.Errorf("invalid loan contract CAS")
	}

	updated, err := tx.session.Where("uid=? AND contract_id=? AND version=?", tx.uid, next.ContractId, expectedVersion).
		Cols(
			"name", "lender_name", "contract_type", "liability_account_id", "status", "close_reason_code",
			"default_payment_account_id", "currency", "note", "version", "current_revision_id",
			"updated_unix_time", "closed_unix_time",
		).
		Update(next)

	if err != nil {
		return false, fmt.Errorf("update loan contract CAS: %w", err)
	}

	return updated == 1, nil
}

// InsertRevision 在当前隐私事务中追加不可变 revision。
func (tx *RepositoryTransaction) InsertRevision(revision *ContractRevision) error {
	if err := tx.validate(); err != nil || !isValidNewRevision(revision, tx.uid) {
		return fmt.Errorf("invalid loan revision insert")
	}

	inserted, err := tx.session.Insert(revision)

	if err != nil {
		return fmt.Errorf("insert loan revision: %w", err)
	}

	if inserted != 1 {
		return fmt.Errorf("loan revision was not inserted")
	}

	return nil
}

// InsertInstallments 在当前隐私事务中原子追加一组不可变逐期计划。
func (tx *RepositoryTransaction) InsertInstallments(installments []*Installment) error {
	if err := tx.validate(); err != nil || len(installments) < 1 {
		return fmt.Errorf("invalid loan installments insert")
	}

	for _, installment := range installments {
		if !isValidNewInstallment(installment, tx.uid) {
			return fmt.Errorf("invalid loan installment insert")
		}

		inserted, err := tx.session.Insert(installment)

		if err != nil {
			return fmt.Errorf("insert loan installment: %w", err)
		}

		if inserted != 1 {
			return fmt.Errorf("loan installment was not inserted")
		}
	}

	return nil
}

// UpdateActionStatus 使用 uid+action_id+expected_status 条件推进 action。
func (tx *RepositoryTransaction) UpdateActionStatus(actionId int64, expectedStatus ActionStatus, next *Action) (bool, error) {
	if err := tx.validate(); err != nil || actionId < 1 || next == nil || next.Uid != tx.uid || next.ActionId != actionId ||
		!isActionStatus(expectedStatus) || !isActionStatus(next.Status) || next.UpdatedUnixTime < 1 {
		return false, fmt.Errorf("invalid loan action conditional update")
	}

	updated, err := tx.session.Where("uid=? AND action_id=? AND status=?", tx.uid, actionId, expectedStatus).
		Cols(
			"applied_contract_version", "status", "reason_codes_json", "error_code",
			"started_unix_time", "completed_unix_time", "failed_unix_time", "updated_unix_time",
		).
		Update(next)

	if err != nil {
		return false, fmt.Errorf("update loan action status: %w", err)
	}

	return updated == 1, nil
}

// CreateOrFindTransactionBinding 由 uid+transaction_id 唯一约束最终裁决正式交易并发归属。
func (tx *RepositoryTransaction) CreateOrFindTransactionBinding(candidate *TransactionBinding) (*TransactionBinding, bool, error) {
	if err := tx.validate(); err != nil || !isValidNewBinding(candidate, tx.uid) {
		return nil, false, fmt.Errorf("invalid loan transaction binding insert")
	}

	statement := `INSERT INTO pf_loan_transaction_binding (
		uid, transaction_id, current_allocation_id, version,
		created_unix_time, updated_unix_time, binding_id
	) VALUES (?, ?, ?, ?, ?, ?, ?)`

	switch tx.database.DatabaseType() {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, transaction_id) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported loan transaction binding database type")
	}

	result, execErr := tx.session.Exec(statement,
		candidate.Uid, candidate.TransactionId, candidate.CurrentAllocationId, candidate.Version,
		candidate.CreatedUnixTime, candidate.UpdatedUnixTime, candidate.BindingId,
	)

	if execErr != nil && (tx.database.DatabaseType() != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert loan transaction binding: %w", execErr)
	}

	if execErr == nil {
		affected, affectedErr := result.RowsAffected()

		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read loan transaction binding insert result")
		}

		if affected == 1 {
			return cloneTransactionBinding(candidate), true, nil
		}
	}

	persisted, findErr := findTransactionBindingByTransactionId(tx.session, tx.uid, candidate.TransactionId)

	if findErr != nil {
		return nil, false, findErr
	}

	if persisted == nil {
		if execErr != nil {
			return nil, false, fmt.Errorf("insert loan transaction binding: %w", execErr)
		}

		return nil, false, fmt.Errorf("loan transaction binding is missing after unique conflict")
	}

	return persisted, false, nil
}

// UpdateTransactionBindingCAS 同时校验 version 和当前 allocation 指针后推进 binding。
func (tx *RepositoryTransaction) UpdateTransactionBindingCAS(bindingId int64, expectedVersion int64, expectedAllocationId *int64, nextAllocationId *int64, updatedUnixTime int64) (bool, error) {
	if err := tx.validate(); err != nil || bindingId < 1 || expectedVersion < 1 || updatedUnixTime < 1 ||
		!isNilOrPositive(expectedAllocationId) || !isNilOrPositive(nextAllocationId) {
		return false, fmt.Errorf("invalid loan transaction binding CAS")
	}

	query := tx.session.Where("uid=? AND binding_id=? AND version=?", tx.uid, bindingId, expectedVersion)

	if expectedAllocationId == nil {
		query = query.And("current_allocation_id IS NULL")
	} else {
		query = query.And("current_allocation_id=?", *expectedAllocationId)
	}

	updated, err := query.Cols("current_allocation_id", "version", "updated_unix_time").Update(&TransactionBinding{
		CurrentAllocationId: nextAllocationId,
		Version:             expectedVersion + 1,
		UpdatedUnixTime:     updatedUnixTime,
	})

	if err != nil {
		return false, fmt.Errorf("update loan transaction binding CAS: %w", err)
	}

	return updated == 1, nil
}

// InsertAllocation 在当前隐私事务中追加正式交易分配。
func (tx *RepositoryTransaction) InsertAllocation(allocation *TransactionAllocation) error {
	if err := tx.validate(); err != nil || !isValidNewAllocation(allocation, tx.uid) {
		return fmt.Errorf("invalid loan allocation insert")
	}

	inserted, err := tx.session.Insert(allocation)

	if err != nil {
		return fmt.Errorf("insert loan allocation: %w", err)
	}

	if inserted != 1 {
		return fmt.Errorf("loan allocation was not inserted")
	}

	return nil
}

// UpdateAllocationStatus 使用 uid+allocation_id+status 条件推进历史分配状态。
func (tx *RepositoryTransaction) UpdateAllocationStatus(allocationId int64, expectedStatus AllocationStatus, nextStatus AllocationStatus, lastActionId int64, updatedUnixTime int64) (bool, error) {
	if err := tx.validate(); err != nil || allocationId < 1 || !isAllocationStatus(expectedStatus) ||
		!isAllocationStatus(nextStatus) || lastActionId < 1 || updatedUnixTime < 1 {
		return false, fmt.Errorf("invalid loan allocation conditional update")
	}

	updated, err := tx.session.Where("uid=? AND allocation_id=? AND status=?", tx.uid, allocationId, expectedStatus).
		Cols("status", "last_action_id", "updated_unix_time").
		Update(&TransactionAllocation{Status: nextStatus, LastActionId: lastActionId, UpdatedUnixTime: updatedUnixTime})

	if err != nil {
		return false, fmt.Errorf("update loan allocation status: %w", err)
	}

	return updated == 1, nil
}

func (tx *RepositoryTransaction) validate() error {
	if tx == nil || tx.uid < 1 || tx.database == nil || tx.session == nil {
		return fmt.Errorf("invalid loan repository transaction")
	}

	return tx.database.ValidateTransactionSession(tx.session)
}

func isValidNewContract(value *Contract, uid int64) bool {
	return value != nil && value.Uid == uid && value.ContractId > 0 && value.LiabilityAccountId > 0 &&
		value.Version > 0 && value.CurrentRevisionId > 0 && value.CreatedUnixTime > 0 && value.UpdatedUnixTime > 0 &&
		isContractType(value.ContractType) && isContractStatus(value.Status) && isCloseReason(value.CloseReasonCode) &&
		len(value.Name) > 0 && len(value.Name) <= 128 && len(value.LenderName) <= 128 && len(value.Currency) == 3 && len(value.Note) <= 255 &&
		isNilOrPositive(value.DefaultPaymentAccountId) && isNilOrPositive(value.ClosedUnixTime)
}

func isValidNewRevision(value *ContractRevision, uid int64) bool {
	return value != nil && value.Uid == uid && value.ContractId > 0 && value.RevisionId > 0 && value.RevisionNumber > 0 && value.ActionId > 0 &&
		value.CreatedUnixTime > 0 && value.TermCount > 0 && value.FrequencyInterval > 0 && value.PrincipalAmount > 0 &&
		value.ActualDisbursementAmount > 0 && isLowerHexSHA256(value.ScheduleDigest) && isCivilDate(value.EffectiveDate) &&
		isCivilDate(value.ContractDate) && isCivilDate(value.FirstDueDate) && isFundingType(value.FundingType) &&
		isInputMode(value.InputMode) && isRepaymentMethod(value.RepaymentMethod) &&
		isValidRevisionRateQuote(value.InputMode, value.RateQuoteType, value.QuotedRatePptr, value.PaymentBasisAmount) &&
		value.FrequencyType == FREQUENCY_TYPE_MONTHLY && isDiscountType(value.DiscountType) && isIRRStatus(value.IrrStatus) &&
		value.CalculationVersion != "" && value.RoundingVersion != "" && value.IrrVersion != "" &&
		isNilOrPositive(value.PreviousRevisionId)
}

func isValidRevisionRateQuote(inputMode InputMode, rateQuoteType RateQuoteType, quotedRate *int64, paymentBasis *int64) bool {
	if inputMode == INPUT_MODE_REPAYMENT {
		return rateQuoteType == "" && quotedRate == nil && paymentBasis != nil
	}

	return inputMode == INPUT_MODE_RATE && isRateQuoteType(rateQuoteType) && quotedRate != nil && paymentBasis == nil
}

func isValidNewInstallment(value *Installment, uid int64) bool {
	return value != nil && value.Uid == uid && value.ContractId > 0 && value.RevisionId > 0 && value.InstallmentId > 0 &&
		value.InstallmentNumber > 0 && value.CreatedUnixTime > 0 && isCivilDate(value.DueDate)
}

func validateNewAction(value *Action) error {
	if value == nil || value.Uid < 1 || value.ContractId < 1 || value.ActionId < 1 || value.ExpectedContractVersion < 0 ||
		value.AppliedContractVersion != 0 || !isActionType(value.ActionType) || value.Status != ACTION_STATUS_READY ||
		!isLowerHexSHA256(value.IdempotencyKeyDigest) || !isLowerHexSHA256(value.RequestDigest) ||
		value.IdempotencyKeyVersion == "" || value.RequestDigestVersion == "" || value.ReasonCodesJson != "[]" ||
		value.ErrorCode != "" || value.CreatedUnixTime < 1 || value.UpdatedUnixTime != value.CreatedUnixTime ||
		value.StartedUnixTime != nil || value.CompletedUnixTime != nil || value.FailedUnixTime != nil ||
		!isNilOrPositive(value.PreviousActionId) {
		return fmt.Errorf("invalid new loan action")
	}

	return nil
}

func isValidNewBinding(value *TransactionBinding, uid int64) bool {
	return value != nil && value.Uid == uid && value.BindingId > 0 && value.TransactionId > 0 &&
		value.CurrentAllocationId == nil && value.Version == 1 && value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime
}

func isValidNewAllocation(value *TransactionAllocation, uid int64) bool {
	if value == nil || value.Uid != uid || value.ContractId < 1 || value.AllocationId < 1 || value.PrimaryBindingId < 1 ||
		value.AllocatedAmount <= 0 || value.TransactionUpdatedUnixTime < 1 || value.CreatedActionId < 1 ||
		value.LastActionId != value.CreatedActionId || value.CreatedUnixTime < 1 || value.UpdatedUnixTime != value.CreatedUnixTime ||
		!isComponentType(value.ComponentType) || !isAllocationCreationMethod(value.CreationMethod) ||
		value.Status != ALLOCATION_STATUS_ACTIVE || !isNilOrPositive(value.CounterpartBindingId) || !isNilOrPositive(value.CounterpartUpdatedUnixTime) {
		return false
	}

	if value.ComponentType == COMPONENT_TYPE_DISBURSEMENT {
		return value.InstallmentId == nil
	}
	if value.ComponentType == COMPONENT_TYPE_FEE {
		return value.InstallmentId == nil || *value.InstallmentId > 0
	}

	return value.InstallmentId != nil && *value.InstallmentId > 0
}

func isValidPageLimit(limit int) bool {
	return limit > 0 && limit <= maximumRepositoryPageSize
}

func isValidContractCursor(cursor *ContractCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.ContractId > 0)
}

func isValidInstallmentCursor(cursor *InstallmentCursor) bool {
	return cursor == nil || (cursor.InstallmentNumber > 0 && cursor.InstallmentId > 0)
}

func isValidAllocationCursor(cursor *AllocationCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.AllocationId > 0)
}

func isNilOrPositive(value *int64) bool {
	return value == nil || *value > 0
}

func isLowerHexSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}

	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}

	return true
}

func isCivilDate(value string) bool {
	if len(value) != len("2006-01-02") {
		return false
	}

	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func isMySQLDuplicateEntryError(err error) bool {
	var mysqlError *mysqlDriver.MySQLError

	return errors.As(err, &mysqlError) && mysqlError.Number == 1062
}

func isRetryablePersistenceError(databaseType string, err error) bool {
	switch databaseType {
	case settings.Sqlite3DbType:
		var sqliteError sqlite3.Error

		return errors.As(err, &sqliteError) && (sqliteError.Code == sqlite3.ErrBusy || sqliteError.Code == sqlite3.ErrLocked)
	case settings.MySqlDbType:
		var mysqlError *mysqlDriver.MySQLError

		return errors.As(err, &mysqlError) && (mysqlError.Number == 1205 || mysqlError.Number == 1213)
	case settings.PostgresDbType:
		var postgresError *pq.Error

		return errors.As(err, &postgresError) && (postgresError.Code == "40001" || postgresError.Code == "40P01")
	default:
		return false
	}
}

func waitPersistenceRetry(c core.Context, delay time.Duration) error {
	if c == nil {
		time.Sleep(delay)
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-c.Done():
		return c.Err()
	}
}

func cloneAction(value *Action) *Action {
	if value == nil {
		return nil
	}

	cloned := *value
	cloned.PreviousActionId = cloneInt64(value.PreviousActionId)
	cloned.StartedUnixTime = cloneInt64(value.StartedUnixTime)
	cloned.CompletedUnixTime = cloneInt64(value.CompletedUnixTime)
	cloned.FailedUnixTime = cloneInt64(value.FailedUnixTime)
	return &cloned
}

func cloneTransactionBinding(value *TransactionBinding) *TransactionBinding {
	if value == nil {
		return nil
	}

	cloned := *value
	cloned.CurrentAllocationId = cloneInt64(value.CurrentAllocationId)
	return &cloned
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}
