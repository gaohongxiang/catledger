package billflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

var (
	ErrServiceInvalidRequest      = errors.New("billflow service request is invalid")
	ErrServiceTaskNotFound        = errors.New("billflow task is not found")
	ErrServiceVersionConflict     = errors.New("billflow task version conflict")
	ErrServiceStateConflict       = errors.New("billflow task state conflict")
	ErrServiceIdempotencyConflict = errors.New("billflow action request digest conflict")
	ErrServiceAccountRejected     = errors.New("billflow account is rejected")
	ErrServiceActionRequired      = errors.New("billflow undo requires manual action")
	ErrServicePersistenceFailed   = errors.New("billflow persistence is unavailable")
)

type ServiceErrorCode string

const (
	SERVICE_ERROR_INVALID_REQUEST      ServiceErrorCode = "invalid_request"
	SERVICE_ERROR_TASK_NOT_FOUND       ServiceErrorCode = "task_not_found"
	SERVICE_ERROR_VERSION_CONFLICT     ServiceErrorCode = "task_version_conflict"
	SERVICE_ERROR_STATE_CONFLICT       ServiceErrorCode = "task_state_conflict"
	SERVICE_ERROR_IDEMPOTENCY_CONFLICT ServiceErrorCode = "idempotency_conflict"
	SERVICE_ERROR_ACCOUNT_REJECTED     ServiceErrorCode = "account_rejected"
	SERVICE_ERROR_ACTION_REQUIRED      ServiceErrorCode = "action_required"
	SERVICE_ERROR_PERSISTENCE          ServiceErrorCode = "persistence_unavailable"
)

type ServiceError struct {
	Code ServiceErrorCode
	kind error
}

func (err *ServiceError) Error() string { return "billflow service: " + string(err.Code) }
func (err *ServiceError) Unwrap() error { return err.kind }

func serviceError(kind error, code ServiceErrorCode) error {
	return &ServiceError{Code: code, kind: kind}
}

func ServiceErrorCodeOf(err error) ServiceErrorCode {
	var typed *ServiceError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return SERVICE_ERROR_PERSISTENCE
}

// EvidenceReader 只读取当前 uid 的文件、批次和原始行。
type EvidenceReader interface {
	FindImportFileById(c core.Context, uid int64, fileId int64) (*importing.ImportFile, error)
	FindLatestImportBatchByFileId(c core.Context, uid int64, fileId int64) (*importing.ImportBatch, error)
	ListImportBatches(c core.Context, uid int64, fileId int64, offset int, limit int) ([]*importing.ImportBatch, int64, error)
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error)
	FindCardHeaderByBatch(c core.Context, uid int64, batchId int64) (*importing.CardHeader, error)
	ListRawImportRows(c core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error)
	FindRawImportRowById(c core.Context, uid int64, rowId int64) (*importing.RawImportRow, error)
}

// PaymentAccounts 复用既有付款方式映射，不新写合并器。
type PaymentAccounts interface {
	ListBatchPaymentAccounts(c core.Context, uid int64, batchId int64) ([]*importing.PaymentAccountGroup, error)
	ConfirmBatchPaymentAccount(c core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error)
	ApplyPersistedExclusions(c core.Context, uid int64, batchId int64) error
	ExcludePaymentAccount(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error)
	RestorePaymentAccount(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error)
	SkipPaymentAccountRows(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error)
	RestorePaymentAccountRows(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error)
	ListPaymentAccountGroupRows(c core.Context, uid int64, batchId int64, sampleRowId int64) ([]*importing.PaymentAccountRowView, error)
}

// Poster 复用既有 ImportPosting。
type Poster interface {
	PostImportBatch(c core.Context, request importing.PostImportBatchRequest, clientTimezone *time.Location) (*importing.ImportPostingResult, error)
}

// Reconciler 在任务范围内调用既有候选生成与决定。
type Reconciler interface {
	GenerateCandidates(c core.Context, request reconciliation.GenerateCandidatesRequest) (*reconciliation.GenerateCandidatesResult, error)
	ListCases(c core.Context, request reconciliation.ListCasesRequest) (*reconciliation.CasePage, error)
	GetCase(c core.Context, uid int64, caseId int64) (*reconciliation.CaseDetail, error)
	DecideCase(c core.Context, request reconciliation.DecideCaseRequest, clientTimezone *time.Location) (*reconciliation.DecisionResult, error)
	UndoCase(c core.Context, request reconciliation.UndoCaseRequest, clientTimezone *time.Location) (*reconciliation.DecisionResult, error)
}

// InstallmentIngester 只在整理编排中调用分期识别。
type InstallmentIngester interface {
	IngestBatches(c core.Context, request installments.IngestRequest) (*installments.IngestResult, error)
	ListCandidates(c core.Context, uid int64, status installments.CandidateStatus, cursor *installments.CandidateCursor, limit int) (*installments.CandidateListResult, error)
}

// CreateAccountSpec 是整理时新建正式账户的最小字段；信用卡账单日 0 表示未知。
type CreateAccountSpec struct {
	Name                    string
	Category                models.AccountCategory
	Currency                string
	CreditCardStatementDate int
}

// AccountFactory 通过既有正式账户创建入口新建付款账户。
type AccountFactory interface {
	CreateAccount(c core.Context, uid int64, spec CreateAccountSpec) (int64, error)
	LoadAccount(c core.Context, uid int64, accountId int64) (*AccountSnapshot, error)
}

// CategoryCatalog 只提供当前 uid 未隐藏叶子分类名称。
type CategoryCatalog interface {
	ListVisibleLeafCategories(c core.Context, uid int64) ([]CategoryLeaf, error)
}

// UndoGateway 检查并撤销本任务 auto_posted 创建的正式交易。
type UndoGateway interface {
	Inspect(c core.Context, uid int64, batchIds []int64) (*UndoInspection, error)
	Reverse(c core.Context, uid int64, inspection *UndoInspection) error
}

type AccountSnapshot struct {
	AccountId int64
	Currency  string
	Hidden    bool
	Deleted   bool
	Category  models.AccountCategory
}

type CategoryLeaf struct {
	CategoryId int64
	Name       string
}

type UndoInspection struct {
	CanReverse           bool
	AutoPostedCount      int64
	ReusedLinkCount      int64
	TransactionIds       []int64
	ReusedTransactionIds []int64
	ReasonCodes          []string
	snapshots            map[int64]int64
	rowIds               []int64
}

type Service struct {
	repository   *Repository
	evidence     EvidenceReader
	payments     PaymentAccounts
	poster       Poster
	reconciler   Reconciler
	installments InstallmentIngester
	accounts     AccountFactory
	categories   CategoryCatalog
	undo         UndoGateway
	generateId   func() int64
	now          func() time.Time
}

func NewService(repository *Repository, evidence EvidenceReader, payments PaymentAccounts, poster Poster, reconciler Reconciler, installments InstallmentIngester, accounts AccountFactory, categories CategoryCatalog, undo UndoGateway, generateId func() int64) (*Service, error) {
	if repository == nil || evidence == nil || payments == nil || generateId == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return &Service{
		repository: repository, evidence: evidence, payments: payments, poster: poster,
		reconciler: reconciler, installments: installments, accounts: accounts, categories: categories,
		undo: undo, generateId: generateId, now: time.Now,
	}, nil
}

type TaskView struct {
	TaskId              int64
	Status              TaskStatus
	ConfirmPolicy       ConfirmPolicy
	Version             int64
	CreatedAccountCount int64
	ReusedMappingCount  int64
	AutoPostedCount     int64
	TodoOpenCount       int64
	ErrorCode           string
	CreatedUnixTime     int64
	UpdatedUnixTime     int64
	Members             []*MemberView
}

type MemberView struct {
	MemberId    int64
	FileId      int64
	BatchId     int64
	MemberOrder int64
}

type TaskListResult struct {
	Items      []*TaskView
	NextCursor *TaskCursor
}

type TodoListResult struct {
	Items      []*TodoView
	NextCursor *TodoCursor
}

type AccountGroupView struct {
	SourceType          importing.SourceType
	Currency            string
	DisplayName         string
	RowCount            int64
	PendingRowCount     int64
	SampleRowId         int64
	LedgerAccountId     *int64
	SuggestedType       string
	Mapped              bool
	Excluded            bool
	SkippedRowCount     int64
	StatementDate       string
	DueDate             string
	CreditLimitAmount   *int64
	CreditLimitCurrency string
}

type TaskAccountsView struct {
	NeedsCreate []*AccountGroupView
	Reused      []*AccountGroupView
	Excluded    []*AccountGroupView
}

type AccountRowView struct {
	RowId     int64
	BatchId   int64
	UnixTime  *int64
	Amount    *int64
	Currency  string
	Direction importing.NormalizedDirection
	Label     string
	Skipped   bool
}

type TodoView struct {
	TodoId          int64
	TodoKind        TodoKind
	Status          TodoStatus
	SubjectKind     SubjectKind
	SubjectId       int64
	ReasonCodes     []string
	Label           string
	Item            string
	BillType        string
	Amount          string
	Currency        string
	UnixTime        *int64
	Direction       string
	SourceType      string
	Account         string
	CategoryId      int64
	OrderId         string
	MerchantOrderId string
	Version         int64
	CreatedUnixTime int64
	UpdatedUnixTime int64
	Matches         []*TodoMatchView
}

type TodoMatchView struct {
	RowId           int64
	SourceType      string
	Account         string
	Label           string
	Item            string
	BillType        string
	Amount          string
	Currency        string
	UnixTime        *int64
	Direction       string
	OrderId         string
	MerchantOrderId string
}

type ClassifiedRowView struct {
	RowId      int64
	TodoId     int64
	Version    int64
	Label      string
	Item       string
	BillType   string
	Amount     string
	Currency   string
	UnixTime   *int64
	Direction  string
	CategoryId int64
}

type UndoImpactView struct {
	CanReverse      bool
	AutoPostedCount int64
	ReusedLinkCount int64
	ReasonCodes     []string
}

func taskView(task *Task, members []*TaskMember) *TaskView {
	if task == nil {
		return nil
	}
	view := &TaskView{
		TaskId: task.TaskId, Status: task.Status, ConfirmPolicy: task.ConfirmPolicy, Version: task.Version,
		CreatedAccountCount: task.CreatedAccountCount, ReusedMappingCount: task.ReusedMappingCount,
		AutoPostedCount: task.AutoPostedCount, TodoOpenCount: task.TodoOpenCount, ErrorCode: task.ErrorCode,
		CreatedUnixTime: task.CreatedUnixTime, UpdatedUnixTime: task.UpdatedUnixTime,
	}
	for _, member := range members {
		if member == nil {
			continue
		}
		view.Members = append(view.Members, &MemberView{
			MemberId: member.MemberId, FileId: member.FileId, BatchId: member.BatchId, MemberOrder: member.MemberOrder,
		})
	}
	return view
}

func cloneTask(value *Task) *Task {
	if value == nil {
		return nil
	}
	copied := *value
	if value.CurrentActionId != nil {
		id := *value.CurrentActionId
		copied.CurrentActionId = &id
	}
	return &copied
}

func digestKey(key string) string {
	sum := sha256.Sum256([]byte(string(IDEMPOTENCY_KEY_VERSION_V1) + "\x00" + key))
	return hex.EncodeToString(sum[:])
}

func digestRequest(parts ...string) string {
	sum := sha256.Sum256([]byte(string(ACTION_REQUEST_DIGEST_VERSION_V1) + "\n" + strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}

func encodeReasonCodes(codes []string) string {
	if len(codes) == 0 {
		return "[]"
	}
	escaped := make([]string, 0, len(codes))
	for _, code := range codes {
		escaped = append(escaped, `"`+strings.ReplaceAll(code, `"`, "")+`"`)
	}
	return "[" + strings.Join(escaped, ",") + "]"
}

func decodeReasonCodes(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" {
		return []string{}
	}
	raw = strings.TrimPrefix(strings.TrimSuffix(raw, "]"), "[")
	parts := strings.Split(raw, ",")
	codes := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"`)
		if part != "" {
			codes = append(codes, part)
		}
	}
	return codes
}

func isSuccessfulBatch(status importing.ImportBatchStatus) bool {
	return status == importing.IMPORT_BATCH_STATUS_READY ||
		status == importing.IMPORT_BATCH_STATUS_PARTIALLY_POSTED ||
		status == importing.IMPORT_BATCH_STATUS_COMPLETED
}

func isValidIdempotencyKey(value string) bool {
	if len(value) < 8 || len(value) > 128 {
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
