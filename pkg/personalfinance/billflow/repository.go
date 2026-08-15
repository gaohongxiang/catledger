package billflow

import (
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

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
	maximumMaskedDisplayRunes         = 128
)

var (
	ErrActionRequestConflict = errors.New("billflow action request digest conflict")
)

// TaskCursor 是任务列表按更新时间和任务 ID 倒序分页的稳定游标。
type TaskCursor struct {
	UpdatedUnixTime int64
	TaskId          int64
}

// TaskPage 保存一页整理任务及可空下一页游标。
type TaskPage struct {
	Items      []*Task
	NextCursor *TaskCursor
}

// TodoCursor 是待办列表按更新时间和待办 ID 倒序分页的稳定游标。
type TodoCursor struct {
	UpdatedUnixTime int64
	TodoId          int64
}

// TodoPage 保存一页待办。
type TodoPage struct {
	Items      []*Todo
	NextCursor *TodoCursor
}

// Repository 只访问当前 uid 所在 UserDataStore 分片。
// 所有读取和写入都通过 privacy session，并在 SQL 中同时限定 uid。
type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 是整理任务仓储的受限隐私事务句柄。
type RepositoryTransaction struct {
	uid      int64
	database *datastore.Database
	session  *xorm.Session
}

// NewRepository 创建整理任务持久层入口。
func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("billflow repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("billflow repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

// DoTransaction 在 uid 所在分片执行单一事务，并强制关闭 SQL 参数日志。
func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("billflow repository transaction callback is required")
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
		return fmt.Errorf("invalid billflow repository transaction")
	}

	return tx.database.ValidateTransactionSession(tx.session)
}

// FindTaskById 按 uid 和任务 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindTaskById(c core.Context, uid int64, taskId int64) (*Task, error) {
	if uid < 1 || taskId < 1 {
		return nil, fmt.Errorf("invalid billflow task owner or id")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findTaskById(sess, uid, taskId)
}

func (tx *RepositoryTransaction) FindTaskById(taskId int64) (*Task, error) {
	if err := tx.validate(); err != nil || taskId < 1 {
		return nil, fmt.Errorf("invalid billflow task transaction lookup")
	}

	return findTaskById(tx.session, tx.uid, taskId)
}

func findTaskById(sess *xorm.Session, uid int64, taskId int64) (*Task, error) {
	task := new(Task)
	found, err := sess.Where("uid=? AND task_id=?", uid, taskId).Get(task)
	if err != nil {
		return nil, fmt.Errorf("find billflow task: %w", err)
	}
	if !found {
		return nil, nil
	}

	return task, nil
}

// ListTasks 按 status、更新时间和任务 ID 倒序稳定分页。
func (r *Repository) ListTasks(c core.Context, uid int64, status TaskStatus, cursor *TaskCursor, limit int) (*TaskPage, error) {
	if uid < 1 || !isTaskStatus(status) || !isValidPageLimit(limit) || !isValidTaskCursor(cursor) {
		return nil, fmt.Errorf("invalid billflow task page")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	tasks := make([]*Task, 0, limit+1)
	query := sess.Where("uid=? AND status=?", uid, status)
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND task_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.TaskId)
	}

	if err := query.Desc("updated_unix_time", "task_id").Limit(limit + 1).Find(&tasks); err != nil {
		return nil, fmt.Errorf("list billflow tasks: %w", err)
	}

	page := &TaskPage{Items: tasks}
	if len(tasks) > limit {
		page.Items = tasks[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &TaskCursor{UpdatedUnixTime: last.UpdatedUnixTime, TaskId: last.TaskId}
	}

	return page, nil
}

// InsertTask 在当前隐私事务中写入新整理任务。
func (tx *RepositoryTransaction) InsertTask(task *Task) error {
	if err := tx.validate(); err != nil || !isValidNewTask(task, tx.uid) {
		return fmt.Errorf("invalid billflow task insert")
	}

	inserted, err := tx.session.Insert(task)
	if err != nil {
		return fmt.Errorf("insert billflow task: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("billflow task was not inserted")
	}

	return nil
}

// UpdateTaskCAS 使用 uid+task_id+version 条件更新可变任务字段。
func (tx *RepositoryTransaction) UpdateTaskCAS(expectedVersion int64, next *Task) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.TaskId < 1 ||
		expectedVersion < 1 || next.Version != expectedVersion+1 || !isTaskStatus(next.Status) ||
		!isConfirmPolicy(next.ConfirmPolicy) || next.UpdatedUnixTime < 1 ||
		next.CreatedAccountCount < 0 || next.ReusedMappingCount < 0 || next.AutoPostedCount < 0 ||
		next.TodoOpenCount < 0 || !isNilOrPositive(next.CurrentActionId) ||
		utf8.RuneCountInString(next.ErrorCode) > 64 {
		return false, fmt.Errorf("invalid billflow task CAS")
	}

	updated, err := tx.session.Where("uid=? AND task_id=? AND version=?", tx.uid, next.TaskId, expectedVersion).
		Cols(
			"status", "confirm_policy", "version", "current_action_id",
			"created_account_count", "reused_mapping_count", "auto_posted_count", "todo_open_count",
			"error_code", "updated_unix_time",
		).
		MustCols("current_action_id").
		Update(next)
	if err != nil {
		return false, fmt.Errorf("update billflow task CAS: %w", err)
	}

	return updated == 1, nil
}

// InsertMember 把一份文件/批次绑定到当前用户的整理任务。
func (tx *RepositoryTransaction) InsertMember(member *TaskMember) error {
	if err := tx.validate(); err != nil || !isValidNewTaskMember(member, tx.uid) {
		return fmt.Errorf("invalid billflow task member insert")
	}

	inserted, err := tx.session.Insert(member)
	if err != nil {
		return fmt.Errorf("insert billflow task member: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("billflow task member was not inserted")
	}

	return nil
}

// ListMembers 按任务内顺序返回当前 uid 的任务成员。
func (r *Repository) ListMembers(c core.Context, uid int64, taskId int64) ([]*TaskMember, error) {
	if uid < 1 || taskId < 1 {
		return nil, fmt.Errorf("invalid billflow task member list")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	members := make([]*TaskMember, 0)
	if err := sess.Where("uid=? AND task_id=?", uid, taskId).Asc("member_order", "member_id").Find(&members); err != nil {
		return nil, fmt.Errorf("list billflow task members: %w", err)
	}

	return members, nil
}

func (tx *RepositoryTransaction) ListMembers(taskId int64) ([]*TaskMember, error) {
	if err := tx.validate(); err != nil || taskId < 1 {
		return nil, fmt.Errorf("invalid billflow task member transaction list")
	}

	members := make([]*TaskMember, 0)
	if err := tx.session.Where("uid=? AND task_id=?", tx.uid, taskId).Asc("member_order", "member_id").Find(&members); err != nil {
		return nil, fmt.Errorf("list billflow task members: %w", err)
	}

	return members, nil
}

// FindActionByIdempotency 按 uid 和幂等键摘要查询，不存在时返回 (nil, nil)。
func (r *Repository) FindActionByIdempotency(c core.Context, uid int64, digest string) (*Action, error) {
	if uid < 1 || !isLowerHexSHA256(digest) {
		return nil, fmt.Errorf("invalid billflow action idempotency lookup")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findActionByKey(sess, uid, digest)
}

// CreateOrFindAction 由 uid+idempotency_key_digest 唯一约束裁决并发幂等命令。
// created=false 时若摘要不同则返回 ErrActionRequestConflict。
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

	return nil, false, fmt.Errorf("billflow action persistence retry limit reached")
}

func (tx *RepositoryTransaction) CreateOrFindAction(candidate *Action) (*Action, bool, error) {
	if err := tx.validate(); err != nil || candidate == nil || candidate.Uid != tx.uid {
		return nil, false, fmt.Errorf("invalid billflow action transaction insert")
	}
	if err := validateNewAction(candidate); err != nil {
		return nil, false, err
	}

	return createOrFindAction(tx.session, tx.database.DatabaseType(), candidate)
}

func createOrFindAction(sess *xorm.Session, databaseType string, candidate *Action) (*Action, bool, error) {
	statement := `INSERT INTO pf_billflow_action (
		uid, task_id, expected_task_version, applied_task_version,
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
		return nil, false, fmt.Errorf("unsupported billflow action database type")
	}

	result, execErr := sess.Exec(statement,
		candidate.Uid, candidate.TaskId, candidate.ExpectedTaskVersion, candidate.AppliedTaskVersion,
		candidate.ActionType, candidate.PreviousActionId, candidate.IdempotencyKeyDigest,
		candidate.IdempotencyKeyVersion, candidate.RequestDigest, candidate.RequestDigestVersion,
		candidate.Status, candidate.ReasonCodesJson, candidate.ErrorCode, candidate.CreatedUnixTime,
		candidate.UpdatedUnixTime, candidate.StartedUnixTime, candidate.CompletedUnixTime,
		candidate.FailedUnixTime, candidate.ActionId,
	)
	if execErr != nil && (databaseType != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert billflow action: %w", execErr)
	}

	if execErr == nil {
		affected, affectedErr := result.RowsAffected()
		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read billflow action insert result")
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
			return nil, false, fmt.Errorf("insert billflow action: %w", execErr)
		}
		return nil, false, fmt.Errorf("idempotent billflow action is missing after unique conflict")
	}
	if persisted.RequestDigest != candidate.RequestDigest || persisted.RequestDigestVersion != candidate.RequestDigestVersion ||
		persisted.IdempotencyKeyVersion != candidate.IdempotencyKeyVersion {
		return nil, false, ErrActionRequestConflict
	}

	return persisted, false, nil
}

func findActionByKey(sess *xorm.Session, uid int64, digest string) (*Action, error) {
	action := new(Action)
	found, err := sess.Where("uid=? AND idempotency_key_digest=?", uid, digest).Get(action)
	if err != nil {
		return nil, fmt.Errorf("find billflow action by idempotency key: %w", err)
	}
	if !found {
		return nil, nil
	}

	return action, nil
}

// InsertTodo 写入一条例外待办。
func (tx *RepositoryTransaction) InsertTodo(todo *Todo) error {
	if err := tx.validate(); err != nil || !isValidNewTodo(todo, tx.uid) {
		return fmt.Errorf("invalid billflow todo insert")
	}

	inserted, err := tx.session.Insert(todo)
	if err != nil {
		return fmt.Errorf("insert billflow todo: %w", err)
	}
	if inserted != 1 {
		return fmt.Errorf("billflow todo was not inserted")
	}

	return nil
}

// UpdateTodoCAS 使用 uid+todo_id+version 条件更新待办状态。
func (tx *RepositoryTransaction) UpdateTodoCAS(expectedVersion int64, next *Todo) (bool, error) {
	if err := tx.validate(); err != nil || next == nil || next.Uid != tx.uid || next.TodoId < 1 ||
		expectedVersion < 1 || next.Version != expectedVersion+1 || !isTodoStatus(next.Status) ||
		next.UpdatedUnixTime < 1 || next.ReasonCodesJson == "" {
		return false, fmt.Errorf("invalid billflow todo CAS")
	}
	if next.Status == TODO_STATUS_OPEN {
		if next.ResolvedUnixTime != nil {
			return false, fmt.Errorf("invalid billflow todo CAS")
		}
	} else if !isNilOrPositive(next.ResolvedUnixTime) {
		return false, fmt.Errorf("invalid billflow todo CAS")
	}

	updated, err := tx.session.Where("uid=? AND todo_id=? AND version=?", tx.uid, next.TodoId, expectedVersion).
		Cols("status", "reason_codes_json", "version", "updated_unix_time", "resolved_unix_time").
		MustCols("resolved_unix_time").
		Update(next)
	if err != nil {
		return false, fmt.Errorf("update billflow todo CAS: %w", err)
	}

	return updated == 1, nil
}

// ListTodos 按 uid、任务、状态、更新时间和待办 ID 倒序稳定分页。
func (r *Repository) ListTodos(c core.Context, uid int64, taskId int64, status TodoStatus, cursor *TodoCursor, limit int) (*TodoPage, error) {
	if uid < 1 || taskId < 1 || !isTodoStatus(status) || !isValidPageLimit(limit) || !isValidTodoCursor(cursor) {
		return nil, fmt.Errorf("invalid billflow todo page")
	}

	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()
	todos := make([]*Todo, 0, limit+1)
	query := sess.Where("uid=? AND task_id=? AND status=?", uid, taskId, status)
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND todo_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.TodoId)
	}
	if err := query.Desc("updated_unix_time", "todo_id").Limit(limit + 1).Find(&todos); err != nil {
		return nil, fmt.Errorf("list billflow todos: %w", err)
	}

	page := &TodoPage{Items: todos}
	if len(todos) > limit {
		page.Items = todos[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &TodoCursor{UpdatedUnixTime: last.UpdatedUnixTime, TodoId: last.TodoId}
	}

	return page, nil
}

// CreateOrFindCategoryAlias 由 uid+source_type+alias_key 唯一约束裁决分类别名。
// 已存在且版本兼容时返回旧映射，不覆盖 ledger_category_id。
func (r *Repository) CreateOrFindCategoryAlias(c core.Context, candidate *CategoryAliasMapping) (*CategoryAliasMapping, bool, error) {
	if !isValidNewCategoryAlias(candidate) {
		return nil, false, fmt.Errorf("invalid billflow category alias")
	}

	database, err := r.database(candidate.Uid)
	if err != nil {
		return nil, false, err
	}

	for attempt := 0; attempt < maximumActionPersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		persisted, created, persistErr := createOrFindCategoryAlias(sess, database.DatabaseType(), candidate)
		sess.Close()
		if persistErr == nil {
			return persisted, created, nil
		}
		if attempt+1 == maximumActionPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), persistErr) {
			return nil, false, persistErr
		}
		if waitErr := waitPersistenceRetry(c, initialActionPersistenceRetryWait<<attempt); waitErr != nil {
			return nil, false, waitErr
		}
	}

	return nil, false, fmt.Errorf("billflow category alias persistence retry limit reached")
}

func (tx *RepositoryTransaction) CreateOrFindCategoryAlias(candidate *CategoryAliasMapping) (*CategoryAliasMapping, bool, error) {
	if err := tx.validate(); err != nil || candidate == nil || candidate.Uid != tx.uid {
		return nil, false, fmt.Errorf("invalid billflow category alias transaction insert")
	}
	if !isValidNewCategoryAlias(candidate) {
		return nil, false, fmt.Errorf("invalid billflow category alias")
	}

	return createOrFindCategoryAlias(tx.session, tx.database.DatabaseType(), candidate)
}

func createOrFindCategoryAlias(sess *xorm.Session, databaseType string, candidate *CategoryAliasMapping) (*CategoryAliasMapping, bool, error) {
	statement := `INSERT INTO pf_category_alias_mapping (
		uid, source_type, alias_key, alias_key_version, ledger_category_id,
		masked_display_name, created_unix_time, updated_unix_time, mapping_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch databaseType {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, source_type, alias_key) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported billflow category alias database type")
	}

	result, execErr := sess.Exec(statement,
		candidate.Uid, candidate.SourceType, candidate.AliasKey, candidate.AliasKeyVersion,
		candidate.LedgerCategoryId, candidate.MaskedDisplayName, candidate.CreatedUnixTime,
		candidate.UpdatedUnixTime, candidate.MappingId,
	)
	if execErr != nil && (databaseType != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, false, fmt.Errorf("insert billflow category alias: %w", execErr)
	}

	if execErr == nil {
		affected, err := result.RowsAffected()
		if err != nil || affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read billflow category alias insert result")
		}
		if affected == 1 {
			return cloneCategoryAlias(candidate), true, nil
		}
	}

	persisted := new(CategoryAliasMapping)
	found, err := sess.Where("uid=? AND source_type=? AND alias_key=?", candidate.Uid, candidate.SourceType, candidate.AliasKey).Get(persisted)
	if err != nil {
		return nil, false, fmt.Errorf("find billflow category alias after insert: %w", err)
	}
	if !found {
		if execErr != nil {
			return nil, false, fmt.Errorf("insert billflow category alias: %w", execErr)
		}
		return nil, false, fmt.Errorf("billflow category alias is missing after unique conflict")
	}
	if persisted.AliasKeyVersion != candidate.AliasKeyVersion {
		return nil, false, fmt.Errorf("billflow category alias version is incompatible")
	}

	return persisted, false, nil
}

func isValidNewTask(value *Task, uid int64) bool {
	return value != nil && value.Uid == uid && value.TaskId > 0 && value.Version == 1 &&
		isTaskStatus(value.Status) && isConfirmPolicy(value.ConfirmPolicy) &&
		value.CurrentActionId == nil && value.CreatedAccountCount == 0 && value.ReusedMappingCount == 0 &&
		value.AutoPostedCount == 0 && value.TodoOpenCount == 0 && value.ErrorCode == "" &&
		value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime
}

func isValidNewTaskMember(value *TaskMember, uid int64) bool {
	return value != nil && value.Uid == uid && value.MemberId > 0 && value.TaskId > 0 &&
		value.MemberOrder >= 0 && value.FileId > 0 && value.BatchId > 0 && value.CreatedUnixTime > 0
}

func validateNewAction(value *Action) error {
	if value == nil || value.Uid < 1 || value.TaskId < 1 || value.ActionId < 1 || value.ExpectedTaskVersion < 0 ||
		value.AppliedTaskVersion != 0 || !isActionType(value.ActionType) || value.Status != ACTION_STATUS_READY ||
		!isLowerHexSHA256(value.IdempotencyKeyDigest) || !isLowerHexSHA256(value.RequestDigest) ||
		value.IdempotencyKeyVersion == "" || value.RequestDigestVersion == "" || value.ReasonCodesJson != "[]" ||
		value.ErrorCode != "" || value.CreatedUnixTime < 1 || value.UpdatedUnixTime != value.CreatedUnixTime ||
		value.StartedUnixTime != nil || value.CompletedUnixTime != nil || value.FailedUnixTime != nil ||
		!isNilOrPositive(value.PreviousActionId) {
		return fmt.Errorf("invalid new billflow action")
	}

	return nil
}

func isValidNewTodo(value *Todo, uid int64) bool {
	return value != nil && value.Uid == uid && value.TodoId > 0 && value.TaskId > 0 &&
		isTodoKind(value.TodoKind) && value.Status == TODO_STATUS_OPEN && isSubjectKind(value.SubjectKind) &&
		value.SubjectId > 0 && value.ReasonCodesJson != "" && value.Version == 1 &&
		value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime && value.ResolvedUnixTime == nil
}

func isValidNewCategoryAlias(value *CategoryAliasMapping) bool {
	displayRunes := 0
	if value != nil {
		displayRunes = utf8.RuneCountInString(value.MaskedDisplayName)
	}

	return value != nil && value.Uid > 0 && value.MappingId > 0 && isSourceType(value.SourceType) &&
		isLowerHexSHA256(value.AliasKey) && value.AliasKeyVersion == CATEGORY_ALIAS_VERSION_V1 &&
		value.LedgerCategoryId > 0 && displayRunes > 0 && displayRunes <= maximumMaskedDisplayRunes &&
		value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime
}

func isValidPageLimit(limit int) bool {
	return limit > 0 && limit <= maximumRepositoryPageSize
}

func isValidTaskCursor(cursor *TaskCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.TaskId > 0)
}

func isValidTodoCursor(cursor *TodoCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.TodoId > 0)
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

func cloneCategoryAlias(value *CategoryAliasMapping) *CategoryAliasMapping {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}
