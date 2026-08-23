package organizer

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
	maximumRepositoryPageSize       = 100
	maximumPersistenceAttempts      = 8
	initialPersistenceRetryInterval = 5 * time.Millisecond
)

var ErrActionRequestConflict = errors.New("finance action request digest conflict")

type UpdateCursor struct {
	UpdatedUnixTime int64
	UpdateId        int64
}

type UpdatePage struct {
	Items      []*FinanceUpdate
	NextCursor *UpdateCursor
}

type EventCursor struct {
	UpdatedUnixTime int64
	EventId         int64
}

type EventPage struct {
	Items      []*EconomicEvent
	NextCursor *EventCursor
}

type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 只暴露新工作流需要的隐私事务能力。
type RepositoryTransaction struct {
	uid      int64
	database *datastore.Database
	session  *xorm.Session
}

func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("organizer repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("organizer repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("organizer repository transaction callback is required")
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
		return fmt.Errorf("invalid organizer repository transaction")
	}

	return tx.database.ValidateTransactionSession(tx.session)
}

func (r *Repository) FindUpdateById(c core.Context, uid int64, updateId int64) (*FinanceUpdate, error) {
	if uid < 1 || updateId < 1 {
		return nil, fmt.Errorf("invalid finance update lookup")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findUpdateById(sess, uid, updateId)
}

func (tx *RepositoryTransaction) FindUpdateById(updateId int64) (*FinanceUpdate, error) {
	if err := tx.validate(); err != nil || updateId < 1 {
		return nil, fmt.Errorf("invalid finance update transaction lookup")
	}
	return findUpdateById(tx.session, tx.uid, updateId)
}

func findUpdateById(sess *xorm.Session, uid int64, updateId int64) (*FinanceUpdate, error) {
	value := new(FinanceUpdate)
	found, err := sess.Where("uid=? AND update_id=?", uid, updateId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find finance update: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (r *Repository) ListUpdates(c core.Context, uid int64, status UpdateStatus, cursor *UpdateCursor, limit int) (*UpdatePage, error) {
	if uid < 1 || !isUpdateStatus(status) || limit < 1 || limit > maximumRepositoryPageSize ||
		(cursor != nil && (cursor.UpdatedUnixTime < 1 || cursor.UpdateId < 1)) {
		return nil, fmt.Errorf("invalid finance update page")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*FinanceUpdate, 0, limit+1)
	query := sess.Where("uid=? AND status=?", uid, status)
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND update_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.UpdateId)
	}
	if err = query.Desc("updated_unix_time", "update_id").Limit(limit + 1).Find(&items); err != nil {
		return nil, fmt.Errorf("list finance updates: %w", err)
	}

	page := &UpdatePage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &UpdateCursor{UpdatedUnixTime: last.UpdatedUnixTime, UpdateId: last.UpdateId}
	}
	return page, nil
}

func (tx *RepositoryTransaction) InsertUpdate(value *FinanceUpdate) error {
	if err := tx.validate(); err != nil || !isValidNewUpdate(value, tx.uid) {
		return fmt.Errorf("invalid finance update insert")
	}
	return insertOne(tx.session, value, "finance update")
}

func (tx *RepositoryTransaction) UpdateUpdateCAS(expectedVersion int64, next *FinanceUpdate) (bool, error) {
	if err := tx.validate(); err != nil || !isValidUpdateCAS(next, tx.uid, expectedVersion) {
		return false, fmt.Errorf("invalid finance update CAS")
	}

	updated, err := tx.session.Where("uid=? AND update_id=? AND version=?", tx.uid, next.UpdateId, expectedVersion).
		Cols("status", "version", "plan_version", "current_action_id", "source_count", "valid_evidence_count",
			"duplicate_evidence_count", "final_event_count", "posted_event_count", "ready_event_count",
			"needs_action_event_count", "excluded_event_count", "error_code", "updated_unix_time").
		MustCols("current_action_id").Update(next)
	if err != nil {
		return false, fmt.Errorf("update finance update CAS: %w", err)
	}
	return updated == 1, nil
}

func (tx *RepositoryTransaction) InsertSource(value *FinanceUpdateSource) error {
	if err := tx.validate(); err != nil || !isValidSource(value, tx.uid) {
		return fmt.Errorf("invalid finance update source insert")
	}
	update, err := findUpdateById(tx.session, tx.uid, value.UpdateId)
	if err != nil {
		return err
	}
	if update == nil || update.Status != UPDATE_STATUS_DRAFT {
		return fmt.Errorf("finance update source membership is frozen")
	}
	return insertOne(tx.session, value, "finance update source")
}

func (r *Repository) ListSources(c core.Context, uid int64, updateId int64) ([]*FinanceUpdateSource, error) {
	if uid < 1 || updateId < 1 {
		return nil, fmt.Errorf("invalid finance update source lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listSources(sess, uid, updateId)
}

func (tx *RepositoryTransaction) ListSources(updateId int64) ([]*FinanceUpdateSource, error) {
	if err := tx.validate(); err != nil || updateId < 1 {
		return nil, fmt.Errorf("invalid finance update source transaction lookup")
	}
	return listSources(tx.session, tx.uid, updateId)
}

func (tx *RepositoryTransaction) ListSourcesByBatchIds(batchIds []int64) ([]*FinanceUpdateSource, error) {
	if err := tx.validate(); err != nil || len(batchIds) < 1 {
		return nil, fmt.Errorf("invalid finance update source batch lookup")
	}
	for _, batchId := range batchIds {
		if batchId < 1 {
			return nil, fmt.Errorf("invalid finance update source batch lookup")
		}
	}
	items := make([]*FinanceUpdateSource, 0)
	if err := tx.session.Where("uid=?", tx.uid).In("batch_id", batchIds).Asc("source_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list finance update sources by batch: %w", err)
	}
	return items, nil
}

func listSources(sess *xorm.Session, uid int64, updateId int64) ([]*FinanceUpdateSource, error) {
	items := make([]*FinanceUpdateSource, 0)
	if err := sess.Where("uid=? AND update_id=?", uid, updateId).Asc("source_order", "source_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list finance update sources: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) InsertEvent(value *EconomicEvent) error {
	if err := tx.validate(); err != nil || !isValidNewEvent(value, tx.uid) {
		return fmt.Errorf("invalid economic event insert")
	}
	return insertOne(tx.session, value, "economic event")
}

func (r *Repository) FindEventById(c core.Context, uid int64, eventId int64) (*EconomicEvent, error) {
	if uid < 1 || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findEventById(sess, uid, eventId)
}

func (tx *RepositoryTransaction) FindEventById(eventId int64) (*EconomicEvent, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event transaction lookup")
	}
	return findEventById(tx.session, tx.uid, eventId)
}

func findEventById(sess *xorm.Session, uid int64, eventId int64) (*EconomicEvent, error) {
	value := new(EconomicEvent)
	found, err := sess.Where("uid=? AND event_id=?", uid, eventId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find economic event: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (r *Repository) ListEvents(c core.Context, uid int64, updateId int64) ([]*EconomicEvent, error) {
	if uid < 1 || updateId < 1 {
		return nil, fmt.Errorf("invalid economic event list")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listEvents(sess, uid, updateId)
}

func (r *Repository) ListEventsPage(c core.Context, uid int64, updateId int64, status EventStatus, cursor *EventCursor, limit int) (*EventPage, error) {
	if uid < 1 || updateId < 1 || (status != "" && !isEventStatus(status)) || limit < 1 || limit > maximumRepositoryPageSize ||
		(cursor != nil && (cursor.UpdatedUnixTime < 1 || cursor.EventId < 1)) {
		return nil, fmt.Errorf("invalid economic event page")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*EconomicEvent, 0, limit+1)
	query := sess.Where("uid=? AND update_id=?", uid, updateId)
	if status != "" {
		query = query.And("status=?", status)
	}
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND event_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.EventId)
	}
	if err = query.Desc("updated_unix_time", "event_id").Limit(limit + 1).Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event page: %w", err)
	}
	page := &EventPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &EventCursor{UpdatedUnixTime: last.UpdatedUnixTime, EventId: last.EventId}
	}
	return page, nil
}

func (tx *RepositoryTransaction) ListEvents(updateId int64) ([]*EconomicEvent, error) {
	if err := tx.validate(); err != nil || updateId < 1 {
		return nil, fmt.Errorf("invalid economic event transaction list")
	}
	return listEvents(tx.session, tx.uid, updateId)
}

func listEvents(sess *xorm.Session, uid int64, updateId int64) ([]*EconomicEvent, error) {
	items := make([]*EconomicEvent, 0)
	if err := sess.Where("uid=? AND update_id=?", uid, updateId).Asc("event_unix_time", "event_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic events: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) UpdateEventCAS(expectedVersion int64, next *EconomicEvent) (bool, error) {
	if err := tx.validate(); err != nil || !isValidEventCAS(next, tx.uid, expectedVersion) {
		return false, fmt.Errorf("invalid economic event CAS")
	}
	updated, err := tx.session.Where("uid=? AND event_id=? AND version=?", tx.uid, next.EventId, expectedVersion).
		Cols("status", "version", "flow_direction", "economic_nature", "ledger_account_id",
			"counterparty_ledger_account_id", "event_unix_time", "timezone_utc_offset", "amount", "currency",
			"category_id", "manual_field_mask", "rule_version", "field_sources_json", "reason_codes_json", "updated_unix_time").
		MustCols("ledger_account_id", "counterparty_ledger_account_id", "event_unix_time", "timezone_utc_offset", "amount", "category_id").
		Update(next)
	if err != nil {
		return false, fmt.Errorf("update economic event CAS: %w", err)
	}
	return updated == 1, nil
}

func (tx *RepositoryTransaction) InsertEvidence(value *EconomicEventEvidence) error {
	if err := tx.validate(); err != nil || !isValidEvidence(value, tx.uid) {
		return fmt.Errorf("invalid economic event evidence insert")
	}
	return insertOne(tx.session, value, "economic event evidence")
}

func (r *Repository) ListEvidence(c core.Context, uid int64, eventId int64) ([]*EconomicEventEvidence, error) {
	if uid < 1 || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event evidence lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*EconomicEventEvidence, 0)
	if err = sess.Where("uid=? AND event_id=?", uid, eventId).Asc("evidence_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event evidence: %w", err)
	}
	return items, nil
}

// ListEvidenceForEvents 批量读取一页事件的证据关系，供列表摘要使用。
func (r *Repository) ListEvidenceForEvents(c core.Context, uid int64, eventIds []int64) ([]*EconomicEventEvidence, error) {
	if uid < 1 || len(eventIds) < 1 || len(eventIds) > maximumRepositoryPageSize {
		return nil, fmt.Errorf("invalid economic event evidence batch list")
	}
	seen := make(map[int64]struct{}, len(eventIds))
	for _, eventId := range eventIds {
		if eventId < 1 {
			return nil, fmt.Errorf("invalid economic event evidence batch list")
		}
		if _, exists := seen[eventId]; exists {
			return nil, fmt.Errorf("duplicate economic event evidence batch id")
		}
		seen[eventId] = struct{}{}
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	items := make([]*EconomicEventEvidence, 0)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	if err = sess.Where("uid=?", uid).In("event_id", eventIds).Asc("event_id", "evidence_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event evidence batch: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) InsertRelation(value *EconomicEventRelation) error {
	if err := tx.validate(); err != nil || !isValidNewRelation(value, tx.uid) {
		return fmt.Errorf("invalid economic event relation insert")
	}
	return insertOne(tx.session, value, "economic event relation")
}

func (tx *RepositoryTransaction) UpdateRelationCAS(expectedVersion int64, next *EconomicEventRelation) (bool, error) {
	if err := tx.validate(); err != nil || !isValidRelationCAS(next, tx.uid, expectedVersion) {
		return false, fmt.Errorf("invalid economic event relation CAS")
	}
	updated, err := tx.session.Where("uid=? AND relation_id=? AND version=?", tx.uid, next.RelationId, expectedVersion).
		Cols("status", "version", "amount", "currency", "manual", "rule_version", "reason_codes_json", "updated_unix_time").
		MustCols("amount").Update(next)
	if err != nil {
		return false, fmt.Errorf("update economic event relation CAS: %w", err)
	}
	return updated == 1, nil
}

func (r *Repository) ListRelations(c core.Context, uid int64, eventId int64) ([]*EconomicEventRelation, error) {
	if uid < 1 || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event relation lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*EconomicEventRelation, 0)
	if err = sess.Where("uid=? AND (source_event_id=? OR target_event_id=?)", uid, eventId, eventId).
		Asc("relation_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event relations: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) InsertEventTransaction(value *EconomicEventTransaction) error {
	if err := tx.validate(); err != nil || !isValidEventTransaction(value, tx.uid) {
		return fmt.Errorf("invalid economic event transaction insert")
	}
	return insertOne(tx.session, value, "economic event transaction")
}

func (tx *RepositoryTransaction) UpdateEventTransactionRole(linkId int64, expectedRole EventTransactionRole, nextRole EventTransactionRole) (bool, error) {
	if err := tx.validate(); err != nil || linkId < 1 || !isEventTransactionRole(expectedRole) || !isEventTransactionRole(nextRole) || expectedRole == nextRole {
		return false, fmt.Errorf("invalid economic event transaction role update")
	}
	updated, err := tx.session.Where("uid=? AND link_id=? AND role=?", tx.uid, linkId, expectedRole).
		Cols("role").Update(&EconomicEventTransaction{Role: nextRole})
	if err != nil {
		return false, fmt.Errorf("update economic event transaction role: %w", err)
	}
	return updated == 1, nil
}

func (r *Repository) ListEventTransactions(c core.Context, uid int64, eventId int64) ([]*EconomicEventTransaction, error) {
	if uid < 1 || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event transaction lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listEventTransactions(sess, uid, eventId)
}

func (tx *RepositoryTransaction) ListEventTransactions(eventId int64) ([]*EconomicEventTransaction, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event transaction transaction lookup")
	}
	return listEventTransactions(tx.session, tx.uid, eventId)
}

func listEventTransactions(sess *xorm.Session, uid int64, eventId int64) ([]*EconomicEventTransaction, error) {
	items := make([]*EconomicEventTransaction, 0)
	if err := sess.Where("uid=? AND event_id=?", uid, eventId).Asc("link_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event transactions: %w", err)
	}
	return items, nil
}

func (r *Repository) CreateOrFindAction(c core.Context, candidate *FinanceAction) (*FinanceAction, bool, error) {
	if !isValidNewAction(candidate) {
		return nil, false, fmt.Errorf("invalid finance action insert")
	}
	database, err := r.database(candidate.Uid)
	if err != nil {
		return nil, false, err
	}
	for attempt := 0; attempt < maximumPersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		persisted, created, persistErr := createOrFindAction(sess, database.DatabaseType(), candidate)
		sess.Close()
		if persistErr == nil {
			return persisted, created, nil
		}
		if attempt+1 == maximumPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), persistErr) {
			return nil, false, persistErr
		}
		if waitErr := waitPersistenceRetry(c, initialPersistenceRetryInterval<<attempt); waitErr != nil {
			return nil, false, waitErr
		}
	}
	return nil, false, fmt.Errorf("finance action persistence retry limit reached")
}

func (r *Repository) FindActionById(c core.Context, uid int64, actionId int64) (*FinanceAction, error) {
	if uid < 1 || actionId < 1 {
		return nil, fmt.Errorf("invalid finance action lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findActionById(sess, uid, actionId)
}

func (tx *RepositoryTransaction) FindActionById(actionId int64) (*FinanceAction, error) {
	if err := tx.validate(); err != nil || actionId < 1 {
		return nil, fmt.Errorf("invalid finance action transaction lookup")
	}
	return findActionById(tx.session, tx.uid, actionId)
}

func findActionById(sess *xorm.Session, uid int64, actionId int64) (*FinanceAction, error) {
	value := new(FinanceAction)
	found, err := sess.Where("uid=? AND action_id=?", uid, actionId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find finance action: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (tx *RepositoryTransaction) CreateOrFindAction(candidate *FinanceAction) (*FinanceAction, bool, error) {
	if err := tx.validate(); err != nil || candidate == nil || candidate.Uid != tx.uid || !isValidNewAction(candidate) {
		return nil, false, fmt.Errorf("invalid finance action transaction insert")
	}
	return createOrFindAction(tx.session, tx.database.DatabaseType(), candidate)
}

func createOrFindAction(sess *xorm.Session, databaseType string, candidate *FinanceAction) (*FinanceAction, bool, error) {
	statement := `INSERT INTO pf_finance_action (
		uid, update_id, expected_update_version, applied_update_version, action_type,
		idempotency_key_digest, idempotency_key_version, request_digest, request_digest_version,
		status, reason_codes_json, error_code, created_unix_time, started_unix_time,
		completed_unix_time, failed_unix_time, updated_unix_time, action_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	switch databaseType {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, idempotency_key_digest) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported finance action database type")
	}

	result, execErr := sess.Exec(statement, candidate.Uid, candidate.UpdateId, candidate.ExpectedUpdateVersion,
		candidate.AppliedUpdateVersion, candidate.ActionType, candidate.IdempotencyKeyDigest,
		candidate.IdempotencyKeyVersion, candidate.RequestDigest, candidate.RequestDigestVersion,
		candidate.Status, candidate.ReasonCodesJson, candidate.ErrorCode, candidate.CreatedUnixTime,
		candidate.StartedUnixTime, candidate.CompletedUnixTime, candidate.FailedUnixTime,
		candidate.UpdatedUnixTime, candidate.ActionId)
	if execErr != nil && (databaseType != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert finance action: %w", execErr)
	}
	if execErr == nil {
		affected, affectedErr := result.RowsAffected()
		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read finance action insert result")
		}
		if affected == 1 {
			cloned := *candidate
			return &cloned, true, nil
		}
	}

	persisted := new(FinanceAction)
	found, findErr := sess.Where("uid=? AND idempotency_key_digest=?", candidate.Uid, candidate.IdempotencyKeyDigest).Get(persisted)
	if findErr != nil {
		return nil, false, fmt.Errorf("find finance action by idempotency key: %w", findErr)
	}
	if !found {
		return nil, false, fmt.Errorf("idempotent finance action is missing after unique conflict")
	}
	if persisted.RequestDigest != candidate.RequestDigest || persisted.RequestDigestVersion != candidate.RequestDigestVersion ||
		persisted.IdempotencyKeyVersion != candidate.IdempotencyKeyVersion {
		return nil, false, ErrActionRequestConflict
	}
	return persisted, false, nil
}

func (tx *RepositoryTransaction) UpdateAction(next *FinanceAction) (bool, error) {
	return tx.UpdateActionCAS("", next)
}

func (tx *RepositoryTransaction) UpdateActionCAS(expectedStatus ActionStatus, next *FinanceAction) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.ActionId < 1 ||
		next.UpdateId < 1 || !isActionType(next.ActionType) || !isActionStatus(next.Status) ||
		next.AppliedUpdateVersion < 0 || next.ReasonCodesJson == "" || next.UpdatedUnixTime < 1 ||
		(expectedStatus != "" && !isActionStatus(expectedStatus)) {
		return false, fmt.Errorf("invalid finance action update")
	}
	query := tx.session.Where("uid=? AND action_id=?", tx.uid, next.ActionId)
	if expectedStatus != "" {
		query = query.And("status=?", expectedStatus)
	}
	updated, err := query.
		Cols("status", "applied_update_version", "reason_codes_json", "error_code", "started_unix_time",
			"completed_unix_time", "failed_unix_time", "updated_unix_time").
		MustCols("started_unix_time", "completed_unix_time", "failed_unix_time").Update(next)
	if err != nil {
		return false, fmt.Errorf("update finance action: %w", err)
	}
	return updated == 1, nil
}

func (tx *RepositoryTransaction) CountEvents(updateId int64) (int64, error) {
	if err := tx.validate(); err != nil || updateId < 1 {
		return 0, fmt.Errorf("invalid economic event count")
	}
	count, err := tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Count(new(EconomicEvent))
	if err != nil {
		return 0, fmt.Errorf("count economic events: %w", err)
	}
	return count, nil
}

// ensureUnpostedPlanReplaceable 在进入 organizing 之前只读核对重整边界，
// 防止自动计划覆盖人工字段、关系裁决、已丢弃证据或正式账本链接。
func (tx *RepositoryTransaction) ensureUnpostedPlanReplaceable(updateId int64) error {
	if err := tx.validate(); err != nil || updateId < 1 {
		return fmt.Errorf("invalid economic event plan replacement preflight")
	}
	manualEventCount, err := tx.session.Where("uid=? AND update_id=? AND manual_field_mask<>0", tx.uid, updateId).Count(new(EconomicEvent))
	if err != nil {
		return fmt.Errorf("count manual economic event facts: %w", err)
	}
	transactionLinkCount, err := tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Count(new(EconomicEventTransaction))
	if err != nil {
		return fmt.Errorf("count economic event transaction links: %w", err)
	}
	manualRelationCount, err := tx.session.Where("uid=? AND update_id=? AND manual=?", tx.uid, updateId, true).Count(new(EconomicEventRelation))
	if err != nil {
		return fmt.Errorf("count manual economic event relations: %w", err)
	}
	discardedEvidenceCount, err := tx.session.Where("uid=? AND update_id=? AND evidence_role=?", tx.uid, updateId, EVIDENCE_ROLE_DISCARDED).Count(new(EconomicEventEvidence))
	if err != nil {
		return fmt.Errorf("count discarded economic event evidence: %w", err)
	}
	durableIssueDecisionCount, err := tx.session.Where(
		"uid=? AND update_id=? AND (status<>? OR resolved_action_id IS NOT NULL)",
		tx.uid, updateId, REVIEW_ISSUE_STATUS_OPEN,
	).Count(new(ReviewIssue))
	if err != nil {
		return fmt.Errorf("count durable review issue decisions: %w", err)
	}
	if manualEventCount != 0 || transactionLinkCount != 0 || manualRelationCount != 0 ||
		discardedEvidenceCount != 0 || durableIssueDecisionCount != 0 {
		return ErrOrganizePlanExists
	}
	return nil
}

// ReplaceUnpostedPlan 删除可重建、尚未承载人工事实或正式交易链接的事件投影。
// 来源快照和动作审计保留，调用方随后必须在同一事务写入完整新计划。
func (tx *RepositoryTransaction) ReplaceUnpostedPlan(updateId int64) error {
	if err := tx.ensureUnpostedPlanReplaceable(updateId); err != nil {
		return err
	}
	var err error
	for _, item := range []struct {
		bean any
		name string
	}{
		{bean: new(EconomicEventRelation), name: "economic event relations"},
		{bean: new(EconomicEventEvidence), name: "economic event evidence"},
		{bean: new(EconomicEvent), name: "economic events"},
	} {
		if _, err = tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Delete(item.bean); err != nil {
			return fmt.Errorf("replace %s: %w", item.name, err)
		}
	}
	return nil
}

func insertOne(sess *xorm.Session, value any, name string) error {
	inserted, err := sess.Insert(value)
	if err != nil {
		return fmt.Errorf("insert %s: %w", name, err)
	}
	if inserted != 1 {
		return fmt.Errorf("%s was not inserted", name)
	}
	return nil
}

func isValidNewUpdate(value *FinanceUpdate, uid int64) bool {
	return value != nil && value.Uid == uid && value.UpdateId > 0 && value.Status == UPDATE_STATUS_DRAFT &&
		value.Version == 1 && value.PlanVersion != "" && value.CurrentActionId == nil && value.ErrorCode == "" &&
		value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime && validConservation(value)
}

func isValidUpdateCAS(value *FinanceUpdate, uid int64, expectedVersion int64) bool {
	return value != nil && value.Uid == uid && value.UpdateId > 0 && expectedVersion > 0 &&
		value.Version == expectedVersion+1 && isUpdateStatus(value.Status) && value.PlanVersion != "" &&
		value.UpdatedUnixTime > 0 && validConservation(value)
}

func validConservation(value *FinanceUpdate) bool {
	if value == nil || value.SourceCount < 0 || value.ValidEvidenceCount < 0 || value.DuplicateEvidenceCount < 0 ||
		value.FinalEventCount < 0 || value.PostedEventCount < 0 || value.ReadyEventCount < 0 ||
		value.NeedsActionEventCount < 0 || value.ExcludedEventCount < 0 {
		return false
	}
	return value.ValidEvidenceCount-value.DuplicateEvidenceCount == value.FinalEventCount &&
		value.FinalEventCount == value.PostedEventCount+value.ReadyEventCount+value.NeedsActionEventCount+value.ExcludedEventCount
}

func isValidSource(value *FinanceUpdateSource, uid int64) bool {
	return value != nil && value.Uid == uid && value.SourceId > 0 && value.UpdateId > 0 && value.SourceOrder >= 0 &&
		value.FileId > 0 && value.BatchId > 0 && value.SourceTypeSnapshot != "" && value.ParserVersion != "" &&
		value.NormalizationVersion != "" && value.IdentityKeyVersion != "" && value.CreatedUnixTime > 0
}

func isValidNewEvent(value *EconomicEvent, uid int64) bool {
	return value != nil && value.Uid == uid && value.EventId > 0 && value.UpdateId > 0 && isLowerHexSHA256(value.EventKey) &&
		value.EventKeyVersion != "" && value.Version == 1 && value.RuleVersion != "" &&
		value.FieldSourcesJson != "" && value.ReasonCodesJson != "" && value.CreatedUnixTime > 0 &&
		value.UpdatedUnixTime == value.CreatedUnixTime && isValidEventSemantics(value)
}

func isValidEventCAS(value *EconomicEvent, uid int64, expectedVersion int64) bool {
	return value != nil && value.Uid == uid && value.EventId > 0 && value.UpdateId > 0 && expectedVersion > 0 &&
		value.Version == expectedVersion+1 && value.RuleVersion != "" && value.FieldSourcesJson != "" &&
		value.ReasonCodesJson != "" && value.UpdatedUnixTime > 0 && isValidEventSemantics(value)
}

func isValidEventSemantics(value *EconomicEvent) bool {
	if !isEventStatus(value.Status) || !isFlowDirection(value.FlowDirection) || !isEconomicNature(value.EconomicNature) ||
		(len(value.Currency) != 0 && len(value.Currency) != 3) || (value.Amount != nil && *value.Amount < 0) {
		return false
	}
	if value.EconomicNature == ECONOMIC_NATURE_UNKNOWN && value.Status != EVENT_STATUS_NEEDS_ACTION && value.Status != EVENT_STATUS_EXCLUDED {
		return false
	}
	if value.Status == EVENT_STATUS_READY || value.Status == EVENT_STATUS_POSTED || value.Status == EVENT_STATUS_CORRECTED {
		return value.LedgerAccountId != nil && *value.LedgerAccountId > 0 && value.EventUnixTime != nil &&
			*value.EventUnixTime > 0 && value.Amount != nil && value.Currency != "" && value.EconomicNature != ECONOMIC_NATURE_UNKNOWN
	}
	return true
}

func isValidEvidence(value *EconomicEventEvidence, uid int64) bool {
	return value != nil && value.Uid == uid && value.EvidenceId > 0 && value.UpdateId > 0 && value.EventId > 0 &&
		value.RowId > 0 && isEvidenceRole(value.EvidenceRole) && value.FieldMask >= 0 && value.CreatedUnixTime > 0
}

func isValidNewRelation(value *EconomicEventRelation, uid int64) bool {
	return value != nil && value.Uid == uid && value.RelationId > 0 && value.UpdateId > 0 &&
		isLowerHexSHA256(value.RelationKey) && value.RelationKeyVersion != "" && isRelationType(value.RelationType) &&
		isRelationStatus(value.Status) && value.Version == 1 && value.SourceEventId > 0 && value.TargetEventId > 0 &&
		value.SourceEventId != value.TargetEventId && (value.Amount == nil || *value.Amount >= 0) &&
		(len(value.Currency) == 0 || len(value.Currency) == 3) && value.RuleVersion != "" &&
		value.ReasonCodesJson != "" && value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime
}

func isValidRelationCAS(value *EconomicEventRelation, uid int64, expectedVersion int64) bool {
	return value != nil && value.Uid == uid && value.RelationId > 0 && expectedVersion > 0 &&
		value.Version == expectedVersion+1 && isRelationStatus(value.Status) && (value.Amount == nil || *value.Amount >= 0) &&
		(len(value.Currency) == 0 || len(value.Currency) == 3) && value.RuleVersion != "" &&
		value.ReasonCodesJson != "" && value.UpdatedUnixTime > 0
}

func isValidEventTransaction(value *EconomicEventTransaction, uid int64) bool {
	return value != nil && value.Uid == uid && value.LinkId > 0 && value.UpdateId > 0 && value.EventId > 0 &&
		value.TransactionId > 0 && isEventTransactionRole(value.Role) && value.RuleVersion != "" &&
		value.TransactionUpdatedUnixTime > 0 && value.CreatedUnixTime > 0
}

func isValidNewAction(value *FinanceAction) bool {
	return value != nil && value.Uid > 0 && value.ActionId > 0 && value.UpdateId > 0 && value.ExpectedUpdateVersion >= 0 &&
		value.AppliedUpdateVersion == 0 && isActionType(value.ActionType) && value.Status == ACTION_STATUS_READY &&
		isLowerHexSHA256(value.IdempotencyKeyDigest) && isLowerHexSHA256(value.RequestDigest) &&
		value.IdempotencyKeyVersion != "" && value.RequestDigestVersion != "" && value.ReasonCodesJson == "[]" &&
		value.ErrorCode == "" && value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime &&
		value.StartedUnixTime == nil && value.CompletedUnixTime == nil && value.FailedUnixTime == nil
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
