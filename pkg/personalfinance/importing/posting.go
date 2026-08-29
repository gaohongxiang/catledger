package importing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"net"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/utils"
)

const (
	minimumPostingIdempotencyKeyBytes = 8
	maximumPostingIdempotencyKeyBytes = 128
	maximumPostingSelectedRows        = 1000
)

var (
	ErrImportPostingRequestInvalid      = errors.New("personal finance import posting request is invalid")
	ErrImportPostingBatchNotFound       = errors.New("personal finance import posting batch is not found")
	ErrImportPostingIdempotencyConflict = errors.New("personal finance import posting idempotency conflict")
	ErrImportPostingPreviouslyFailed    = errors.New("personal finance import posting previously failed")
	ErrImportPostingNotAvailable        = errors.New("personal finance import posting is not available")
	ErrImportPostingEvidenceInvalid     = errors.New("personal finance import posting evidence is invalid")
	ErrImportPostingAuthorizationFailed = errors.New("personal finance import posting authorization failed")
	ErrImportPostingLedgerRejected      = errors.New("personal finance import posting ledger rejected")

	errPostingBatchNotFound   = errors.New("posting batch is not found")
	errPostingClaimLost       = errors.New("posting claim was not acquired")
	errPostingRowsInvalid     = errors.New("posting rows are invalid")
	errPostingEvidenceInvalid = errors.New("posting evidence relationship is invalid")
	errPostingIdentifier      = errors.New("posting identifier is unavailable")
	errPostingPersistence     = errors.New("posting persistence is unavailable")
)

// LedgerTransactionDraft 只包含确认入账允许提交给核心账本的字段。
type LedgerTransactionDraft struct {
	Type                 models.TransactionType
	CategoryId           int64
	UnixTime             int64
	TimezoneUtcOffset    int16
	SourceAccountId      int64
	DestinationAccountId int64
	SourceAmount         int64
	DestinationAmount    int64
	HideAmount           bool
	TagIds               []int64
	Comment              string
	AllowUncategorized   bool
}

// PostingIdentityCommand 把同一来源身份的一组原始行绑定为一个逻辑账本事件。
// Draft=nil 表示只允许复用已经存在的正式交易关系。
type PostingIdentityCommand struct {
	RowIds     []int64
	Draft      *LedgerTransactionDraft
	AutoPosted bool
}

// PostImportBatchRequest 表示一次持久幂等确认请求。
type PostImportBatchRequest struct {
	Uid            int64
	BatchId        int64
	IdempotencyKey string
	CreatedIp      string
	Commands       []PostingIdentityCommand
}

// ImportPostingResult 返回稳定结果；Replayed 表示命中既有 completed 记录。
type ImportPostingResult struct {
	Posting  *ImportPosting
	Replayed bool
}

// TransactionEvidenceItem 是一条正式交易关系及其原始行、批次和文件上下文。
type TransactionEvidenceItem struct {
	Link  *RawRowTransactionLink
	Row   *RawImportRow
	Batch *ImportBatch
	File  *ImportFile
}

// TransactionEvidenceResult 是按正式交易反查得到的不可变证据集合。
type TransactionEvidenceResult struct {
	TransactionId int64
	Items         []*TransactionEvidenceItem
}

// PostingAuthorization 在账本事务前执行现有用户与编辑范围校验。
type PostingAuthorization interface {
	AuthorizeTransactionCreation(c core.Context, uid int64, clientTimezone *time.Location, transactions []*models.Transaction) error
}

// PostingLedgerWriter 在 repository 已有隐私事务中写正式账本，不得提交或回滚。
type PostingLedgerWriter interface {
	CreateTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft *models.Transaction, tagIds []int64) (*models.Transaction, *models.Transaction, error)
}

// PostingRepository 是确认入账服务所需的最小持久层契约。
type PostingRepository interface {
	CreateOrFindImportPosting(c core.Context, candidate *ImportPosting) (*ImportPosting, bool, error)
	ExecuteImportPosting(c core.Context, execution *postingExecution, ledger PostingLedgerWriter, generateId func() int64, now int64) (*ImportPosting, error)
	MarkImportPostingFailed(c core.Context, uid int64, postingId int64, errorCode string, now int64) error
	ListTransactionEvidence(c core.Context, uid int64, transactionId int64) ([]*TransactionEvidenceItem, error)
}

type postingExecution struct {
	Uid       int64
	BatchId   int64
	PostingId int64
	Commands  []postingExecutionCommand
}

type postingExecutionCommand struct {
	RowIds      []int64
	Transaction *models.Transaction
	TagIds      []int64
	AutoPosted  bool
}

// PostingService 编排持久幂等、跨库权限预检与单库原子入账。
type PostingService struct {
	repository PostingRepository
	authorizer PostingAuthorization
	ledger     PostingLedgerWriter
	generateId func() int64
	now        func() time.Time
}

// NewPostingService 创建确认入账应用服务。
func NewPostingService(repository PostingRepository, authorizer PostingAuthorization, ledger PostingLedgerWriter, generateId func() int64) (*PostingService, error) {
	if repository == nil || authorizer == nil || ledger == nil || generateId == nil {
		return nil, ErrImportPostingRequestInvalid
	}

	return &PostingService{
		repository: repository,
		authorizer: authorizer,
		ledger:     ledger,
		generateId: generateId,
		now:        time.Now,
	}, nil
}

// PostImportBatch 原子创建或复用正式交易并写入全部证据关系。
func (s *PostingService) PostImportBatch(c core.Context, request PostImportBatchRequest, clientTimezone *time.Location) (*ImportPostingResult, error) {
	execution, keyDigest, requestDigest, selectedRows, err := normalizePostingRequest(request)

	if err != nil || clientTimezone == nil {
		return nil, ErrImportPostingRequestInvalid
	}

	// 正常部署为单应用实例；与废弃动作共用批次分片锁，避免在“无 posting”
	// 核对和持久 posting 之间产生进程内竞态。数据库条件更新仍是最终状态裁决。
	unlockBatch := lockBatchMutation(request.Uid, request.BatchId)
	defer unlockBatch()

	postingId := s.generateId()
	now := s.now().Unix()

	if postingId < 1 || now < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	candidate := &ImportPosting{
		Uid:                   request.Uid,
		BatchId:               request.BatchId,
		IdempotencyKeyDigest:  keyDigest,
		IdempotencyKeyVersion: IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest:         requestDigest,
		RequestDigestVersion:  POSTING_REQUEST_VERSION_V1,
		Status:                IMPORT_POSTING_STATUS_READY,
		SelectedRowCount:      int64(selectedRows),
		CreatedUnixTime:       now,
		UpdatedUnixTime:       now,
		PostingId:             postingId,
	}
	persisted, created, err := s.repository.CreateOrFindImportPosting(c, candidate)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if err = validatePersistedPosting(persisted, candidate); err != nil {
		return nil, err
	}

	execution.PostingId = persisted.PostingId

	if !created {
		switch persisted.Status {
		case IMPORT_POSTING_STATUS_COMPLETED:
			return &ImportPostingResult{Posting: persisted, Replayed: true}, nil
		case IMPORT_POSTING_STATUS_FAILED:
			return &ImportPostingResult{Posting: persisted, Replayed: true}, ErrImportPostingPreviouslyFailed
		case IMPORT_POSTING_STATUS_READY:
		default:
			return nil, ErrImportPostingNotAvailable
		}
	}

	transactions := make([]*models.Transaction, 0, len(execution.Commands))

	for index := range execution.Commands {
		if execution.Commands[index].Transaction != nil {
			transactions = append(transactions, execution.Commands[index].Transaction)
		}
	}

	if err = s.authorizer.AuthorizeTransactionCreation(c, request.Uid, clientTimezone, transactions); err != nil {
		if markErr := s.repository.MarkImportPostingFailed(c, request.Uid, persisted.PostingId, "authorization_failed", now); markErr != nil {
			return nil, ErrImportPersistenceUnavailable
		}

		return nil, ErrImportPostingAuthorizationFailed
	}

	completed, err := s.repository.ExecuteImportPosting(c, execution, s.ledger, s.generateId, now)

	if err == nil {
		return &ImportPostingResult{Posting: completed}, nil
	}

	publicError, failureCode := classifyPostingExecutionError(err)

	if markErr := s.repository.MarkImportPostingFailed(c, request.Uid, persisted.PostingId, failureCode, now); markErr != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return nil, publicError
}

// GetTransactionEvidence 按 uid 和正式交易 ID 返回原始证据下钻信息。
func (s *PostingService) GetTransactionEvidence(c core.Context, uid int64, transactionId int64) (*TransactionEvidenceResult, error) {
	if uid < 1 || transactionId < 1 {
		return nil, ErrImportPostingRequestInvalid
	}

	items, err := s.repository.ListTransactionEvidence(c, uid, transactionId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return &TransactionEvidenceResult{TransactionId: transactionId, Items: items}, nil
}

func normalizePostingRequest(request PostImportBatchRequest) (*postingExecution, string, string, int, error) {
	if request.Uid < 1 || request.BatchId < 1 || !isValidPostingIdempotencyKey(request.IdempotencyKey) ||
		net.ParseIP(request.CreatedIp) == nil || len(request.Commands) < 1 {
		return nil, "", "", 0, ErrImportPostingRequestInvalid
	}

	commands := make([]postingExecutionCommand, len(request.Commands))
	allRows := make(map[int64]struct{})
	selectedRows := 0

	for index, command := range request.Commands {
		if len(command.RowIds) < 1 {
			return nil, "", "", 0, ErrImportPostingRequestInvalid
		}

		rowIds := append([]int64(nil), command.RowIds...)
		sort.Slice(rowIds, func(left, right int) bool { return rowIds[left] < rowIds[right] })

		for rowIndex, rowId := range rowIds {
			if rowId < 1 || (rowIndex > 0 && rowIds[rowIndex-1] == rowId) {
				return nil, "", "", 0, ErrImportPostingRequestInvalid
			}

			if _, exists := allRows[rowId]; exists {
				return nil, "", "", 0, ErrImportPostingRequestInvalid
			}

			allRows[rowId] = struct{}{}
		}

		commands[index].RowIds = rowIds
		commands[index].AutoPosted = command.AutoPosted
		selectedRows += len(rowIds)

		if selectedRows > maximumPostingSelectedRows {
			return nil, "", "", 0, ErrImportPostingRequestInvalid
		}

		if command.Draft != nil {
			transaction, tagIds, err := buildPostingTransaction(request.Uid, request.CreatedIp, command.Draft)

			if err != nil {
				return nil, "", "", 0, err
			}

			commands[index].Transaction = transaction
			commands[index].TagIds = tagIds
		}
	}

	sort.Slice(commands, func(left, right int) bool { return commands[left].RowIds[0] < commands[right].RowIds[0] })
	execution := &postingExecution{Uid: request.Uid, BatchId: request.BatchId, Commands: commands}
	keyHash := sha256.Sum256(encodeLengthPrefixed(string(IDEMPOTENCY_KEY_VERSION_V1), request.IdempotencyKey))
	requestHash := sha256.Sum256(canonicalPostingRequest(execution))
	return execution, hex.EncodeToString(keyHash[:]), hex.EncodeToString(requestHash[:]), selectedRows, nil
}

func buildPostingTransaction(uid int64, createdIp string, draft *LedgerTransactionDraft) (*models.Transaction, []int64, error) {
	if draft.UnixTime < 1 || draft.UnixTime > math.MaxInt64/1000 ||
		draft.TimezoneUtcOffset < minimumTimezoneUtcOffset || draft.TimezoneUtcOffset > maximumTimezoneUtcOffset ||
		draft.SourceAccountId < 1 || !isPostingDraftCategoryAllowed(draft) || draft.SourceAmount < 0 ||
		draft.SourceAmount > models.MaximumTransactionAmount || !utf8.ValidString(draft.Comment) ||
		utf8.RuneCountInString(draft.Comment) > 255 || len(draft.TagIds) > models.MaximumTagsCountOfTransaction {
		return nil, nil, ErrImportPostingRequestInvalid
	}

	dbType, err := draft.Type.ToTransactionDbType()

	if err != nil || draft.Type == models.TRANSACTION_TYPE_MODIFY_BALANCE {
		return nil, nil, ErrImportPostingRequestInvalid
	}

	if draft.Type == models.TRANSACTION_TYPE_TRANSFER {
		if draft.DestinationAccountId < 1 || draft.DestinationAccountId == draft.SourceAccountId ||
			draft.DestinationAmount < 0 || draft.DestinationAmount > models.MaximumTransactionAmount {
			return nil, nil, ErrImportPostingRequestInvalid
		}
	} else if draft.DestinationAccountId != 0 || draft.DestinationAmount != 0 {
		return nil, nil, ErrImportPostingRequestInvalid
	}

	tagIds := append([]int64(nil), draft.TagIds...)
	sort.Slice(tagIds, func(left, right int) bool { return tagIds[left] < tagIds[right] })

	for index, tagId := range tagIds {
		if tagId < 1 || (index > 0 && tagIds[index-1] == tagId) {
			return nil, nil, ErrImportPostingRequestInvalid
		}
	}

	return &models.Transaction{
		Uid:                  uid,
		Type:                 dbType,
		CategoryId:           draft.CategoryId,
		AccountId:            draft.SourceAccountId,
		TransactionTime:      utils.GetMinTransactionTimeFromUnixTime(draft.UnixTime),
		TimezoneUtcOffset:    draft.TimezoneUtcOffset,
		Amount:               draft.SourceAmount,
		RelatedAccountId:     draft.DestinationAccountId,
		RelatedAccountAmount: draft.DestinationAmount,
		HideAmount:           draft.HideAmount,
		Comment:              draft.Comment,
		CreatedIp:            createdIp,
	}, tagIds, nil
}

func canonicalPostingRequest(execution *postingExecution) []byte {
	values := []string{string(POSTING_REQUEST_VERSION_V1), strconv.FormatInt(execution.BatchId, 10)}

	for _, command := range execution.Commands {
		values = append(values, "command")
		if command.AutoPosted {
			values = append(values, "auto-posted")
		}

		for _, rowId := range command.RowIds {
			values = append(values, "row", strconv.FormatInt(rowId, 10))
		}

		transaction := command.Transaction

		if transaction == nil {
			values = append(values, "draft-absent")
			continue
		}

		values = append(values,
			"draft-present",
			strconv.FormatUint(uint64(transaction.Type), 10),
			strconv.FormatInt(transaction.CategoryId, 10),
			strconv.FormatInt(transaction.TransactionTime, 10),
			strconv.FormatInt(int64(transaction.TimezoneUtcOffset), 10),
			strconv.FormatInt(transaction.AccountId, 10),
			strconv.FormatInt(transaction.RelatedAccountId, 10),
			strconv.FormatInt(transaction.Amount, 10),
			strconv.FormatInt(transaction.RelatedAccountAmount, 10),
			strconv.FormatBool(transaction.HideAmount),
			transaction.Comment,
		)

		for _, tagId := range command.TagIds {
			values = append(values, "tag", strconv.FormatInt(tagId, 10))
		}
	}

	return encodeLengthPrefixed(values...)
}

func isValidPostingIdempotencyKey(value string) bool {
	if len(value) < minimumPostingIdempotencyKeyBytes || len(value) > maximumPostingIdempotencyKeyBytes {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return false
		}
	}

	return true
}

func validatePersistedPosting(persisted *ImportPosting, candidate *ImportPosting) error {
	if persisted == nil || persisted.Uid != candidate.Uid || persisted.PostingId < 1 ||
		persisted.IdempotencyKeyDigest != candidate.IdempotencyKeyDigest ||
		persisted.IdempotencyKeyVersion != IDEMPOTENCY_KEY_VERSION_V1 ||
		persisted.RequestDigestVersion != POSTING_REQUEST_VERSION_V1 {
		return ErrImportPostingEvidenceInvalid
	}

	if persisted.RequestDigest != candidate.RequestDigest {
		return ErrImportPostingIdempotencyConflict
	}

	if persisted.BatchId != candidate.BatchId || persisted.SelectedRowCount != candidate.SelectedRowCount {
		return ErrImportPostingEvidenceInvalid
	}

	return nil
}

func isPostingDraftCategoryAllowed(draft *LedgerTransactionDraft) bool {
	if draft == nil {
		return false
	}
	if draft.CategoryId >= 1 {
		return true
	}
	return draft.AllowUncategorized && draft.CategoryId == 0 &&
		(draft.Type == models.TRANSACTION_TYPE_EXPENSE || draft.Type == models.TRANSACTION_TYPE_INCOME)
}

func classifyPostingExecutionError(err error) (error, string) {
	switch {
	case errors.Is(err, errPostingBatchNotFound):
		return ErrImportPostingBatchNotFound, "batch_not_found"
	case errors.Is(err, errPostingClaimLost):
		return ErrImportPostingNotAvailable, "claim_not_acquired"
	case errors.Is(err, errPostingRowsInvalid):
		return ErrImportPostingRequestInvalid, "rows_not_postable"
	case errors.Is(err, errPostingEvidenceInvalid):
		return ErrImportPostingEvidenceInvalid, "evidence_invariant_failed"
	case errors.Is(err, errPostingIdentifier):
		return ErrImportIdentifierUnavailable, "identifier_unavailable"
	case errors.Is(err, errPostingPersistence):
		return ErrImportPersistenceUnavailable, "persistence_unavailable"
	default:
		return ErrImportPostingLedgerRejected, "ledger_rejected"
	}
}
