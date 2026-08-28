package importing

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net"
	"path"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

const (
	defaultImportPageSize        = int32(20)
	maximumImportPageSize        = int32(100)
	temporaryObjectKeyPrefix     = "temporary"
	availableObjectKeyPrefix     = "objects"
	opaqueObjectKeyRandomBytes   = 32
	maximumStateTransitionReload = 4
	importFileMutationLockCount  = 64
)

var (
	// ErrImportRequestInvalid 表示请求元数据或分页参数无效。
	ErrImportRequestInvalid = errors.New("personal finance import request is invalid")
	// ErrImportFileNotFound 对当前 uid 隐藏不存在或不属于该用户的文件。
	ErrImportFileNotFound = errors.New("personal finance import file is not found")
	// ErrImportBatchNotFound 对当前 uid 隐藏不存在或不属于该用户的批次。
	ErrImportBatchNotFound = errors.New("personal finance import batch is not found")
	// ErrImportPersistenceUnavailable 是不包含 SQL 或绑定参数的稳定持久层错误。
	ErrImportPersistenceUnavailable = errors.New("personal finance import persistence is unavailable")
	// ErrImportStorageUnavailable 是不包含对象内容、文件名或 key 的稳定存储错误。
	ErrImportStorageUnavailable = errors.New("personal finance import storage is unavailable")
	// ErrImportIdentifierUnavailable 表示无法生成新的共享 PF ID 或不透明对象 key。
	ErrImportIdentifierUnavailable = errors.New("personal finance import identifier is unavailable")
	// ErrImportEvidenceUnavailable 表示持久证据结构损坏，不能安全返回。
	ErrImportEvidenceUnavailable = errors.New("personal finance import evidence is unavailable")

	// 正常部署只有一个应用实例；分片锁防止同一最终对象被并发覆盖时产生半写完成态。
	importFileMutationLocks [importFileMutationLockCount]sync.Mutex
)

// ImportRepository 是导入应用服务消费的最小持久层契约。
// Repository 的每一个实现都必须在所有查询和更新中同时限定 uid。
type ImportRepository interface {
	FindImportFileById(c core.Context, uid int64, fileId int64) (*ImportFile, error)
	FindImportFileBySHA256(c core.Context, uid int64, fileSHA256 string) (*ImportFile, error)
	InsertImportFile(c core.Context, file *ImportFile) error
	UpdateImportFileContentState(c core.Context, uid int64, fileId int64, expectedStates []ImportFileContentState, nextState ImportFileContentState, updatedUnixTime int64) (bool, error)
	ListImportFiles(c core.Context, uid int64, offset int, limit int) ([]*ImportFile, int64, error)
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*ImportBatch, error)
	FindCardHeaderByBatch(c core.Context, uid int64, batchId int64) (*CardHeader, error)
	ListImportBatches(c core.Context, uid int64, fileId int64, offset int, limit int) ([]*ImportBatch, int64, error)
	ListImportBatchIssues(c core.Context, uid int64, batchId int64) ([]*ImportBatchIssue, error)
	ListRawImportRowsPage(c core.Context, uid int64, batchId int64, offset int, limit int) ([]*RawImportRow, int64, error)
}

// ImportFileStorage 描述对象存储无法与数据库共享事务时所需的最小补偿能力。
// Promote 必须把 temporaryObjectKey 的完整字节复制到 availableObjectKey。
type ImportFileStorage interface {
	SaveTemporary(c core.Context, temporaryObjectKey string, content []byte) error
	Promote(c core.Context, temporaryObjectKey string, availableObjectKey string) error
	Verify(c core.Context, objectKey string, expectedSHA256 string, expectedSize int64) (bool, error)
	Delete(c core.Context, objectKey string) error
}

// ImportService 编排原文件存储补偿与只读导入查询。
type ImportService struct {
	repository ImportRepository
	storage    ImportFileStorage
	generateId func() int64
	now        func() time.Time
	randomHex  func(int) (string, error)
}

// ImportFileUpload 保存一次原始上传；Content 在任何解析或转码前参与 SHA-256。
type ImportFileUpload struct {
	Uid              int64
	OriginalFileName string
	MimeType         string
	CreatedIp        string
	Content          []byte
}

// ImportFileUploadResult 描述持久文件身份及是否命中已有内容。
type ImportFileUploadResult struct {
	File      *ImportFile
	Duplicate bool
	Recovered bool
}

// ImportFilePage 是稳定排序的原文件分页结果。
type ImportFilePage struct {
	Items      []*ImportFile
	TotalCount int64
}

// ImportBatchDetails 把批次与其同 uid 原文件元数据组合起来。
type ImportBatchDetails struct {
	Batch      *ImportBatch
	CardHeader *CardHeader
	File       *ImportFile
	Issues     []*ImportBatchIssue
}

// ImportBatchPage 是稳定排序的批次分页结果。
type ImportBatchPage struct {
	Items      []*ImportBatchDetails
	TotalCount int64
}

// RawImportRowPage 是稳定排序的原始行分页结果。
type RawImportRowPage struct {
	Batch      *ImportBatchDetails
	Items      []*RawImportRow
	TotalCount int64
}

// NewImportService 创建导入应用服务。
func NewImportService(repository ImportRepository, objectStorage ImportFileStorage, generateId func() int64) (*ImportService, error) {
	if repository == nil || objectStorage == nil || generateId == nil {
		return nil, ErrImportRequestInvalid
	}

	return &ImportService{
		repository: repository,
		storage:    objectStorage,
		generateId: generateId,
		now:        time.Now,
		randomHex:  newRandomHex,
	}, nil
}

// UploadImportFile 先对原始字节计算 SHA-256，再执行对象存储与数据库之间的补偿状态机。
func (s *ImportService) UploadImportFile(c core.Context, upload ImportFileUpload) (*ImportFileUploadResult, error) {
	normalizedUpload, err := normalizeImportFileUpload(upload)

	if err != nil {
		return nil, err
	}

	digest := sha256.Sum256(normalizedUpload.Content)
	fileSHA256 := hex.EncodeToString(digest[:])
	file, err := s.repository.FindImportFileBySHA256(c, normalizedUpload.Uid, fileSHA256)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	duplicate := file != nil
	recovered := file != nil && file.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE
	var unlockFileMutation func()

	if file != nil {
		unlockFileMutation = lockImportFileMutation(file.Uid, file.FileId)
		defer unlockFileMutation()

		file, err = s.reloadImportFileForUpload(c, normalizedUpload.Uid, file.FileId, fileSHA256)

		if err != nil {
			return nil, err
		}

		recovered = file.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE
	}

	if file != nil && file.ContentState == IMPORT_FILE_CONTENT_STATE_AVAILABLE {
		valid, verifyErr := s.storage.Verify(c, file.StorageObjectKey, file.FileSha256, file.FileSize)

		if verifyErr != nil {
			return nil, ErrImportStorageUnavailable
		}

		if valid {
			return s.importFileUploadResult(c, file, true, false)
		}

		changed, updateErr := s.repository.UpdateImportFileContentState(
			c,
			file.Uid,
			file.FileId,
			[]ImportFileContentState{IMPORT_FILE_CONTENT_STATE_AVAILABLE},
			IMPORT_FILE_CONTENT_STATE_MISSING,
			s.now().Unix(),
		)

		if updateErr != nil {
			return nil, ErrImportPersistenceUnavailable
		}

		if changed {
			file.ContentState = IMPORT_FILE_CONTENT_STATE_MISSING
		}

		recovered = true
	}

	temporaryObjectKey, err := s.newObjectKey(temporaryObjectKeyPrefix)

	if err != nil {
		return nil, ErrImportIdentifierUnavailable
	}

	if err := s.storage.SaveTemporary(c, temporaryObjectKey, normalizedUpload.Content); err != nil {
		_ = s.storage.Delete(c, temporaryObjectKey)
		return nil, ErrImportStorageUnavailable
	}

	temporaryValid, err := s.storage.Verify(c, temporaryObjectKey, fileSHA256, int64(len(normalizedUpload.Content)))

	if err != nil || !temporaryValid {
		_ = s.storage.Delete(c, temporaryObjectKey)
		return nil, ErrImportStorageUnavailable
	}

	defer func() {
		_ = s.storage.Delete(c, temporaryObjectKey)
	}()

	if file == nil {
		file, err = s.createPendingImportFile(c, normalizedUpload, fileSHA256)

		if err != nil {
			if errors.Is(err, ErrImportIdentifierUnavailable) {
				return nil, err
			}

			// 并发插入由 uid + SHA-256 唯一约束裁决；失败后只读取同 uid 的赢家。
			file, err = s.repository.FindImportFileBySHA256(c, normalizedUpload.Uid, fileSHA256)

			if err != nil || file == nil {
				return nil, ErrImportPersistenceUnavailable
			}

			duplicate = true
		}
	}

	if unlockFileMutation == nil {
		unlockFileMutation = lockImportFileMutation(file.Uid, file.FileId)
		defer unlockFileMutation()

		file, err = s.reloadImportFileForUpload(c, normalizedUpload.Uid, file.FileId, fileSHA256)

		if err != nil {
			return nil, err
		}
	}

	alreadyAvailable, err := s.ensureImportFilePending(c, file)

	if err != nil {
		return nil, err
	}

	if alreadyAvailable {
		return s.importFileUploadResult(c, file, true, recovered)
	}

	if err := s.storage.Promote(c, temporaryObjectKey, file.StorageObjectKey); err != nil {
		s.markImportFileFailed(c, file)
		return nil, ErrImportStorageUnavailable
	}

	availableValid, err := s.storage.Verify(c, file.StorageObjectKey, file.FileSha256, file.FileSize)

	if err != nil || !availableValid {
		s.markImportFileFailed(c, file)
		return nil, ErrImportStorageUnavailable
	}

	updatedUnixTime := s.now().Unix()
	changed, err := s.repository.UpdateImportFileContentState(
		c,
		file.Uid,
		file.FileId,
		[]ImportFileContentState{IMPORT_FILE_CONTENT_STATE_PENDING},
		IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		updatedUnixTime,
	)

	if err != nil {
		// 最终对象已经可恢复；数据库仍保持 pending，下一次同哈希重传可重试收口。
		return nil, ErrImportPersistenceUnavailable
	}

	if !changed {
		current, findErr := s.repository.FindImportFileById(c, file.Uid, file.FileId)

		if findErr != nil || current == nil || current.Uid != file.Uid || current.FileId != file.FileId ||
			current.FileSha256 != file.FileSha256 || current.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE {
			return nil, ErrImportPersistenceUnavailable
		}

		valid, verifyErr := s.storage.Verify(c, current.StorageObjectKey, current.FileSha256, current.FileSize)

		if verifyErr != nil || !valid {
			return nil, ErrImportStorageUnavailable
		}

		file = current
	} else {
		file.ContentState = IMPORT_FILE_CONTENT_STATE_AVAILABLE
		file.UpdatedUnixTime = updatedUnixTime
	}

	return s.importFileUploadResult(c, file, duplicate, recovered)
}

// GetImportFile 按 uid 查询文件，不泄露其他用户是否拥有相同 ID。
func (s *ImportService) GetImportFile(c core.Context, uid int64, fileId int64) (*ImportFile, error) {
	if uid < 1 || fileId < 1 {
		return nil, ErrImportRequestInvalid
	}

	file, err := s.repository.FindImportFileById(c, uid, fileId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if file == nil {
		return nil, ErrImportFileNotFound
	}

	return file, nil
}

// ListImportFiles 返回当前 uid 的稳定分页文件列表。
func (s *ImportService) ListImportFiles(c core.Context, uid int64, page int32, count int32) (*ImportFilePage, error) {
	offset, limit, err := importPageOffset(page, count)

	if uid < 1 || err != nil {
		return nil, ErrImportRequestInvalid
	}

	files, totalCount, err := s.repository.ListImportFiles(c, uid, offset, limit)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return &ImportFilePage{Items: files, TotalCount: totalCount}, nil
}

// GetImportBatch 返回批次及同 uid 文件元数据。
func (s *ImportService) GetImportBatch(c core.Context, uid int64, batchId int64) (*ImportBatchDetails, error) {
	if uid < 1 || batchId < 1 {
		return nil, ErrImportRequestInvalid
	}

	batch, err := s.repository.FindImportBatchById(c, uid, batchId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if batch == nil {
		return nil, ErrImportBatchNotFound
	}

	file, err := s.repository.FindImportFileById(c, uid, batch.FileId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if file == nil {
		return nil, ErrImportEvidenceUnavailable
	}

	issues, err := s.repository.ListImportBatchIssues(c, uid, batchId)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	header, err := s.repository.FindCardHeaderByBatch(c, uid, batchId)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return &ImportBatchDetails{Batch: batch, CardHeader: header, File: file, Issues: issues}, nil
}

// ListImportBatches 返回当前 uid 的批次历史；fileId=0 表示不限定文件。
func (s *ImportService) ListImportBatches(c core.Context, uid int64, fileId int64, page int32, count int32) (*ImportBatchPage, error) {
	offset, limit, err := importPageOffset(page, count)

	if uid < 1 || fileId < 0 || err != nil {
		return nil, ErrImportRequestInvalid
	}

	if fileId > 0 {
		if _, err := s.GetImportFile(c, uid, fileId); err != nil {
			return nil, err
		}
	}

	batches, totalCount, err := s.repository.ListImportBatches(c, uid, fileId, offset, limit)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	items := make([]*ImportBatchDetails, 0, len(batches))
	files := make(map[int64]*ImportFile)

	for _, batch := range batches {
		file := files[batch.FileId]

		if file == nil {
			file, err = s.repository.FindImportFileById(c, uid, batch.FileId)

			if err != nil {
				return nil, ErrImportPersistenceUnavailable
			}

			if file == nil {
				return nil, ErrImportEvidenceUnavailable
			}

			files[batch.FileId] = file
		}

		items = append(items, &ImportBatchDetails{Batch: batch, File: file})
	}

	for _, item := range items {
		header, err := s.repository.FindCardHeaderByBatch(c, uid, item.Batch.BatchId)
		if err != nil {
			return nil, ErrImportPersistenceUnavailable
		}
		item.CardHeader = header
	}

	return &ImportBatchPage{Items: items, TotalCount: totalCount}, nil
}

// ListRawImportRows 返回当前 uid 批次的稳定分页原始行。
// includeRawSnapshot=false 时调用方必须省略 RawFieldsJson 与 IssuesJson。
func (s *ImportService) ListRawImportRows(c core.Context, uid int64, batchId int64, page int32, count int32, includeRawSnapshot bool) (*RawImportRowPage, error) {
	offset, limit, err := importPageOffset(page, count)

	if uid < 1 || batchId < 1 || err != nil {
		return nil, ErrImportRequestInvalid
	}

	details, err := s.GetImportBatch(c, uid, batchId)

	if err != nil {
		return nil, err
	}

	rows, totalCount, err := s.repository.ListRawImportRowsPage(c, uid, batchId, offset, limit)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if includeRawSnapshot {
		for _, row := range rows {
			if len(row.RawFieldsJson) > MaxRawFieldsJSONBytes || len(row.IssuesJson) > MaxIssuesJSONBytes ||
				!json.Valid([]byte(row.RawFieldsJson)) || !json.Valid([]byte(row.IssuesJson)) {
				return nil, ErrImportEvidenceUnavailable
			}
		}
	} else {
		for _, row := range rows {
			row.RawFieldsJson = ""
			row.IssuesJson = ""
		}
	}

	return &RawImportRowPage{Batch: details, Items: rows, TotalCount: totalCount}, nil
}

func (s *ImportService) createPendingImportFile(c core.Context, upload ImportFileUpload, fileSHA256 string) (*ImportFile, error) {
	fileId := s.generateId()

	if fileId < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	storageObjectKey, err := s.newObjectKey(availableObjectKeyPrefix)

	if err != nil {
		return nil, ErrImportIdentifierUnavailable
	}

	now := s.now().Unix()
	file := &ImportFile{
		Uid:              upload.Uid,
		ContentState:     IMPORT_FILE_CONTENT_STATE_PENDING,
		OriginalFileName: upload.OriginalFileName,
		FileSize:         int64(len(upload.Content)),
		FileSha256:       fileSHA256,
		MimeType:         upload.MimeType,
		FileExtension:    importFileExtension(upload.OriginalFileName),
		StorageObjectKey: storageObjectKey,
		CreatedIp:        upload.CreatedIp,
		CreatedUnixTime:  now,
		UpdatedUnixTime:  now,
		FileId:           fileId,
	}

	if err := s.repository.InsertImportFile(c, file); err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return file, nil
}

func (s *ImportService) reloadImportFileForUpload(c core.Context, uid int64, fileId int64, expectedSHA256 string) (*ImportFile, error) {
	file, err := s.repository.FindImportFileById(c, uid, fileId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if file == nil {
		return nil, ErrImportFileNotFound
	}

	if file.Uid != uid || file.FileId != fileId || file.FileSha256 != expectedSHA256 {
		return nil, ErrImportEvidenceUnavailable
	}

	return file, nil
}

func (s *ImportService) ensureImportFilePending(c core.Context, file *ImportFile) (bool, error) {
	for attempt := 0; attempt < maximumStateTransitionReload; attempt++ {
		switch file.ContentState {
		case IMPORT_FILE_CONTENT_STATE_PENDING:
			return false, nil
		case IMPORT_FILE_CONTENT_STATE_AVAILABLE:
			valid, err := s.storage.Verify(c, file.StorageObjectKey, file.FileSha256, file.FileSize)

			if err != nil {
				return false, ErrImportStorageUnavailable
			}

			if valid {
				return true, nil
			}

			changed, err := s.repository.UpdateImportFileContentState(
				c,
				file.Uid,
				file.FileId,
				[]ImportFileContentState{IMPORT_FILE_CONTENT_STATE_AVAILABLE},
				IMPORT_FILE_CONTENT_STATE_MISSING,
				s.now().Unix(),
			)

			if err != nil {
				return false, ErrImportPersistenceUnavailable
			}

			if changed {
				file.ContentState = IMPORT_FILE_CONTENT_STATE_MISSING
			}
		case IMPORT_FILE_CONTENT_STATE_MISSING, IMPORT_FILE_CONTENT_STATE_FAILED, IMPORT_FILE_CONTENT_STATE_DELETED:
			wasDeleted := file.ContentState == IMPORT_FILE_CONTENT_STATE_DELETED
			changed, err := s.repository.UpdateImportFileContentState(
				c,
				file.Uid,
				file.FileId,
				[]ImportFileContentState{file.ContentState},
				IMPORT_FILE_CONTENT_STATE_PENDING,
				s.now().Unix(),
			)

			if err != nil {
				return false, ErrImportPersistenceUnavailable
			}

			if changed {
				file.ContentState = IMPORT_FILE_CONTENT_STATE_PENDING

				if wasDeleted {
					file.ContentDeletedUnixTime = nil
				}

				return false, nil
			}
		default:
			return false, ErrImportEvidenceUnavailable
		}

		current, err := s.repository.FindImportFileById(c, file.Uid, file.FileId)

		if err != nil {
			return false, ErrImportPersistenceUnavailable
		}

		if current == nil {
			return false, ErrImportFileNotFound
		}

		*file = *current
	}

	return false, ErrImportPersistenceUnavailable
}

func (s *ImportService) markImportFileFailed(c core.Context, file *ImportFile) {
	changed, err := s.repository.UpdateImportFileContentState(
		c,
		file.Uid,
		file.FileId,
		[]ImportFileContentState{IMPORT_FILE_CONTENT_STATE_PENDING},
		IMPORT_FILE_CONTENT_STATE_FAILED,
		s.now().Unix(),
	)

	if err == nil && changed {
		file.ContentState = IMPORT_FILE_CONTENT_STATE_FAILED
	}
}

func (s *ImportService) importFileUploadResult(c core.Context, file *ImportFile, duplicate bool, recovered bool) (*ImportFileUploadResult, error) {
	return &ImportFileUploadResult{
		File:      file,
		Duplicate: duplicate,
		Recovered: recovered,
	}, nil
}

func (s *ImportService) newObjectKey(prefix string) (string, error) {
	opaque, err := s.randomHex(opaqueObjectKeyRandomBytes)

	if err != nil {
		return "", err
	}

	if !isLowerHexSHA256(opaque) {
		return "", ErrImportIdentifierUnavailable
	}

	return path.Join(prefix, opaque), nil
}

func normalizeImportFileUpload(upload ImportFileUpload) (ImportFileUpload, error) {
	if upload.Uid < 1 || len(upload.Content) < 1 {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	fileName := strings.ReplaceAll(upload.OriginalFileName, "\\", "/")
	fileName = path.Base(fileName)

	if fileName == "" || fileName == "." || fileName == ".." || fileName == "/" ||
		!utf8.ValidString(fileName) || utf8.RuneCountInString(fileName) > 255 {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	for _, char := range fileName {
		if unicode.IsControl(char) {
			return ImportFileUpload{}, ErrImportRequestInvalid
		}
	}

	extension := importFileExtension(fileName)

	if len(extension) > 16 || !isSafeFileExtension(extension) {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	mimeType := strings.TrimSpace(upload.MimeType)

	if mimeType == "" || len(mimeType) > 127 || !utf8.ValidString(mimeType) {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	if _, _, err := mime.ParseMediaType(mimeType); err != nil {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	createdIp := net.ParseIP(strings.TrimSpace(upload.CreatedIp))

	if createdIp == nil {
		return ImportFileUpload{}, ErrImportRequestInvalid
	}

	upload.OriginalFileName = fileName
	upload.MimeType = mimeType
	upload.CreatedIp = createdIp.String()
	return upload, nil
}

func importFileExtension(fileName string) string {
	extension := strings.TrimPrefix(path.Ext(fileName), ".")
	return strings.ToLower(extension)
}

func isSafeFileExtension(extension string) bool {
	for _, char := range extension {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return false
		}
	}

	return true
}

// importPageOffset 沿用仓库列表约定：page=0 是缺省第一页，显式第一页为 page=1。
func importPageOffset(page int32, count int32) (int, int, error) {
	if page < 0 {
		return 0, 0, ErrImportRequestInvalid
	}

	if page == 0 {
		page = 1
	}

	if count == 0 {
		count = defaultImportPageSize
	}

	if count < 1 || count > maximumImportPageSize {
		return 0, 0, ErrImportRequestInvalid
	}

	offset := int64(page-1) * int64(count)
	maximumInt := int64(^uint(0) >> 1)

	if offset > maximumInt {
		return 0, 0, ErrImportRequestInvalid
	}

	return int(offset), int(count), nil
}

func newRandomHex(byteCount int) (string, error) {
	if byteCount < 1 {
		return "", ErrImportIdentifierUnavailable
	}

	random := make([]byte, byteCount)

	if _, err := rand.Read(random); err != nil {
		return "", err
	}

	return hex.EncodeToString(random), nil
}

func lockImportFileMutation(uid int64, fileId int64) func() {
	stripe := (uint64(uid)*11400714819323198485 ^ uint64(fileId)) % importFileMutationLockCount
	mutex := &importFileMutationLocks[stripe]
	mutex.Lock()
	return mutex.Unlock
}
