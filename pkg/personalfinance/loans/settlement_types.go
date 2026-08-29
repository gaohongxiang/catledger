package loans

import (
	"errors"
	"time"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
)

const (
	maximumSettlementComponents       = 3
	maximumSettlementCandidateResults = 50
	settlementCandidateWindowDays     = 45
	maximumValidatedAllocations       = 10000
)

var (
	ErrServiceLedgerValidationRequired = errors.New("loan service ledger validation is required")
	ErrServiceLedgerEventRejected      = errors.New("loan service ledger event is rejected")
	ErrServiceSettlementRejected       = errors.New("loan service settlement is rejected")
	ErrServiceSettlementNotFound       = errors.New("loan service settlement is not found")
)

const (
	SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED  ServiceErrorCode = "ledger_validation_required"
	SERVICE_ERROR_INSTALLMENT_NOT_FOUND       ServiceErrorCode = "installment_not_found"
	SERVICE_ERROR_REVISION_MISMATCH           ServiceErrorCode = "revision_mismatch"
	SERVICE_ERROR_COMPONENT_MISMATCH          ServiceErrorCode = "component_mismatch"
	SERVICE_ERROR_AMOUNT_EXCEEDED             ServiceErrorCode = "amount_exceeded"
	SERVICE_ERROR_LEDGER_EVENT_MISSING        ServiceErrorCode = "ledger_event_missing"
	SERVICE_ERROR_LEDGER_EVENT_MODIFIED       ServiceErrorCode = "ledger_event_modified"
	SERVICE_ERROR_LEDGER_EVENT_TYPE           ServiceErrorCode = "ledger_event_type_mismatch"
	SERVICE_ERROR_LEDGER_EVENT_ACCOUNT        ServiceErrorCode = "ledger_event_account_mismatch"
	SERVICE_ERROR_LEDGER_EVENT_CURRENCY       ServiceErrorCode = "ledger_event_currency_mismatch"
	SERVICE_ERROR_LEDGER_EVENT_AMOUNT         ServiceErrorCode = "ledger_event_amount_mismatch"
	SERVICE_ERROR_LEDGER_CATEGORY             ServiceErrorCode = "ledger_category_mismatch"
	SERVICE_ERROR_TRANSFER_INCOMPLETE         ServiceErrorCode = "transfer_pair_incomplete"
	SERVICE_ERROR_BINDING_CONFLICT            ServiceErrorCode = "binding_conflict"
	SERVICE_ERROR_SETTLEMENT_NOT_FOUND        ServiceErrorCode = "settlement_not_found"
	SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED ServiceErrorCode = "settlement_already_reversed"
	SERVICE_ERROR_ALLOCATION_LIMIT            ServiceErrorCode = "allocation_limit_reached"
)

// LedgerEventKind 是贷款服务需要区分的最小正式事件类型。
type LedgerEventKind string

const (
	LEDGER_EVENT_KIND_TRANSFER LedgerEventKind = "transfer"
	LEDGER_EVENT_KIND_EXPENSE  LedgerEventKind = "expense"
)

// LedgerCategoryKind 是贷款服务验证类别语义所需的最小分类。
type LedgerCategoryKind string

const (
	LEDGER_CATEGORY_KIND_TRANSFER LedgerCategoryKind = "transfer"
	LEDGER_CATEGORY_KIND_EXPENSE  LedgerCategoryKind = "expense"
)

// LedgerEventSnapshot 是不含备注、标签名称、来源证据或账户名称的正式事件快照。
// Transfer 始终规范为 source(out) -> destination(in)。
type LedgerEventSnapshot struct {
	PrimaryTransactionId       int64
	CounterpartTransactionId   *int64
	Kind                       LedgerEventKind
	CategoryId                 int64
	CategoryKind               LedgerCategoryKind
	CategoryDeleted            bool
	SourceAccount              AccountSnapshot
	DestinationAccount         *AccountSnapshot
	Amount                     int64
	TransactionUnixTime        int64
	Deleted                    bool
	CounterpartDeleted         bool
	UpdatedUnixTime            int64
	CounterpartUpdatedUnixTime *int64
	TransferComplete           bool
}

// LedgerCandidateFilter 是贷款服务由合同、当前计划和组件推导的固定有界内部条件。
// DestinationAccountId 为零只允许到账候选，表示负债账户转到任一合格资产账户。
type LedgerCandidateFilter struct {
	Kind                 LedgerEventKind
	SourceAccountId      int64
	DestinationAccountId int64
	MinimumAmount        int64
	MaximumAmount        int64
	MinimumUnixTime      int64
	MaximumUnixTime      int64
	Limit                int
}

type LedgerCandidatePage struct {
	Items        []*LedgerEventSnapshot
	LimitReached bool
}

// LedgerCreateDraft 只包含贷款动作允许交给核心账本的字段。
type LedgerCreateDraft struct {
	Uid                  int64
	Kind                 LedgerEventKind
	CategoryId           int64
	UnixTime             int64
	TimezoneUtcOffset    int16
	SourceAccountId      int64
	DestinationAccountId int64
	Amount               int64
	CreatedIp            string
}

// SettlementLedgerGateway 由核心 services 窄适配器实现。
// 候选、复核和创建均使用 privacy session；创建不提交或回滚调用方事务。
type SettlementLedgerGateway interface {
	AccountSnapshotReader
	LiabilityOutstandingReader
	AuthorizeSettlementCreation(c core.Context, uid int64, clientTimezone *time.Location, drafts []LedgerCreateDraft) error
	ListSettlementCandidates(c core.Context, uid int64, filter LedgerCandidateFilter) (*LedgerCandidatePage, error)
	LoadSettlementEvents(c core.Context, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error)
	LoadSettlementEventsInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*LedgerEventSnapshot, error)
	ValidateSettlementDraftInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft LedgerCreateDraft) (*LedgerEventSnapshot, error)
	CreateSettlementEventInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft LedgerCreateDraft) (*LedgerEventSnapshot, error)
}

// SettlementCandidateRequest 不接受客户端金额、账户、分类或合同版本；服务端从当前计划推导。
type SettlementCandidateRequest struct {
	Uid           int64
	ContractId    int64
	InstallmentId *int64
	ComponentType ComponentType
}

// SettlementCandidate 是可直接回填 apply 快照条件的脱敏技术摘要。
type SettlementCandidate struct {
	TransactionId              int64
	Kind                       LedgerEventKind
	TransactionUnixTime        int64
	Amount                     int64
	Currency                   string
	MaskedSourceAccount        string
	MaskedDestinationAccount   string
	Eligible                   bool
	ReasonCodes                []ServiceErrorCode
	UpdatedUnixTime            int64
	CounterpartUpdatedUnixTime *int64
}

type SettlementCandidateGroup struct {
	ComponentType     ComponentType
	ExpectedAmount    int64
	OutstandingAmount int64
	Candidates        []SettlementCandidate
	LimitReached      bool
}

type SettlementCandidateResult struct {
	ContractId    int64
	InstallmentId *int64
	Groups        []SettlementCandidateGroup
}

// ExistingLedgerEventReference 必须携带候选时看到的主快照；transfer 还必须携带对端快照。
type ExistingLedgerEventReference struct {
	ExistingTransactionId              int64
	ExpectedUpdatedUnixTime            int64
	ExpectedCounterpartUpdatedUnixTime *int64
}

// SettlementLedgerDraft 不允许 comment、图片、地理位置、tag 或内部交易字段。
// categoryId 对 transfer 和 expense 都显式必填，不自动挑选默认分类。
type SettlementLedgerDraft struct {
	Kind                 LedgerEventKind
	TransactionUnixTime  int64
	TimezoneUtcOffset    int16
	SourceAccountId      int64
	DestinationAccountId int64
	CategoryId           int64
	Amount               int64
	Currency             string
}

type SettlementComponentCommand struct {
	ComponentType   ComponentType
	AllocatedAmount int64
	Existing        *ExistingLedgerEventReference
	Draft           *SettlementLedgerDraft
}

type ApplySettlementRequest struct {
	Uid                     int64
	ContractId              int64
	ExpectedContractVersion int64
	InstallmentId           *int64
	IdempotencyKey          string
	CreatedIp               string
	Components              []SettlementComponentCommand
}

type ReverseSettlementRequest struct {
	Uid                     int64
	ContractId              int64
	ApplyActionId           int64
	ExpectedContractVersion int64
	IdempotencyKey          string
}

type SettlementUndoImpactRequest struct {
	Uid           int64
	ContractId    int64
	ApplyActionId int64
}

// SettlementAllocationResult 不返回 uid、幂等摘要、schedule digest 或账本备注。
type SettlementAllocationResult struct {
	AllocationId               int64
	InstallmentId              *int64
	ComponentType              ComponentType
	AllocatedAmount            int64
	CreationMethod             AllocationCreationMethod
	Status                     AllocationStatus
	TransactionId              int64
	CounterpartTransactionId   *int64
	TransactionUpdatedUnixTime int64
	CounterpartUpdatedUnixTime *int64
	ReasonCodes                []ServiceErrorCode
	CreatedUnixTime            int64
	UpdatedUnixTime            int64
}

type SettlementResult struct {
	Action                  *CommandAction
	Allocations             []*SettlementAllocationResult
	ReversedAllocationCount int64
	Replayed                bool
	ReasonCodes             []ServiceErrorCode
}

// SettlementUndoImpact 只按原 apply action 返回聚合影响，不返回账本详情。
type SettlementUndoImpact struct {
	ContractId                  int64
	ApplyActionId               int64
	ActiveAllocationCount       int64
	RelationshipCount           int64
	AffectedTransactionCount    int64
	LoanCreatedTransactionCount int64
	ModifiedTransactionCount    int64
	MissingTransactionCount     int64
	IncompleteTransferPairCount int64
	CanUndoRelationships        bool
	ReasonCodes                 []ServiceErrorCode
}
