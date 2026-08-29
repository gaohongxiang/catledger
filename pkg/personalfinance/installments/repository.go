package installments

import (
	"errors"
	"fmt"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/lib/pq"
	"github.com/mattn/go-sqlite3"
	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

const (
	maximumRepositoryPageSize            = 100
	maximumCandidatePersistenceAttempts  = 8
	initialCandidatePersistenceRetryWait = 5 * time.Millisecond
)

// CandidateCursor 是候选列表按更新时间和候选 ID 倒序分页的稳定游标。
type CandidateCursor struct {
	UpdatedUnixTime int64
	CandidateId     int64
}

// CandidatePage 保存一页分期候选。
type CandidatePage struct {
	Items      []*Candidate
	NextCursor *CandidateCursor
}

// Repository 只访问当前 uid 所在 UserDataStore 分片。
type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 是分期候选仓储的受限隐私事务句柄。
type RepositoryTransaction struct {
	uid      int64
	database *datastore.Database
	session  *xorm.Session
}

// NewRepository 创建分期候选持久层入口。
func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("installment repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("installment repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

// DoTransaction 在 uid 所在分片执行单一事务，并强制关闭 SQL 参数日志。
func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("installment repository transaction callback is required")
	}

	database, err := r.database(uid)
	if err != nil {
		return err
	}

	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		return fn(&RepositoryTransaction{uid: uid, database: database, session: sess})
	})
}

func (tx *RepositoryTransaction) validate() error {
	if tx == nil || tx.uid < 1 || tx.database == nil || tx.session == nil {
		return fmt.Errorf("invalid installment repository transaction")
	}

	return tx.database.ValidateTransactionSession(tx.session)
}

// FindCandidateById 按 uid 和候选 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindCandidateById(c core.Context, uid int64, candidateId int64) (*Candidate, error) {
	if uid < 1 || candidateId < 1 {
		return nil, fmt.Errorf("invalid installment candidate owner or id")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findCandidateById(sess, uid, candidateId)
}

// FindCandidatesByRawRowIds 返回与指定不可变原始行存在显式成员关系的候选。
func (r *Repository) FindCandidatesByRawRowIds(c core.Context, uid int64, rowIds []int64) ([]*Candidate, error) {
	if uid < 1 || len(rowIds) < 1 {
		return nil, fmt.Errorf("invalid installment candidate raw row lookup")
	}
	unique := make([]int64, 0, len(rowIds))
	seenRows := make(map[int64]struct{}, len(rowIds))
	for _, rowId := range rowIds {
		if rowId < 1 {
			return nil, fmt.Errorf("invalid installment candidate raw row lookup")
		}
		if _, exists := seenRows[rowId]; exists {
			continue
		}
		seenRows[rowId] = struct{}{}
		unique = append(unique, rowId)
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	members := make([]*CandidateMember, 0)
	if err = sess.Where("uid=? AND member_kind=?", uid, MEMBER_KIND_RAW_ROW).In("member_ref_id", unique).Find(&members); err != nil {
		return nil, fmt.Errorf("find installment candidates by raw rows: %w", err)
	}
	candidateIds := make([]int64, 0, len(members))
	seenCandidates := make(map[int64]struct{}, len(members))
	for _, member := range members {
		if _, exists := seenCandidates[member.CandidateId]; exists {
			continue
		}
		seenCandidates[member.CandidateId] = struct{}{}
		candidateIds = append(candidateIds, member.CandidateId)
	}
	if len(candidateIds) < 1 {
		return []*Candidate{}, nil
	}
	candidates := make([]*Candidate, 0, len(candidateIds))
	if err = sess.Where("uid=?", uid).In("candidate_id", candidateIds).Asc("candidate_id").Find(&candidates); err != nil {
		return nil, fmt.Errorf("load installment candidates by raw rows: %w", err)
	}
	return candidates, nil
}

func (tx *RepositoryTransaction) FindCandidateById(candidateId int64) (*Candidate, error) {
	if err := tx.validate(); err != nil || candidateId < 1 {
		return nil, fmt.Errorf("invalid installment candidate transaction lookup")
	}

	return findCandidateById(tx.session, tx.uid, candidateId)
}

// FindContractDraft 返回候选对应的暂存合同；不存在时返回 (nil, nil)。
func (r *Repository) FindContractDraft(c core.Context, uid int64, candidateId int64) (*ContractDraft, error) {
	if uid < 1 || candidateId < 1 {
		return nil, fmt.Errorf("invalid installment contract draft lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	draft := new(ContractDraft)
	found, err := sess.Where("uid=? AND candidate_id=?", uid, candidateId).Get(draft)
	if err != nil {
		return nil, fmt.Errorf("find installment contract draft: %w", err)
	}
	if !found {
		return nil, nil
	}
	return draft, nil
}

// DeleteContractDraft 删除已经投影为正式合同的暂存数据；重复调用安全。
func (r *Repository) DeleteContractDraft(c core.Context, uid int64, candidateId int64) error {
	if uid < 1 || candidateId < 1 {
		return fmt.Errorf("invalid installment contract draft delete")
	}
	database, err := r.database(uid)
	if err != nil {
		return err
	}
	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		if _, deleteErr := sess.Where("uid=? AND candidate_id=?", uid, candidateId).Delete(new(ContractDraft)); deleteErr != nil {
			return fmt.Errorf("delete installment contract draft: %w", deleteErr)
		}
		return nil
	})
}

// DeleteContractDrafts 删除一组尚未生效的合同草稿；重复调用安全。
func (r *Repository) DeleteContractDrafts(c core.Context, uid int64, candidateIds []int64) error {
	if uid < 1 || len(candidateIds) < 1 {
		return fmt.Errorf("invalid installment contract drafts delete")
	}
	database, err := r.database(uid)
	if err != nil {
		return err
	}
	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		if _, deleteErr := sess.Where("uid=?", uid).In("candidate_id", candidateIds).Delete(new(ContractDraft)); deleteErr != nil {
			return fmt.Errorf("delete installment contract drafts: %w", deleteErr)
		}
		return nil
	})
}

// SaveContractDraft 在候选事务内创建或替换合同草稿。
func (tx *RepositoryTransaction) SaveContractDraft(draft *ContractDraft) error {
	if err := tx.validate(); err != nil || draft == nil || draft.Uid != tx.uid || draft.CandidateId < 1 ||
		draft.Version < 1 || draft.ContractSpecJson == "" || draft.CreatedUnixTime < 1 || draft.UpdatedUnixTime < draft.CreatedUnixTime || draft.DraftId < 1 {
		return fmt.Errorf("invalid installment contract draft")
	}
	existing := new(ContractDraft)
	found, err := tx.session.Where("uid=? AND candidate_id=?", tx.uid, draft.CandidateId).Get(existing)
	if err != nil {
		return fmt.Errorf("find installment contract draft for save: %w", err)
	}
	if !found {
		inserted, insertErr := tx.session.Insert(draft)
		if insertErr != nil || inserted != 1 {
			return fmt.Errorf("insert installment contract draft: %w", insertErr)
		}
		return nil
	}
	draft.DraftId = existing.DraftId
	draft.CreatedUnixTime = existing.CreatedUnixTime
	draft.Version = existing.Version + 1
	updated, err := tx.session.Where("uid=? AND candidate_id=? AND version=?", tx.uid, draft.CandidateId, existing.Version).
		Cols("version", "contract_spec_json", "updated_unix_time").Update(draft)
	if err != nil {
		return fmt.Errorf("update installment contract draft: %w", err)
	}
	if updated != 1 {
		return fmt.Errorf("installment contract draft version conflict")
	}
	return nil
}

func findCandidateById(sess *xorm.Session, uid int64, candidateId int64) (*Candidate, error) {
	candidate := new(Candidate)
	found, err := sess.Where("uid=? AND candidate_id=?", uid, candidateId).Get(candidate)
	if err != nil {
		return nil, fmt.Errorf("find installment candidate: %w", err)
	}
	if !found {
		return nil, nil
	}

	return candidate, nil
}

// ListCandidates 按 status、更新时间和候选 ID 倒序稳定分页。
func (r *Repository) ListCandidates(c core.Context, uid int64, status CandidateStatus, cursor *CandidateCursor, limit int) (*CandidatePage, error) {
	if uid < 1 || !isCandidateStatus(status) || !isValidPageLimit(limit) || !isValidCandidateCursor(cursor) {
		return nil, fmt.Errorf("invalid installment candidate page")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	candidates := make([]*Candidate, 0, limit+1)
	query := sess.Where("uid=? AND status=?", uid, status)
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND candidate_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.CandidateId)
	}
	if err := query.Desc("updated_unix_time", "candidate_id").Limit(limit + 1).Find(&candidates); err != nil {
		return nil, fmt.Errorf("list installment candidates: %w", err)
	}

	page := &CandidatePage{Items: candidates}
	if len(candidates) > limit {
		page.Items = candidates[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &CandidateCursor{UpdatedUnixTime: last.UpdatedUnixTime, CandidateId: last.CandidateId}
	}

	return page, nil
}

// CreateOrFindCandidate 由 uid+candidate_key 唯一约束裁决并发候选。
func (r *Repository) CreateOrFindCandidate(c core.Context, candidate *Candidate) (*Candidate, bool, error) {
	if err := validateNewCandidate(candidate); err != nil {
		return nil, false, err
	}

	database, err := r.database(candidate.Uid)
	if err != nil {
		return nil, false, err
	}

	for attempt := 0; attempt < maximumCandidatePersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		persisted, created, persistErr := createOrFindCandidate(sess, database.DatabaseType(), candidate)
		sess.Close()
		if persistErr == nil {
			return persisted, created, nil
		}
		if attempt+1 == maximumCandidatePersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), persistErr) {
			return nil, false, persistErr
		}
		if waitErr := waitPersistenceRetry(c, initialCandidatePersistenceRetryWait<<attempt); waitErr != nil {
			return nil, false, waitErr
		}
	}

	return nil, false, fmt.Errorf("installment candidate persistence retry limit reached")
}

func (tx *RepositoryTransaction) CreateOrFindCandidate(candidate *Candidate) (*Candidate, bool, error) {
	if err := tx.validate(); err != nil || candidate == nil || candidate.Uid != tx.uid {
		return nil, false, fmt.Errorf("invalid installment candidate transaction insert")
	}
	if err := validateNewCandidate(candidate); err != nil {
		return nil, false, err
	}

	return createOrFindCandidate(tx.session, tx.database.DatabaseType(), candidate)
}

func createOrFindCandidate(sess *xorm.Session, databaseType string, candidate *Candidate) (*Candidate, bool, error) {
	statement := `INSERT INTO pf_installment_candidate (
		uid, candidate_key, candidate_key_version, status, version,
		liability_account_id, term_count, linked_contract_id, purchase_relation,
		linked_purchase_transaction_id, principal_amount, payment_amount,
		interest_amount, fee_amount, repayment_method, first_due_date,
		current_period, created_unix_time, updated_unix_time, candidate_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch databaseType {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, candidate_key) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported installment candidate database type")
	}

	result, execErr := sess.Exec(statement,
		candidate.Uid, candidate.CandidateKey, candidate.CandidateKeyVersion, candidate.Status, candidate.Version,
		candidate.LiabilityAccountId, candidate.TermCount, candidate.LinkedContractId, candidate.PurchaseRelation,
		candidate.LinkedPurchaseTransactionId, candidate.PrincipalAmount, candidate.PaymentAmount,
		candidate.InterestAmount, candidate.FeeAmount, candidate.RepaymentMethod, candidate.FirstDueDate,
		candidate.CurrentPeriod, candidate.CreatedUnixTime, candidate.UpdatedUnixTime, candidate.CandidateId,
	)
	if execErr != nil && (databaseType != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert installment candidate: %w", execErr)
	}

	if execErr == nil {
		affected, affectedErr := result.RowsAffected()
		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read installment candidate insert result")
		}
		if affected == 1 {
			return cloneCandidate(candidate), true, nil
		}
	}

	persisted := new(Candidate)
	found, err := sess.Where("uid=? AND candidate_key=?", candidate.Uid, candidate.CandidateKey).Get(persisted)
	if err != nil {
		return nil, false, fmt.Errorf("find installment candidate after insert: %w", err)
	}
	if !found {
		if execErr != nil {
			return nil, false, fmt.Errorf("insert installment candidate: %w", execErr)
		}
		return nil, false, fmt.Errorf("installment candidate is missing after unique conflict")
	}
	if persisted.CandidateKeyVersion != candidate.CandidateKeyVersion {
		return nil, false, fmt.Errorf("installment candidate key version is incompatible")
	}

	return persisted, false, nil
}

// UpdateCandidateCAS 使用 uid+candidate_id+version 条件更新可变候选字段。
func (tx *RepositoryTransaction) UpdateCandidateCAS(expectedVersion int64, next *Candidate) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.CandidateId < 1 ||
		expectedVersion < 1 || next.Version != expectedVersion+1 || !isMutableCandidate(next) {
		return false, fmt.Errorf("invalid installment candidate CAS")
	}

	updated, err := tx.session.Where("uid=? AND candidate_id=? AND version=?", tx.uid, next.CandidateId, expectedVersion).
		Cols(
			"status", "version", "liability_account_id", "term_count", "linked_contract_id",
			"purchase_relation", "linked_purchase_transaction_id", "principal_amount", "payment_amount",
			"interest_amount", "fee_amount", "repayment_method", "first_due_date", "current_period",
			"updated_unix_time",
		).
		MustCols(
			"liability_account_id", "term_count", "linked_contract_id", "linked_purchase_transaction_id",
			"principal_amount", "payment_amount", "interest_amount", "fee_amount", "current_period",
		).
		Update(next)
	if err != nil {
		return false, fmt.Errorf("update installment candidate CAS: %w", err)
	}

	return updated == 1, nil
}

// InsertMember 把来源身份或原始行关联到当前用户的分期候选。
func (tx *RepositoryTransaction) InsertMember(member *CandidateMember) error {
	if err := tx.validate(); err != nil || !isValidNewMember(member, tx.uid) {
		return fmt.Errorf("invalid installment candidate member insert")
	}

	inserted, err := tx.session.Insert(member)
	if err != nil {
		return fmt.Errorf("insert installment candidate member: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("installment candidate member was not inserted")
	}

	return nil
}

// ListMembers 按创建时间返回当前 uid 的候选成员。
func (r *Repository) ListMembers(c core.Context, uid int64, candidateId int64) ([]*CandidateMember, error) {
	if uid < 1 || candidateId < 1 {
		return nil, fmt.Errorf("invalid installment candidate member list")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	members := make([]*CandidateMember, 0)
	if err := sess.Where("uid=? AND candidate_id=?", uid, candidateId).Asc("created_unix_time", "member_id").Find(&members); err != nil {
		return nil, fmt.Errorf("list installment candidate members: %w", err)
	}

	return members, nil
}

func (tx *RepositoryTransaction) ListMembers(candidateId int64) ([]*CandidateMember, error) {
	if err := tx.validate(); err != nil || candidateId < 1 {
		return nil, fmt.Errorf("invalid installment candidate member transaction list")
	}

	members := make([]*CandidateMember, 0)
	if err := tx.session.Where("uid=? AND candidate_id=?", tx.uid, candidateId).Asc("created_unix_time", "member_id").Find(&members); err != nil {
		return nil, fmt.Errorf("list installment candidate members: %w", err)
	}

	return members, nil
}

func validateNewCandidate(value *Candidate) error {
	if value == nil || value.Uid < 1 || value.CandidateId < 1 || !isLowerHexSHA256(value.CandidateKey) ||
		value.CandidateKeyVersion != CANDIDATE_KEY_VERSION_V1 || value.Status != CANDIDATE_STATUS_PENDING ||
		value.Version != 1 || value.CreatedUnixTime < 1 || value.UpdatedUnixTime != value.CreatedUnixTime ||
		!isPurchaseRelation(value.PurchaseRelation) || !isRepaymentMethod(value.RepaymentMethod) ||
		!isEmptyOrCivilDate(value.FirstDueDate) || !isNilOrPositive(value.LiabilityAccountId) ||
		!isNilOrPositive(value.TermCount) || !isNilOrPositive(value.LinkedContractId) ||
		!isNilOrPositive(value.LinkedPurchaseTransactionId) || !isNilOrNonNegative(value.PrincipalAmount) ||
		!isNilOrNonNegative(value.PaymentAmount) || !isNilOrNonNegative(value.InterestAmount) ||
		!isNilOrNonNegative(value.FeeAmount) || !isNilOrPositive(value.CurrentPeriod) {
		return fmt.Errorf("invalid new installment candidate")
	}

	return nil
}

func isMutableCandidate(value *Candidate) bool {
	return value != nil && isCandidateStatus(value.Status) && isPurchaseRelation(value.PurchaseRelation) &&
		isRepaymentMethod(value.RepaymentMethod) && isEmptyOrCivilDate(value.FirstDueDate) &&
		value.UpdatedUnixTime > 0 && isNilOrPositive(value.LiabilityAccountId) &&
		isNilOrPositive(value.TermCount) && isNilOrPositive(value.LinkedContractId) &&
		isNilOrPositive(value.LinkedPurchaseTransactionId) && isNilOrNonNegative(value.PrincipalAmount) &&
		isNilOrNonNegative(value.PaymentAmount) && isNilOrNonNegative(value.InterestAmount) &&
		isNilOrNonNegative(value.FeeAmount) && isNilOrPositive(value.CurrentPeriod)
}

func isValidNewMember(value *CandidateMember, uid int64) bool {
	return value != nil && value.Uid == uid && value.MemberId > 0 && value.CandidateId > 0 &&
		isMemberKind(value.MemberKind) && value.MemberRefId > 0 && isMemberRole(value.MemberRole) &&
		isNilOrPositive(value.PeriodNumber) && value.CreatedUnixTime > 0
}

func isValidPageLimit(limit int) bool {
	return limit > 0 && limit <= maximumRepositoryPageSize
}

func isValidCandidateCursor(cursor *CandidateCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.CandidateId > 0)
}

func isNilOrPositive(value *int64) bool {
	return value == nil || *value > 0
}

func isNilOrNonNegative(value *int64) bool {
	return value == nil || *value >= 0
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

func isEmptyOrCivilDate(value string) bool {
	return value == "" || isCivilDate(value)
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

func cloneCandidate(value *Candidate) *Candidate {
	if value == nil {
		return nil
	}

	cloned := *value
	cloned.LiabilityAccountId = cloneInt64(value.LiabilityAccountId)
	cloned.TermCount = cloneInt64(value.TermCount)
	cloned.LinkedContractId = cloneInt64(value.LinkedContractId)
	cloned.LinkedPurchaseTransactionId = cloneInt64(value.LinkedPurchaseTransactionId)
	cloned.PrincipalAmount = cloneInt64(value.PrincipalAmount)
	cloned.PaymentAmount = cloneInt64(value.PaymentAmount)
	cloned.InterestAmount = cloneInt64(value.InterestAmount)
	cloned.FeeAmount = cloneInt64(value.FeeAmount)
	cloned.CurrentPeriod = cloneInt64(value.CurrentPeriod)
	return &cloned
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}
