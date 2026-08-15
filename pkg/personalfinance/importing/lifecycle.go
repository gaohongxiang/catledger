package importing

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

const batchMutationLockCount = 64

var (
	// ErrImportBatchNotDiscardable 表示批次已有或可能已有正式账本影响。
	ErrImportBatchNotDiscardable = errors.New("personal finance import batch cannot be discarded")
	// ErrImportFileContentNotDeletable 表示文件仍处于上传补偿的 pending 状态。
	ErrImportFileContentNotDeletable = errors.New("personal finance import file content cannot be deleted")

	batchMutationLocks [batchMutationLockCount]sync.Mutex
)

// UndoImpactReason 是不包含交易或来源标识的稳定撤销影响原因码。
type UndoImpactReason string

const (
	UNDO_IMPACT_REASON_AUTOMATIC_UNDO_NOT_SUPPORTED UndoImpactReason = "automatic_undo_not_supported"
	UNDO_IMPACT_REASON_TRANSACTION_MISSING          UndoImpactReason = "transaction_missing_or_deleted"
	UNDO_IMPACT_REASON_TRANSACTION_MODIFIED         UndoImpactReason = "transaction_modified"
	UNDO_IMPACT_REASON_TRANSACTION_SHARED           UndoImpactReason = "transaction_shared_across_batches"
	UNDO_IMPACT_REASON_REUSED_TRANSACTION           UndoImpactReason = "reused_transaction_present"
)

// ImportDataStatistics 是数据管理页需要的 PF 聚合计数。
type ImportDataStatistics struct {
	ImportFileCount   int64
	ImportBatchCount  int64
	RawImportRowCount int64
}

// UndoImpact 只描述一个批次对正式账本的聚合影响，不提供撤销能力。
type UndoImpact struct {
	BatchId                  int64
	LinkedTransactionCount   int64
	PostingCreatedCount      int64
	PostingReusedCount       int64
	ModifiedTransactionCount int64
	MissingTransactionCount  int64
	SharedTransactionCount   int64
	ReasonCodes              []UndoImpactReason
}

// UserConsistencyReport 是不包含原始字段、对象 key 或实体 ID 的用户级一致性汇总。
type UserConsistencyReport struct {
	ImportFileCount                  int64 `json:"importFileCount"`
	ImportBatchCount                 int64 `json:"importBatchCount"`
	RawImportRowCount                int64 `json:"rawImportRowCount"`
	BatchCountMismatchCount          int64 `json:"batchCountMismatchCount"`
	OrphanBatchCount                 int64 `json:"orphanBatchCount"`
	OrphanRawRowCount                int64 `json:"orphanRawRowCount"`
	OrphanSourceIdentityCount        int64 `json:"orphanSourceIdentityCount"`
	OrphanPostingCount               int64 `json:"orphanPostingCount"`
	OrphanBatchIssueCount            int64 `json:"orphanBatchIssueCount"`
	OrphanEvidenceLinkCount          int64 `json:"orphanEvidenceLinkCount"`
	MissingOrDeletedTransactionCount int64 `json:"missingOrDeletedTransactionCount"`
	FileContentMismatchCount         int64 `json:"fileContentMismatchCount"`
	FileContentCheckFailureCount     int64 `json:"fileContentCheckFailureCount"`
}

// Healthy 返回该汇总是否没有发现不一致或无法完成的对象校验。
func (r *UserConsistencyReport) Healthy() bool {
	return r != nil && r.BatchCountMismatchCount == 0 && r.OrphanBatchCount == 0 &&
		r.OrphanRawRowCount == 0 && r.OrphanSourceIdentityCount == 0 &&
		r.OrphanPostingCount == 0 && r.OrphanBatchIssueCount == 0 &&
		r.OrphanEvidenceLinkCount == 0 && r.MissingOrDeletedTransactionCount == 0 &&
		r.FileContentMismatchCount == 0 && r.FileContentCheckFailureCount == 0
}

// StorageInventoryReport 是停服运维命令返回的对象分类计数。
type StorageInventoryReport struct {
	RegisteredFinalObjectCount   int64
	UnregisteredFinalObjectCount int64
	TemporaryObjectCount         int64
}

// LifecycleRepository 是 OPS-101 需要的窄持久层契约。
type LifecycleRepository interface {
	FindImportFileById(c core.Context, uid int64, fileId int64) (*ImportFile, error)
	MarkImportFileContentDeleted(c core.Context, uid int64, fileId int64, now int64) (bool, error)
	DiscardImportBatch(c core.Context, uid int64, batchId int64, now int64) (*ImportBatch, error)
	GetUndoImpact(c core.Context, uid int64, batchId int64) (*UndoImpact, error)
	GetImportDataStatistics(c core.Context, uid int64) (*ImportDataStatistics, error)
	ListAllImportFiles(c core.Context, uid int64) ([]*ImportFile, error)
	ClearImportingUserData(c core.Context, uid int64) error
	CheckUserConsistency(c core.Context, uid int64) (*UserConsistencyReport, []*ImportFile, error)
	ListAllRegisteredFinalObjectKeys(c core.Context) (map[string]struct{}, error)
}

// ImportObjectInventory 是停服检查可选消费的存储枚举能力。
type ImportObjectInventory interface {
	ListObjectKeys(c core.Context) ([]string, error)
}

// LifecycleService 提供批次、原文件、用户清理和一致性运维。
type LifecycleService struct {
	repository LifecycleRepository
	storage    ImportFileStorage
	inventory  ImportObjectInventory
	now        func() time.Time
}

// NewLifecycleService 创建运维应用服务；inventory 可空，仅停服对象枚举需要。
func NewLifecycleService(repository LifecycleRepository, storage ImportFileStorage, inventory ImportObjectInventory) (*LifecycleService, error) {
	if repository == nil || storage == nil {
		return nil, ErrImportRequestInvalid
	}

	return &LifecycleService{repository: repository, storage: storage, inventory: inventory, now: time.Now}, nil
}

// DiscardImportBatch 原子废弃完全未影响正式账本的批次。
func (s *LifecycleService) DiscardImportBatch(c core.Context, uid int64, batchId int64) (*ImportBatch, error) {
	if uid < 1 || batchId < 1 {
		return nil, ErrImportRequestInvalid
	}

	unlock := lockBatchMutation(uid, batchId)
	defer unlock()
	batch, err := s.repository.DiscardImportBatch(c, uid, batchId, s.now().Unix())

	if err != nil {
		if errors.Is(err, ErrImportBatchNotFound) || errors.Is(err, ErrImportBatchNotDiscardable) {
			return nil, err
		}
		return nil, ErrImportPersistenceUnavailable
	}

	return batch, nil
}

// DeleteImportFileContent 幂等删除原文件字节并保留全部证据元数据。
func (s *LifecycleService) DeleteImportFileContent(c core.Context, uid int64, fileId int64) (*ImportFile, error) {
	if uid < 1 || fileId < 1 {
		return nil, ErrImportRequestInvalid
	}

	unlock := lockImportFileMutation(uid, fileId)
	defer unlock()
	file, err := s.repository.FindImportFileById(c, uid, fileId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	if file == nil {
		return nil, ErrImportFileNotFound
	}
	if file.ContentState == IMPORT_FILE_CONTENT_STATE_DELETED {
		return file, nil
	}
	if file.ContentState == IMPORT_FILE_CONTENT_STATE_PENDING {
		return nil, ErrImportFileContentNotDeletable
	}
	if err = s.storage.Delete(c, file.StorageObjectKey); err != nil {
		return nil, ErrImportStorageUnavailable
	}

	now := s.now().Unix()
	changed, err := s.repository.MarkImportFileContentDeleted(c, uid, fileId, now)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	if !changed {
		current, findErr := s.repository.FindImportFileById(c, uid, fileId)
		if findErr != nil || current == nil || current.ContentState != IMPORT_FILE_CONTENT_STATE_DELETED {
			return nil, ErrImportPersistenceUnavailable
		}
		return current, nil
	}

	file.ContentState = IMPORT_FILE_CONTENT_STATE_DELETED
	file.UpdatedUnixTime = now
	file.ContentDeletedUnixTime = &now
	return file, nil
}

// GetUndoImpact 返回只读聚合影响。
func (s *LifecycleService) GetUndoImpact(c core.Context, uid int64, batchId int64) (*UndoImpact, error) {
	if uid < 1 || batchId < 1 {
		return nil, ErrImportRequestInvalid
	}
	impact, err := s.repository.GetUndoImpact(c, uid, batchId)
	if err != nil {
		if errors.Is(err, ErrImportBatchNotFound) {
			return nil, err
		}
		return nil, ErrImportPersistenceUnavailable
	}
	return impact, nil
}

// GetImportDataStatistics 返回数据管理页的 PF 数量。
func (s *LifecycleService) GetImportDataStatistics(c core.Context, uid int64) (*ImportDataStatistics, error) {
	if uid < 1 {
		return nil, ErrImportRequestInvalid
	}
	statistics, err := s.repository.GetImportDataStatistics(c, uid)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	return statistics, nil
}

// DeleteRegisteredObjects 幂等删除当前 uid 已登记的最终对象，不改数据库行。
func (s *LifecycleService) DeleteRegisteredObjects(c core.Context, uid int64) error {
	if uid < 1 {
		return ErrImportRequestInvalid
	}
	files, err := s.repository.ListAllImportFiles(c, uid)
	if err != nil {
		return ErrImportPersistenceUnavailable
	}
	for _, file := range files {
		if file == nil || file.Uid != uid {
			return ErrImportEvidenceUnavailable
		}
		if err = s.storage.Delete(c, file.StorageObjectKey); err != nil {
			return ErrImportStorageUnavailable
		}
	}
	return nil
}

// ClearUserData 先删已登记最终对象，再清理 importing 用户表。全部 pf_ 用户表由 core 钩子清空。
func (s *LifecycleService) ClearUserData(c core.Context, uid int64) error {
	if err := s.DeleteRegisteredObjects(c, uid); err != nil {
		return err
	}
	if err := s.repository.ClearImportingUserData(c, uid); err != nil {
		return ErrImportPersistenceUnavailable
	}
	return nil
}

// CheckUserConsistency 核对用户关系、批次计数和已登记对象状态。
func (s *LifecycleService) CheckUserConsistency(c core.Context, uid int64) (*UserConsistencyReport, error) {
	if uid < 1 {
		return nil, ErrImportRequestInvalid
	}
	report, files, err := s.repository.CheckUserConsistency(c, uid)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	for _, file := range files {
		if (file.ContentState == IMPORT_FILE_CONTENT_STATE_DELETED) != (file.ContentDeletedUnixTime != nil) {
			report.FileContentMismatchCount++
		}
		valid, verifyErr := s.storage.Verify(c, file.StorageObjectKey, file.FileSha256, file.FileSize)
		if verifyErr != nil {
			report.FileContentCheckFailureCount++
			continue
		}
		expectedPresent := file.ContentState == IMPORT_FILE_CONTENT_STATE_AVAILABLE
		if valid != expectedPresent {
			report.FileContentMismatchCount++
		}
	}
	return report, nil
}

// CheckStorageInventory 在停服条件下枚举对象并与全部登记最终对象核对。
func (s *LifecycleService) CheckStorageInventory(c core.Context) (*StorageInventoryReport, error) {
	if s.inventory == nil {
		return nil, ErrImportStorageUnavailable
	}
	registered, err := s.repository.ListAllRegisteredFinalObjectKeys(c)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	keys, err := s.inventory.ListObjectKeys(c)
	if err != nil {
		return nil, ErrImportStorageUnavailable
	}
	report := &StorageInventoryReport{RegisteredFinalObjectCount: int64(len(registered))}
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		if strings.HasPrefix(key, temporaryObjectKeyPrefix+"/") {
			report.TemporaryObjectCount++
			continue
		}
		if strings.HasPrefix(key, availableObjectKeyPrefix+"/") {
			if _, ok := registered[key]; !ok {
				report.UnregisteredFinalObjectCount++
			}
		} else {
			report.UnregisteredFinalObjectCount++
		}
	}
	return report, nil
}

func lockBatchMutation(uid int64, batchId int64) func() {
	index := uint64(uid) ^ uint64(batchId)*0x9e3779b97f4a7c15
	lock := &batchMutationLocks[index%batchMutationLockCount]
	lock.Lock()
	return lock.Unlock
}

func sortedUndoReasons(reasonSet map[UndoImpactReason]struct{}) []UndoImpactReason {
	reasons := make([]UndoImpactReason, 0, len(reasonSet))
	for reason := range reasonSet {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(i, j int) bool { return reasons[i] < reasons[j] })
	return reasons
}
