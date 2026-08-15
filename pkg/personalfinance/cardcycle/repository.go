package cardcycle

import (
	"fmt"
	"time"
	"unicode/utf8"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

const (
	maximumRepositoryPageSize = 100
	maximumReasonCodeRunes    = 64
)

// Repository 只访问当前 uid 所在 UserDataStore 分片。
type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 是信用卡周期仓储的受限隐私事务句柄。
type RepositoryTransaction struct {
	uid      int64
	database *datastore.Database
	session  *xorm.Session
}

// NewRepository 创建信用卡周期持久层入口。
func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("card cycle repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("card cycle repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

// DoTransaction 在 uid 所在分片执行单一事务，并强制关闭 SQL 参数日志。
func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("card cycle repository transaction callback is required")
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
		return fmt.Errorf("invalid card cycle repository transaction")
	}

	return tx.database.ValidateTransactionSession(tx.session)
}

// InsertRule 追加一条常规账单规则 revision，不改写旧行。
func (tx *RepositoryTransaction) InsertRule(rule *CycleRule) error {
	if err := tx.validate(); err != nil || !isValidNewRule(rule, tx.uid) {
		return fmt.Errorf("invalid card cycle rule insert")
	}

	inserted, err := tx.session.Insert(rule)
	if err != nil {
		return fmt.Errorf("insert card cycle rule: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("card cycle rule was not inserted")
	}

	return nil
}

// ListRules 按规则号返回某正式账户的全部账单规则 revision。
func (r *Repository) ListRules(c core.Context, uid int64, ledgerAccountId int64) ([]*CycleRule, error) {
	if uid < 1 || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid card cycle rule list")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listRules(sess, uid, ledgerAccountId)
}

func (tx *RepositoryTransaction) ListRules(ledgerAccountId int64) ([]*CycleRule, error) {
	if err := tx.validate(); err != nil || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid card cycle rule transaction list")
	}

	return listRules(tx.session, tx.uid, ledgerAccountId)
}

func listRules(sess *xorm.Session, uid int64, ledgerAccountId int64) ([]*CycleRule, error) {
	rules := make([]*CycleRule, 0)
	if err := sess.Where("uid=? AND ledger_account_id=?", uid, ledgerAccountId).Asc("rule_number", "rule_id").Find(&rules); err != nil {
		return nil, fmt.Errorf("list card cycle rules: %w", err)
	}

	return rules, nil
}

// UpdateRuleStatus 只更新规则 revision 的状态，不改写账单日、到期日或生效日。
func (tx *RepositoryTransaction) UpdateRuleStatus(ruleId int64, status RuleStatus) (bool, error) {
	if err := tx.validate(); err != nil || ruleId < 1 || !isRuleStatus(status) {
		return false, fmt.Errorf("invalid card cycle rule status update")
	}

	updated, err := tx.session.Where("uid=? AND rule_id=?", tx.uid, ruleId).Cols("status").Update(&CycleRule{Status: status})
	if err != nil {
		return false, fmt.Errorf("update card cycle rule status: %w", err)
	}

	return updated == 1, nil
}

// InsertCoverage 保存一份账单的实际覆盖区间。
func (tx *RepositoryTransaction) InsertCoverage(coverage *StatementCoverage) error {
	if err := tx.validate(); err != nil || !isValidNewCoverage(coverage, tx.uid) {
		return fmt.Errorf("invalid card statement coverage insert")
	}

	inserted, err := tx.session.Insert(coverage)
	if err != nil {
		return fmt.Errorf("insert card statement coverage: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("card statement coverage was not inserted")
	}

	return nil
}

// FindCoverageByBatch 按 uid 和批次查询实际覆盖，不存在时返回 (nil, nil)。
func (r *Repository) FindCoverageByBatch(c core.Context, uid int64, batchId int64) (*StatementCoverage, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid card statement coverage lookup")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findCoverageByBatch(sess, uid, batchId)
}

func (tx *RepositoryTransaction) FindCoverageByBatch(batchId int64) (*StatementCoverage, error) {
	if err := tx.validate(); err != nil || batchId < 1 {
		return nil, fmt.Errorf("invalid card statement coverage transaction lookup")
	}

	return findCoverageByBatch(tx.session, tx.uid, batchId)
}

func findCoverageByBatch(sess *xorm.Session, uid int64, batchId int64) (*StatementCoverage, error) {
	coverage := new(StatementCoverage)
	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(coverage)
	if err != nil {
		return nil, fmt.Errorf("find card statement coverage: %w", err)
	}
	if !found {
		return nil, nil
	}

	return coverage, nil
}

// ListCoverages 按账期结束日返回某正式账户的全部实际覆盖区间。
func (r *Repository) ListCoverages(c core.Context, uid int64, ledgerAccountId int64) ([]*StatementCoverage, error) {
	if uid < 1 || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid card statement coverage list")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listCoverages(sess, uid, ledgerAccountId)
}

func (tx *RepositoryTransaction) ListCoverages(ledgerAccountId int64) ([]*StatementCoverage, error) {
	if err := tx.validate(); err != nil || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid card statement coverage transaction list")
	}

	return listCoverages(tx.session, tx.uid, ledgerAccountId)
}

func listCoverages(sess *xorm.Session, uid int64, ledgerAccountId int64) ([]*StatementCoverage, error) {
	coverages := make([]*StatementCoverage, 0)
	if err := sess.Where("uid=? AND ledger_account_id=?", uid, ledgerAccountId).Asc("period_end", "coverage_id").Find(&coverages); err != nil {
		return nil, fmt.Errorf("list card statement coverages: %w", err)
	}

	return coverages, nil
}

// InsertMonthRevision 追加一条历史自然月修订审计。
func (tx *RepositoryTransaction) InsertMonthRevision(revision *MonthReportRevision) error {
	if err := tx.validate(); err != nil || !isValidNewMonthRevision(revision, tx.uid) {
		return fmt.Errorf("invalid month report revision insert")
	}

	inserted, err := tx.session.Insert(revision)
	if err != nil {
		return fmt.Errorf("insert month report revision: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("month report revision was not inserted")
	}

	return nil
}

// ListMonthRevisions 按创建时间返回某自然月的修订审计。
func (r *Repository) ListMonthRevisions(c core.Context, uid int64, yearMonth string, limit int) ([]*MonthReportRevision, error) {
	if uid < 1 || !isYearMonth(yearMonth) || !isValidPageLimit(limit) {
		return nil, fmt.Errorf("invalid month report revision list")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	revisions := make([]*MonthReportRevision, 0, limit)
	if err := sess.Where("uid=? AND year_month=?", uid, yearMonth).Desc("created_unix_time", "revision_id").Limit(limit).Find(&revisions); err != nil {
		return nil, fmt.Errorf("list month report revisions: %w", err)
	}

	return revisions, nil
}

// FindBalanceReviewByAccount 按 uid 和正式账户查询余额核对状态。
func (r *Repository) FindBalanceReviewByAccount(c core.Context, uid int64, ledgerAccountId int64) (*BalanceReview, error) {
	if uid < 1 || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid balance review lookup")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findBalanceReviewByAccount(sess, uid, ledgerAccountId)
}

func (tx *RepositoryTransaction) FindBalanceReviewByAccount(ledgerAccountId int64) (*BalanceReview, error) {
	if err := tx.validate(); err != nil || ledgerAccountId < 1 {
		return nil, fmt.Errorf("invalid balance review transaction lookup")
	}

	return findBalanceReviewByAccount(tx.session, tx.uid, ledgerAccountId)
}

func findBalanceReviewByAccount(sess *xorm.Session, uid int64, ledgerAccountId int64) (*BalanceReview, error) {
	review := new(BalanceReview)
	found, err := sess.Where("uid=? AND ledger_account_id=?", uid, ledgerAccountId).Get(review)
	if err != nil {
		return nil, fmt.Errorf("find account balance review: %w", err)
	}
	if !found {
		return nil, nil
	}

	return review, nil
}

// InsertBalanceReview 写入某正式账户的首次余额核对状态。
func (tx *RepositoryTransaction) InsertBalanceReview(review *BalanceReview) error {
	if err := tx.validate(); err != nil || !isValidNewBalanceReview(review, tx.uid) {
		return fmt.Errorf("invalid account balance review insert")
	}

	inserted, err := tx.session.Insert(review)
	if err != nil {
		return fmt.Errorf("insert account balance review: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("account balance review was not inserted")
	}

	return nil
}

// UpdateBalanceReviewCAS 使用 uid+review_id+version 条件更新核对状态。
func (tx *RepositoryTransaction) UpdateBalanceReviewCAS(expectedVersion int64, next *BalanceReview) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.ReviewId < 1 ||
		next.LedgerAccountId < 1 || expectedVersion < 1 || next.Version != expectedVersion+1 ||
		!isValidBalanceReviewState(next.Status, next.AsOfDate) || next.UpdatedUnixTime < 1 {
		return false, fmt.Errorf("invalid account balance review CAS")
	}

	updated, err := tx.session.Where("uid=? AND review_id=? AND version=?", tx.uid, next.ReviewId, expectedVersion).
		Cols("status", "as_of_date", "version", "updated_unix_time").
		Update(next)
	if err != nil {
		return false, fmt.Errorf("update account balance review CAS: %w", err)
	}

	return updated == 1, nil
}

func isValidNewRule(value *CycleRule, uid int64) bool {
	return value != nil && value.Uid == uid && value.RuleId > 0 && value.LedgerAccountId > 0 &&
		value.RuleNumber > 0 && isCardCycleDay(value.StatementDay) && isCardCycleDay(value.DueDay) &&
		isCivilDate(value.EffectiveFrom) && isRuleStatus(value.Status) && value.CreatedUnixTime > 0
}

func isValidNewCoverage(value *StatementCoverage, uid int64) bool {
	if value == nil || value.Uid != uid || value.CoverageId < 1 || value.LedgerAccountId < 1 ||
		value.BatchId < 1 || !isCivilDate(value.PeriodStart) || !isCivilDate(value.PeriodEnd) ||
		!isEmptyOrCivilDate(value.StatementDate) || !isEmptyOrCivilDate(value.DueDate) ||
		value.CreatedUnixTime < 1 || value.PeriodEnd < value.PeriodStart {
		return false
	}

	return true
}

func isValidNewMonthRevision(value *MonthReportRevision, uid int64) bool {
	reasonRunes := 0
	if value != nil {
		reasonRunes = utf8.RuneCountInString(value.ReasonCode)
	}

	return value != nil && value.Uid == uid && value.RevisionId > 0 && isYearMonth(value.YearMonth) &&
		value.TaskId > 0 && reasonRunes > 0 && reasonRunes <= maximumReasonCodeRunes && value.CreatedUnixTime > 0
}

func isValidNewBalanceReview(value *BalanceReview, uid int64) bool {
	return value != nil && value.Uid == uid && value.ReviewId > 0 && value.LedgerAccountId > 0 &&
		value.Version == 1 && value.UpdatedUnixTime > 0 && isValidBalanceReviewState(value.Status, value.AsOfDate)
}

func isValidBalanceReviewState(status BalanceReviewStatus, asOfDate string) bool {
	switch status {
	case BALANCE_REVIEW_UNVERIFIED:
		return asOfDate == emptyCivilDate
	case BALANCE_REVIEW_VERIFIED:
		return isCivilDate(asOfDate)
	default:
		return false
	}
}

func isValidPageLimit(limit int) bool {
	return limit > 0 && limit <= maximumRepositoryPageSize
}

func isEmptyOrCivilDate(value string) bool {
	return value == emptyCivilDate || isCivilDate(value)
}

func isCivilDate(value string) bool {
	if len(value) != len("2006-01-02") {
		return false
	}

	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func isYearMonth(value string) bool {
	if len(value) != len("2006-01") {
		return false
	}

	parsed, err := time.Parse("2006-01", value)
	return err == nil && parsed.Format("2006-01") == value
}
