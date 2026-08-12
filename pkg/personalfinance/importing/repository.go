package importing

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

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

func isValidSourceType(sourceType SourceType) bool {
	return sourceType == SOURCE_TYPE_ALIPAY || sourceType == SOURCE_TYPE_WECHAT
}
