package loans

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans/calculation"
)

const (
	minimumServiceIdempotencyKeyBytes = 8
	maximumServiceIdempotencyKeyBytes = 128
	maximumContractNameCharacters     = 128
	maximumLenderNameCharacters       = 128
	maximumContractNoteCharacters     = 255
)

var (
	ErrServiceInvalidRequest      = errors.New("loan service request is invalid")
	ErrServiceAccountRejected     = errors.New("loan service account is rejected")
	ErrServiceContractNotFound    = errors.New("loan service contract is not found")
	ErrServiceIdempotencyConflict = errors.New("loan service idempotency conflict")
	ErrServiceVersionConflict     = errors.New("loan service contract version conflict")
	ErrServiceStateConflict       = errors.New("loan service contract state conflict")
	ErrServiceActiveAllocation    = errors.New("loan service active allocation conflict")
	ErrServiceAllocationHistory   = errors.New("loan service allocation history conflict")
	ErrServicePlanNotPaidOff      = errors.New("loan service plan is not paid off")
	ErrServiceCommandUnavailable  = errors.New("loan service command is unavailable")
	ErrServicePersistenceFailed   = errors.New("loan service persistence is unavailable")
	ErrServiceInvariantViolation  = errors.New("loan service invariant violation")
)

// ServiceErrorCode 是后续 HTTP 边界可直接映射的稳定脱敏错误码。
type ServiceErrorCode string

const (
	SERVICE_ERROR_INVALID_REQUEST      ServiceErrorCode = "invalid_request"
	SERVICE_ERROR_ACCOUNT_NOT_FOUND    ServiceErrorCode = "account_not_found"
	SERVICE_ERROR_ACCOUNT_OWNER        ServiceErrorCode = "account_owner_mismatch"
	SERVICE_ERROR_ACCOUNT_DELETED      ServiceErrorCode = "account_deleted"
	SERVICE_ERROR_ACCOUNT_NOT_SINGLE   ServiceErrorCode = "account_not_single"
	SERVICE_ERROR_ACCOUNT_HIDDEN       ServiceErrorCode = "account_hidden"
	SERVICE_ERROR_LIABILITY_REQUIRED   ServiceErrorCode = "liability_account_required"
	SERVICE_ERROR_ASSET_REQUIRED       ServiceErrorCode = "asset_account_required"
	SERVICE_ERROR_ACCOUNT_CURRENCY     ServiceErrorCode = "account_currency_mismatch"
	SERVICE_ERROR_CONTRACT_NOT_FOUND   ServiceErrorCode = "contract_not_found"
	SERVICE_ERROR_IDEMPOTENCY_CONFLICT ServiceErrorCode = "idempotency_conflict"
	SERVICE_ERROR_VERSION_CONFLICT     ServiceErrorCode = "contract_version_conflict"
	SERVICE_ERROR_STATE_CONFLICT       ServiceErrorCode = "contract_state_conflict"
	SERVICE_ERROR_ACTIVE_ALLOCATION    ServiceErrorCode = "active_allocation_present"
	SERVICE_ERROR_ALLOCATION_HISTORY   ServiceErrorCode = "allocation_history_present"
	SERVICE_ERROR_PLAN_NOT_PAID_OFF    ServiceErrorCode = "plan_not_paid_off"
	SERVICE_ERROR_COMMAND_UNAVAILABLE  ServiceErrorCode = "command_unavailable"
	SERVICE_ERROR_PERSISTENCE          ServiceErrorCode = "persistence_unavailable"
	SERVICE_ERROR_INVARIANT            ServiceErrorCode = "invariant_violation"
)

// ServiceError 不包含名称、机构、备注、金额、账户 ID 或原始幂等键。
type ServiceError struct {
	Code  ServiceErrorCode
	kind  error
	cause error
}

func (err *ServiceError) Error() string {
	return "loan service: " + string(err.Code)
}

func (err *ServiceError) Unwrap() error {
	return err.kind
}

func serviceError(kind error, code ServiceErrorCode) error {
	return &ServiceError{Code: code, kind: kind}
}

// ServiceErrorCodeOf 返回可判定稳定码；未知内部错误统一收敛为 persistence_unavailable。
func ServiceErrorCodeOf(err error) ServiceErrorCode {
	var typed *ServiceError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return SERVICE_ERROR_PERSISTENCE
}

// AccountKind 是贷款服务校验所需的最小账户分类，不暴露账户名称或备注。
type AccountKind string

const (
	ACCOUNT_KIND_ASSET       AccountKind = "asset"
	ACCOUNT_KIND_CREDIT_CARD AccountKind = "credit_card"
	ACCOUNT_KIND_DEBT        AccountKind = "debt"
)

// AccountSnapshot 只包含授权、类别、结构和币种校验所需字段。
type AccountSnapshot struct {
	AccountId int64
	Uid       int64
	Deleted   bool
	Kind      AccountKind
	Single    bool
	Hidden    bool
	Currency  string
}

// AccountSnapshotReader 由核心账本侧适配；核心账本无需依赖贷款模型。
type AccountSnapshotReader interface {
	LoadAccountSnapshots(c core.Context, uid int64, accountIds []int64) ([]AccountSnapshot, error)
}

// LiabilityOutstandingReader 可选地提供正式账本负债正数快照；不可可靠读取时构造器可传 nil。
type LiabilityOutstandingReader interface {
	ReadLiabilityOutstanding(c core.Context, uid int64, liabilityAccountId int64) (*int64, error)
}

// CalculationTerms 是 calculate/create/revise 共享的规范业务输入。
type CalculationTerms struct {
	EffectiveDate            string
	ContractDate             string
	FirstDueDate             string
	FundingType              FundingType
	InputMode                InputMode
	RepaymentMethod          RepaymentMethod
	RateQuoteType            RateQuoteType
	PrincipalAmount          int64
	ActualDisbursementAmount int64
	UpfrontFeeAmount         int64
	PerPeriodFeeAmount       int64
	PaymentBasisAmount       *int64
	TermCount                int64
	QuotedRatePptr           *int64
	DiscountType             DiscountType
	DiscountRatePptr         *int64
	DiscountAmount           int64
}

// ContractSpec 是创建与修订共享的合同业务字段。
type ContractSpec struct {
	Name                             string
	LenderName                       string
	ContractType                     ContractType
	LiabilityAccountId               int64
	DefaultPaymentAccountId          *int64
	Currency                         string
	Note                             string
	OpeningCompletedInstallmentCount int64
	Terms                            CalculationTerms
}

type CalculateRequest struct {
	Terms CalculationTerms
}

// CalculationResult 排除内部 schedule digest，供 calculate API 安全复用。
type CalculationResult struct {
	CalculationVersion            string
	RoundingVersion               string
	IrrVersion                    string
	ActualDisbursementAmount      int64
	PeriodicRatePptr              int64
	Installments                  []calculation.Installment
	PreDiscountTotalPaymentAmount int64
	PreDiscountTotalCostAmount    int64
	TotalPaymentAmount            int64
	TotalInterestAmount           int64
	TotalFeeAmount                int64
	TotalDiscountAmount           int64
	TotalCostAmount               int64
	CostRatioPptr                 int64
	IRR                           calculation.IRRResult
}

type CreateContractRequest struct {
	Uid            int64
	Spec           ContractSpec
	IdempotencyKey string
}

type ReviseContractRequest struct {
	Uid                     int64
	ContractId              int64
	ExpectedContractVersion int64
	Spec                    ContractSpec
	IdempotencyKey          string
}

type ContractCommandRequest struct {
	Uid                     int64
	ContractId              int64
	ExpectedContractVersion int64
	IdempotencyKey          string
}

type CloseContractRequest struct {
	Uid                     int64
	ContractId              int64
	ExpectedContractVersion int64
	Reason                  CloseReasonCode
	IdempotencyKey          string
}

// CommandAction 是不含幂等摘要、请求摘要和持久化 JSON 的安全 action 结果。
type CommandAction struct {
	ActionId                int64
	ContractId              int64
	ExpectedContractVersion int64
	AppliedContractVersion  int64
	ActionType              ActionType
	Status                  ActionStatus
	ReasonCodes             []ServiceErrorCode
	ErrorCode               ServiceErrorCode
	CreatedUnixTime         int64
	StartedUnixTime         *int64
	CompletedUnixTime       *int64
	FailedUnixTime          *int64
	UpdatedUnixTime         int64
}

// CommandResult 返回安全 action 和可选不可变 revision；摘要与原始幂等键永不返回。
type CommandResult struct {
	Action                     *CommandAction
	Revision                   *RevisionResult
	Installments               []*InstallmentResult
	Remaining                  *PlanRemaining
	LedgerOutstandingAmount    *int64
	LedgerPlanDifferenceAmount *int64
	Replayed                   bool
}

// ContractResult 是不含 uid 的合同业务视图。
type ContractResult struct {
	ContractId              int64
	Name                    string
	LenderName              string
	ContractType            ContractType
	LiabilityAccountId      int64
	Status                  ContractStatus
	CloseReasonCode         CloseReasonCode
	DefaultPaymentAccountId *int64
	Currency                string
	Note                    string
	Version                 int64
	CurrentRevisionId       int64
	CreatedUnixTime         int64
	UpdatedUnixTime         int64
	ClosedUnixTime          *int64
}

// RevisionResult 排除 uid、action_id 和内部 schedule digest，仅保留业务输入与计算结果。
type RevisionResult struct {
	RevisionId                       int64
	ContractId                       int64
	RevisionNumber                   int64
	PreviousRevisionId               *int64
	EffectiveDate                    string
	ContractDate                     string
	FirstDueDate                     string
	FundingType                      FundingType
	InputMode                        InputMode
	RepaymentMethod                  RepaymentMethod
	RateQuoteType                    RateQuoteType
	FrequencyType                    FrequencyType
	FrequencyInterval                int64
	PrincipalAmount                  int64
	ActualDisbursementAmount         int64
	UpfrontFeeAmount                 int64
	PerPeriodFeeAmount               int64
	PaymentBasisAmount               *int64
	TermCount                        int64
	OpeningCompletedInstallmentCount int64
	QuotedRatePptr                   *int64
	DiscountType                     DiscountType
	DiscountRatePptr                 *int64
	DiscountAmount                   int64
	CalculationVersion               RuleVersion
	RoundingVersion                  RuleVersion
	IrrVersion                       RuleVersion
	PreDiscountTotalPaymentAmount    int64
	PreDiscountTotalCostAmount       int64
	TotalPaymentAmount               int64
	TotalInterestAmount              int64
	TotalFeeAmount                   int64
	TotalDiscountAmount              int64
	TotalCostAmount                  int64
	CostRatioPptr                    int64
	IrrStatus                        IRRStatus
	MonthlyIrrPptr                   *int64
	SimpleAprPptr                    *int64
	EffectiveAprPptr                 *int64
	CreatedUnixTime                  int64
}

// InstallmentResult 排除 uid、合同/revision 重复外键，保留结算所需 installment_id。
type InstallmentResult struct {
	InstallmentId             int64
	InstallmentNumber         int64
	DueDate                   string
	BeginningPrincipalAmount  int64
	PrincipalAmount           int64
	InterestAmount            int64
	FeeAmount                 int64
	DiscountAmount            int64
	PaymentAmount             int64
	EndingPrincipalAmount     int64
	PreDiscountInterestAmount int64
	PreDiscountFeeAmount      int64
	PreDiscountPaymentAmount  int64
}

// ContractNextInstallment 是列表展示下一笔待还所需的最小计划切片。
// 计划行与进度必须来自同一次 ContractDetail 派生，避免列表重新计算第二套状态。
type ContractNextInstallment struct {
	Installment *InstallmentResult
	Progress    *InstallmentProgress
}

// ContractSummary 是列表使用的有界摘要。
type ContractSummary struct {
	Contract        *ContractResult
	CurrentRevision *RevisionResult
	Progress        PlanProgress
	NextInstallment *ContractNextInstallment
	ActionRequired  bool
	ReasonCodes     []ServiceErrorCode
}

type ContractListResult struct {
	Items      []*ContractSummary
	NextCursor *ContractCursor
}

// ComponentProgress 是单期各组件的计划、已分配和待还金额。
type ComponentProgress struct {
	PlannedPrincipalAmount   int64
	PlannedInterestAmount    int64
	PlannedFeeAmount         int64
	AllocatedPrincipalAmount int64
	AllocatedInterestAmount  int64
	AllocatedFeeAmount       int64
	OutstandingPrincipal     int64
	OutstandingInterest      int64
	OutstandingFee           int64
}

type InstallmentProgress struct {
	InstallmentId      int64
	InstallmentNumber  int64
	DueDate            string
	Status             InstallmentProgressStatus
	Overdue            bool
	AllocationCount    int64
	OpeningCompleted   bool
	Components         ComponentProgress
	OutstandingPayment int64
}

type PlanProgress struct {
	InstallmentCount                 int64
	UnpaidInstallmentCount           int64
	PartialInstallmentCount          int64
	PaidInstallmentCount             int64
	OpeningCompletedInstallmentCount int64
	OverdueInstallmentCount          int64
	AllocatedPaymentAmount           int64
	OutstandingPayment               int64
	OutstandingPrincipal             int64
	OutstandingInterest              int64
	OutstandingFee                   int64
	NextDueDate                      *string
}

type PlanRemaining struct {
	PaymentAmount   int64
	PrincipalAmount int64
	InterestAmount  int64
	FeeAmount       int64
}

type ContractDetail struct {
	Contract                   *ContractResult
	CurrentRevision            *RevisionResult
	Installments               []*InstallmentResult
	ActiveAllocationAggregates []*AllocationAggregate
	InstallmentProgress        []*InstallmentProgress
	Progress                   PlanProgress
	Remaining                  PlanRemaining
	LedgerOutstandingAmount    *int64
	LedgerPlanDifferenceAmount *int64
	InvalidAllocationCount     int64
	ActionRequired             bool
	ReasonCodes                []ServiceErrorCode
	LatestSettlementActionId   *int64
}

// DashboardAllocation 是可信总览分类实际现金流所需的最小活动关系。
// 它只暴露正式交易 ID、组件和金额，不暴露 binding、action 或幂等摘要。
type DashboardAllocation struct {
	TransactionId   int64
	ContractId      int64
	AllocationId    int64
	ComponentType   ComponentType
	AllocatedAmount int64
}

func calculationInput(terms CalculationTerms) calculation.Input {
	return calculation.Input{
		PrincipalAmount: terms.PrincipalAmount, ActualDisbursementAmount: terms.ActualDisbursementAmount,
		UpfrontFeeAmount: terms.UpfrontFeeAmount, PerPeriodFeeAmount: terms.PerPeriodFeeAmount,
		PaymentBasisAmount: cloneInt64(terms.PaymentBasisAmount), TermCount: terms.TermCount,
		FirstDueDate: terms.FirstDueDate, InputMode: calculation.InputMode(terms.InputMode),
		RepaymentMethod: calculation.RepaymentMethod(terms.RepaymentMethod), RateQuoteType: calculation.RateQuoteType(terms.RateQuoteType),
		QuotedRatePPTR: cloneInt64(terms.QuotedRatePptr), DiscountType: calculation.DiscountType(terms.DiscountType),
		DiscountRatePPTR: cloneInt64(terms.DiscountRatePptr), DiscountAmount: terms.DiscountAmount,
	}
}
