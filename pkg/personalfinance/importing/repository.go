package importing

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

const maximumRepositoryPageSize = 100

// Repository 只访问当前用户所在的 UserDataStore 分片。
// 所有公开查询都要求 uid，并在 SQL 条件中同时限定 uid。
type Repository struct {
	store *datastore.DataStore
}

// RepositoryTransaction 是 PF repository 的受限事务句柄。
// 上层只能使用这里显式开放的事务能力，不能取得原始 Database 或 XORM Session。
type RepositoryTransaction struct {
	database *datastore.Database
	session  *xorm.Session
}

// NewRepository 创建个人财务持久层入口。
func NewRepository(store *datastore.DataStore) (*Repository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("personal finance repository requires a user data store")
	}

	return &Repository{store: store}, nil
}

func (r *Repository) database(uid int64) (*datastore.Database, error) {
	if uid < 1 {
		return nil, fmt.Errorf("personal finance repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

// DoTransaction 在 uid 所在分片执行单一事务，并强制关闭 SQL 参数日志。
func (r *Repository) DoTransaction(c core.Context, uid int64, fn func(tx *RepositoryTransaction) error) error {
	if fn == nil {
		return fmt.Errorf("personal finance transaction callback is required")
	}

	db, err := r.database(uid)

	if err != nil {
		return err
	}

	return db.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		return fn(&RepositoryTransaction{database: db, session: sess})
	})
}

// SetSavePoint 为需要处理 PostgreSQL 唯一冲突的 repository 操作设置保存点。
func (tx *RepositoryTransaction) SetSavePoint(name string) error {
	if tx == nil || tx.database == nil || tx.session == nil || !isSafeSavePointName(name) {
		return fmt.Errorf("invalid personal finance save point")
	}

	return tx.database.SetSavePoint(tx.session, name)
}

// RollbackToSavePoint 回滚到 repository 事务中的已知保存点。
func (tx *RepositoryTransaction) RollbackToSavePoint(name string) error {
	if tx == nil || tx.database == nil || tx.session == nil || !isSafeSavePointName(name) {
		return fmt.Errorf("invalid personal finance save point")
	}

	return tx.database.RollbackToSavePoint(tx.session, name)
}

func isSafeSavePointName(name string) bool {
	if name == "" || len(name) > 48 {
		return false
	}

	for _, char := range name {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}

	return true
}

// FindImportFileById 按用户和文件 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindImportFileById(c core.Context, uid int64, fileId int64) (*ImportFile, error) {
	if uid < 1 || fileId < 1 {
		return nil, fmt.Errorf("invalid import file owner or id")
	}

	db, _ := r.database(uid)
	file := new(ImportFile)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND file_id=?", uid, fileId).Get(file)

	if err != nil {
		return nil, fmt.Errorf("find personal finance import file: %w", err)
	}

	if !found {
		return nil, nil
	}

	return file, nil
}

// FindImportFileBySHA256 按用户和原始上传字节摘要查询，不存在时返回 (nil, nil)。
func (r *Repository) FindImportFileBySHA256(c core.Context, uid int64, fileSHA256 string) (*ImportFile, error) {
	if uid < 1 || !isLowerHexSHA256(fileSHA256) {
		return nil, fmt.Errorf("invalid import file owner or SHA-256")
	}

	db, _ := r.database(uid)
	file := new(ImportFile)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND file_sha256=?", uid, fileSHA256).Get(file)

	if err != nil {
		return nil, fmt.Errorf("find personal finance import file by SHA-256: %w", err)
	}

	if !found {
		return nil, nil
	}

	return file, nil
}

// InsertImportFile 创建一条 pending 原文件记录。
// uid + SHA-256 的唯一约束仍是并发上传的最终裁决。
func (r *Repository) InsertImportFile(c core.Context, file *ImportFile) error {
	if file == nil || file.Uid < 1 || file.FileId < 1 ||
		!isLowerHexSHA256(file.FileSha256) ||
		file.ContentState != IMPORT_FILE_CONTENT_STATE_PENDING ||
		file.StorageObjectKey == "" {
		return fmt.Errorf("invalid personal finance import file")
	}

	return r.DoTransaction(c, file.Uid, func(tx *RepositoryTransaction) error {
		inserted, err := tx.session.Insert(file)

		if err != nil {
			return err
		}

		if inserted != 1 {
			return fmt.Errorf("personal finance import file was not inserted")
		}

		return nil
	})
}

// UpdateImportFileContentState 只在当前状态属于 expectedStates 时推进补偿状态机。
// 返回 false 表示另一个并发请求已经改变了状态。
func (r *Repository) UpdateImportFileContentState(c core.Context, uid int64, fileId int64, expectedStates []ImportFileContentState, nextState ImportFileContentState, updatedUnixTime int64) (bool, error) {
	if uid < 1 || fileId < 1 || len(expectedStates) < 1 ||
		!isValidImportFileContentState(nextState) || updatedUnixTime < 1 {
		return false, fmt.Errorf("invalid import file state transition")
	}

	expected := make([]string, len(expectedStates))

	for i, state := range expectedStates {
		if !isValidImportFileContentState(state) {
			return false, fmt.Errorf("invalid expected import file content state")
		}

		expected[i] = string(state)
	}

	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	update := &ImportFile{
		ContentState:    nextState,
		UpdatedUnixTime: updatedUnixTime,
	}
	columns := []string{"content_state", "updated_unix_time"}

	if nextState == IMPORT_FILE_CONTENT_STATE_PENDING && containsImportFileContentState(expectedStates, IMPORT_FILE_CONTENT_STATE_DELETED) {
		// 显式重传已删除内容时清除旧删除时间；唯一文件身份与历史批次保持不变。
		columns = append(columns, "content_deleted_unix_time")
		update.ContentDeletedUnixTime = nil
	}

	updated, err := sess.Where("uid=? AND file_id=?", uid, fileId).
		In("content_state", expected).
		Cols(columns...).
		Update(update)

	if err != nil {
		return false, fmt.Errorf("update personal finance import file content state: %w", err)
	}

	return updated == 1, nil
}

// ListImportFiles 按创建时间和文件 ID 倒序稳定分页。
func (r *Repository) ListImportFiles(c core.Context, uid int64, offset int, limit int) ([]*ImportFile, int64, error) {
	if uid < 1 || !isValidRepositoryPage(offset, limit) {
		return nil, 0, fmt.Errorf("invalid import file page")
	}

	db, _ := r.database(uid)
	countSession := db.NewPrivacySession(c)
	totalCount, err := countSession.Where("uid=?", uid).Count(new(ImportFile))
	countSession.Close()

	if err != nil {
		return nil, 0, fmt.Errorf("count personal finance import files: %w", err)
	}

	files := make([]*ImportFile, 0)
	listSession := db.NewPrivacySession(c)
	defer listSession.Close()

	if err := listSession.Where("uid=?", uid).
		Desc("created_unix_time", "file_id").
		Limit(limit, offset).
		Find(&files); err != nil {
		return nil, 0, fmt.Errorf("list personal finance import files: %w", err)
	}

	return files, totalCount, nil
}

// FindSourceAccountById 按用户和来源账户 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindSourceAccountById(c core.Context, uid int64, sourceAccountId int64) (*SourceAccount, error) {
	if uid < 1 || sourceAccountId < 1 {
		return nil, fmt.Errorf("invalid source account owner or id")
	}

	db, _ := r.database(uid)
	account := new(SourceAccount)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND source_account_id=?", uid, sourceAccountId).Get(account)

	if err != nil {
		return nil, fmt.Errorf("find personal finance source account: %w", err)
	}

	if !found {
		return nil, nil
	}

	return account, nil
}

// FindSourceAccountByKey 按用户、来源类型和脱敏 key 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindSourceAccountByKey(c core.Context, uid int64, sourceType SourceType, sourceAccountKey string) (*SourceAccount, error) {
	if uid < 1 || !isValidSourceType(sourceType) || !isLowerHexSHA256(sourceAccountKey) {
		return nil, fmt.Errorf("invalid source account lookup")
	}

	db, _ := r.database(uid)
	account := new(SourceAccount)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND source_type=? AND source_account_key=?", uid, sourceType, sourceAccountKey).Get(account)

	if err != nil {
		return nil, fmt.Errorf("find personal finance source account by key: %w", err)
	}

	if !found {
		return nil, nil
	}

	return account, nil
}

// FindImportBatchById 按用户和批次 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindImportBatchById(c core.Context, uid int64, batchId int64) (*ImportBatch, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid import batch owner or id")
	}

	db, _ := r.database(uid)
	batch := new(ImportBatch)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(batch)

	if err != nil {
		return nil, fmt.Errorf("find personal finance import batch: %w", err)
	}

	if !found {
		return nil, nil
	}

	return batch, nil
}

// FindLatestImportBatchByFileId 返回同一用户文件最近创建的解析批次。
func (r *Repository) FindLatestImportBatchByFileId(c core.Context, uid int64, fileId int64) (*ImportBatch, error) {
	if uid < 1 || fileId < 1 {
		return nil, fmt.Errorf("invalid import batch owner or file id")
	}

	db, _ := r.database(uid)
	batch := new(ImportBatch)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND file_id=?", uid, fileId).
		Desc("created_unix_time", "batch_id").
		Limit(1).
		Get(batch)

	if err != nil {
		return nil, fmt.Errorf("find latest personal finance import batch: %w", err)
	}

	if !found {
		return nil, nil
	}

	return batch, nil
}

// ListImportBatchIssues 按持久 issue_order 返回文档级问题。
func (r *Repository) ListImportBatchIssues(c core.Context, uid int64, batchId int64) ([]*ImportBatchIssue, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid import batch issue owner or id")
	}

	db, _ := r.database(uid)
	issues := make([]*ImportBatchIssue, 0)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	if err := sess.Where("uid=? AND batch_id=?", uid, batchId).Asc("issue_order", "issue_id").Find(&issues); err != nil {
		return nil, fmt.Errorf("list personal finance import batch issues: %w", err)
	}

	return issues, nil
}

// ListImportBatches 按创建时间和批次 ID 倒序稳定分页。
// fileId 为 0 时列出全部文件的批次，否则只列出指定文件的批次。
func (r *Repository) ListImportBatches(c core.Context, uid int64, fileId int64, offset int, limit int) ([]*ImportBatch, int64, error) {
	if uid < 1 || fileId < 0 || !isValidRepositoryPage(offset, limit) {
		return nil, 0, fmt.Errorf("invalid import batch page")
	}

	db, _ := r.database(uid)
	countSession := db.NewPrivacySession(c)
	countQuery := countSession.Where("uid=?", uid)

	if fileId > 0 {
		countQuery = countQuery.And("file_id=?", fileId)
	}

	totalCount, err := countQuery.Count(new(ImportBatch))
	countSession.Close()

	if err != nil {
		return nil, 0, fmt.Errorf("count personal finance import batches: %w", err)
	}

	batches := make([]*ImportBatch, 0)
	listSession := db.NewPrivacySession(c)
	defer listSession.Close()
	listQuery := listSession.Where("uid=?", uid)

	if fileId > 0 {
		listQuery = listQuery.And("file_id=?", fileId)
	}

	if err := listQuery.Desc("created_unix_time", "batch_id").
		Limit(limit, offset).
		Find(&batches); err != nil {
		return nil, 0, fmt.Errorf("list personal finance import batches: %w", err)
	}

	return batches, totalCount, nil
}

// FindSourceIdentityByKey 按用户和来源身份 key 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindSourceIdentityByKey(c core.Context, uid int64, sourceIdentityKey string) (*SourceIdentity, error) {
	if uid < 1 || !isLowerHexSHA256(sourceIdentityKey) {
		return nil, fmt.Errorf("invalid source identity lookup")
	}

	db, _ := r.database(uid)
	identity := new(SourceIdentity)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND source_identity_key=?", uid, sourceIdentityKey).Get(identity)

	if err != nil {
		return nil, fmt.Errorf("find personal finance source identity: %w", err)
	}

	if !found {
		return nil, nil
	}

	return identity, nil
}

// FindRawImportRowById 按用户和原始行 ID 查询，不存在时返回 (nil, nil)。
func (r *Repository) FindRawImportRowById(c core.Context, uid int64, rowId int64) (*RawImportRow, error) {
	if uid < 1 || rowId < 1 {
		return nil, fmt.Errorf("invalid raw import row owner or id")
	}

	db, _ := r.database(uid)
	row := new(RawImportRow)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	found, err := sess.Where("uid=? AND row_id=?", uid, rowId).Get(row)

	if err != nil {
		return nil, fmt.Errorf("find personal finance raw import row: %w", err)
	}

	if !found {
		return nil, nil
	}

	return row, nil
}

// ListRawImportRows 按稳定行号顺序读取一个用户批次的全部原始行。
func (r *Repository) ListRawImportRows(c core.Context, uid int64, batchId int64) ([]*RawImportRow, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid raw import row owner or batch id")
	}

	db, _ := r.database(uid)
	rows := make([]*RawImportRow, 0)
	sess := db.NewPrivacySession(c)
	defer sess.Close()

	if err := sess.Where("uid=? AND batch_id=?", uid, batchId).Asc("row_number").Find(&rows); err != nil {
		return nil, fmt.Errorf("list personal finance raw import rows: %w", err)
	}

	return rows, nil
}

// ListRawImportRowsPage 按逻辑行号和行 ID 正序稳定分页。
func (r *Repository) ListRawImportRowsPage(c core.Context, uid int64, batchId int64, offset int, limit int) ([]*RawImportRow, int64, error) {
	if uid < 1 || batchId < 1 || !isValidRepositoryPage(offset, limit) {
		return nil, 0, fmt.Errorf("invalid raw import row page")
	}

	db, _ := r.database(uid)
	countSession := db.NewPrivacySession(c)
	totalCount, err := countSession.Where("uid=? AND batch_id=?", uid, batchId).Count(new(RawImportRow))
	countSession.Close()

	if err != nil {
		return nil, 0, fmt.Errorf("count personal finance raw import rows: %w", err)
	}

	rows := make([]*RawImportRow, 0)
	listSession := db.NewPrivacySession(c)
	defer listSession.Close()

	if err := listSession.Where("uid=? AND batch_id=?", uid, batchId).
		Asc("row_number", "row_id").
		Limit(limit, offset).
		Find(&rows); err != nil {
		return nil, 0, fmt.Errorf("list personal finance raw import rows page: %w", err)
	}

	return rows, totalCount, nil
}

func isValidImportFileContentState(state ImportFileContentState) bool {
	switch state {
	case IMPORT_FILE_CONTENT_STATE_PENDING,
		IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		IMPORT_FILE_CONTENT_STATE_MISSING,
		IMPORT_FILE_CONTENT_STATE_FAILED,
		IMPORT_FILE_CONTENT_STATE_DELETED:
		return true
	default:
		return false
	}
}

func isValidRepositoryPage(offset int, limit int) bool {
	return offset >= 0 && limit > 0 && limit <= maximumRepositoryPageSize
}

func containsImportFileContentState(states []ImportFileContentState, expected ImportFileContentState) bool {
	for _, state := range states {
		if state == expected {
			return true
		}
	}

	return false
}

func isValidSourceType(sourceType SourceType) bool {
	return sourceType == SOURCE_TYPE_ALIPAY || sourceType == SOURCE_TYPE_WECHAT
}
