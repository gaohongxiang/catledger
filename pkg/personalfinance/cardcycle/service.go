package cardcycle

import (
	"errors"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

var (
	ErrServiceInvalidRequest    = errors.New("card cycle service request is invalid")
	ErrServiceAccountNotFound   = errors.New("card cycle account is not found")
	ErrServiceAccountRejected   = errors.New("card cycle account is rejected")
	ErrServiceBatchNotFound     = errors.New("card cycle import batch is not found")
	ErrServiceVersionConflict   = errors.New("card cycle version conflict")
	ErrServicePersistenceFailed = errors.New("card cycle persistence is unavailable")
)

type ServiceErrorCode string

const (
	SERVICE_ERROR_INVALID_REQUEST  ServiceErrorCode = "invalid_request"
	SERVICE_ERROR_ACCOUNT_MISSING  ServiceErrorCode = "account_not_found"
	SERVICE_ERROR_ACCOUNT_REJECTED ServiceErrorCode = "account_rejected"
	SERVICE_ERROR_BATCH_MISSING    ServiceErrorCode = "batch_not_found"
	SERVICE_ERROR_VERSION_CONFLICT ServiceErrorCode = "version_conflict"
	SERVICE_ERROR_PERSISTENCE      ServiceErrorCode = "persistence_unavailable"
)

const (
	MONTH_STATUS_PROVISIONAL MonthReportStatus = "provisional"
	MONTH_STATUS_CONFIRMED   MonthReportStatus = "confirmed"
	REASON_LATE_STATEMENT                      = "late_statement"
	maximumRevisionPageSize                    = 20
)

type MonthReportStatus string

type ServiceError struct {
	Code  ServiceErrorCode
	kind  error
	cause error
}

func (err *ServiceError) Error() string {
	return "card cycle service: " + string(err.Code)
}

func (err *ServiceError) Unwrap() error {
	return err.kind
}

func serviceError(kind error, code ServiceErrorCode) error {
	return &ServiceError{Code: code, kind: kind}
}

func persistError(err error) error {
	if err == nil {
		return nil
	}
	var typed *ServiceError
	if errors.As(err, &typed) {
		return err
	}
	return &ServiceError{Code: SERVICE_ERROR_PERSISTENCE, kind: ErrServicePersistenceFailed, cause: err}
}

func ServiceErrorCodeOf(err error) ServiceErrorCode {
	var typed *ServiceError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return SERVICE_ERROR_PERSISTENCE
}

// EvidenceReader 只读取当前 uid 的导入批次账期，不写导入表。
type EvidenceReader interface {
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error)
	FindCardHeaderByBatch(c core.Context, uid int64, batchId int64) (*importing.CardHeader, error)
}

// AccountReader 只读取账本账户的类别与安全显示名。
type AccountReader interface {
	ListCreditCardAccounts(c core.Context, uid int64) ([]AccountSnapshot, error)
	GetAccount(c core.Context, uid int64, accountId int64) (*AccountSnapshot, error)
}

// AccountSnapshot 是信用卡周期所需的最小账户事实。
type AccountSnapshot struct {
	AccountId   int64
	DisplayName string
	Currency    string
	Hidden      bool
	CreditCard  bool
}

// Service 编排信用卡实际覆盖、常规规则 revision、月末暂结和余额核对。
type Service struct {
	repository *Repository
	evidence   EvidenceReader
	accounts   AccountReader
	generateId func() int64
	now        func() time.Time
}

func NewService(repository *Repository, evidence EvidenceReader, accounts AccountReader, generateId func() int64) (*Service, error) {
	if repository == nil || evidence == nil || accounts == nil || generateId == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return &Service{repository: repository, evidence: evidence, accounts: accounts, generateId: generateId, now: time.Now}, nil
}

type SaveRuleRequest struct {
	Uid             int64
	LedgerAccountId int64
	StatementDay    int64
	DueDay          int64
	EffectiveFrom   string
	IdempotencyKey  string
}

type RecordCoverageRequest struct {
	Uid             int64
	BatchId         int64
	LedgerAccountId int64
	TaskId          int64
}

type SaveBalanceReviewRequest struct {
	Uid             int64
	LedgerAccountId int64
	Status          BalanceReviewStatus
	AsOfDate        string
	ExpectedVersion int64
	IdempotencyKey  string
}

type RuleView struct {
	RuleId          int64
	LedgerAccountId int64
	RuleNumber      int64
	StatementDay    int64
	DueDay          int64
	EffectiveFrom   string
	Status          RuleStatus
	CreatedUnixTime int64
}

type CoverageIntervalView struct {
	CoverageId      int64
	BatchId         int64
	PeriodStart     string
	PeriodEnd       string
	StatementDate   string
	DueDate         string
	CreatedUnixTime int64
}

type DateRangeView struct {
	StartDate string
	EndDate   string
}

type MonthRevisionView struct {
	RevisionId      int64
	YearMonth       string
	TaskId          int64
	ReasonCode      string
	CreatedUnixTime int64
}

type CoverageView struct {
	LedgerAccountId int64
	AsOfDate        string
	YearMonth       string
	MonthStatus     MonthReportStatus
	Coverages       []*CoverageIntervalView
	Gaps            []*DateRangeView
	Overlaps        []*DateRangeView
	Revisions       []*MonthRevisionView
}

type BalanceReviewView struct {
	ReviewId        int64
	LedgerAccountId int64
	Status          BalanceReviewStatus
	AsOfDate        string
	Version         int64
	UpdatedUnixTime int64
}

type CardAccountView struct {
	LedgerAccountId int64
	DisplayName     string
	Currency        string
	Hidden          bool
	ActiveRule      *RuleView
	LatestCoverage  *CoverageIntervalView
	UncoveredGap    *DateRangeView
	MonthStatus     MonthReportStatus
	BalanceReview   *BalanceReviewView
}

type AccountListResult struct {
	AsOfDate string
	Items    []*CardAccountView
}

func ruleView(value *CycleRule) *RuleView {
	if value == nil {
		return nil
	}
	return &RuleView{
		RuleId: value.RuleId, LedgerAccountId: value.LedgerAccountId, RuleNumber: value.RuleNumber,
		StatementDay: value.StatementDay, DueDay: value.DueDay, EffectiveFrom: value.EffectiveFrom,
		Status: value.Status, CreatedUnixTime: value.CreatedUnixTime,
	}
}

func coverageIntervalView(value *StatementCoverage) *CoverageIntervalView {
	if value == nil {
		return nil
	}
	return &CoverageIntervalView{
		CoverageId: value.CoverageId, BatchId: value.BatchId, PeriodStart: value.PeriodStart,
		PeriodEnd: value.PeriodEnd, StatementDate: value.StatementDate, DueDate: value.DueDate,
		CreatedUnixTime: value.CreatedUnixTime,
	}
}

func revisionView(value *MonthReportRevision) *MonthRevisionView {
	if value == nil {
		return nil
	}
	return &MonthRevisionView{
		RevisionId: value.RevisionId, YearMonth: value.YearMonth, TaskId: value.TaskId,
		ReasonCode: value.ReasonCode, CreatedUnixTime: value.CreatedUnixTime,
	}
}

func balanceReviewView(value *BalanceReview) *BalanceReviewView {
	if value == nil {
		return nil
	}
	return &BalanceReviewView{
		ReviewId: value.ReviewId, LedgerAccountId: value.LedgerAccountId, Status: value.Status,
		AsOfDate: value.AsOfDate, Version: value.Version, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}
