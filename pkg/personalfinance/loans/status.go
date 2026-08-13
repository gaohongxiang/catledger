package loans

// RuleVersion 标识会影响贷款持久结果或幂等语义的规则版本。
type RuleVersion string

const (
	CALCULATION_VERSION_V1           RuleVersion = "loan-calculation-v1"
	ROUNDING_VERSION_V1              RuleVersion = "loan-rounding-half-up-v1"
	IRR_VERSION_V1                   RuleVersion = "periodic-irr-v1"
	IDEMPOTENCY_KEY_VERSION_V1       RuleVersion = "idempotency-key-v1"
	ACTION_REQUEST_DIGEST_VERSION_V1 RuleVersion = "loan-action-request-v1"
)

// ContractType 表示合同的展示类型，不承担产品推荐或风险评价语义。
type ContractType string

const (
	CONTRACT_TYPE_CREDIT_CARD_INSTALLMENT ContractType = "credit_card_installment"
	CONTRACT_TYPE_BANK_LOAN               ContractType = "bank_loan"
	CONTRACT_TYPE_CONSUMER_LOAN           ContractType = "consumer_loan"
	CONTRACT_TYPE_PERSONAL_LOAN           ContractType = "personal_loan"
)

// ContractStatus 表示贷款合同生命周期状态。
type ContractStatus string

const (
	CONTRACT_STATUS_ACTIVE    ContractStatus = "active"
	CONTRACT_STATUS_CLOSED    ContractStatus = "closed"
	CONTRACT_STATUS_CANCELLED ContractStatus = "cancelled"
)

// CloseReasonCode 表示合同关闭原因；未关闭时持久化空字符串。
type CloseReasonCode string

const (
	CLOSE_REASON_NONE         CloseReasonCode = ""
	CLOSE_REASON_PAID_OFF     CloseReasonCode = "paid_off"
	CLOSE_REASON_MANUAL_CLOSE CloseReasonCode = "manual_close"
	CLOSE_REASON_WRITTEN_OFF  CloseReasonCode = "written_off"
)

// FundingType 表示合同取得资金或形成分期负债的方式。
type FundingType string

const (
	FUNDING_TYPE_CASH_DISBURSEMENT    FundingType = "cash_disbursement"
	FUNDING_TYPE_PURCHASE_INSTALLMENT FundingType = "purchase_installment"
)

// InputMode 表示计算输入以报价利率还是已知还款额为依据。
type InputMode string

const (
	INPUT_MODE_RATE      InputMode = "rate"
	INPUT_MODE_REPAYMENT InputMode = "repayment"
)

// RepaymentMethod 表示首版支持的标准还款方式。
type RepaymentMethod string

const (
	REPAYMENT_METHOD_FLAT            RepaymentMethod = "flat"
	REPAYMENT_METHOD_EQUAL_PAYMENT   RepaymentMethod = "equal_payment"
	REPAYMENT_METHOD_EQUAL_PRINCIPAL RepaymentMethod = "equal_principal"
	REPAYMENT_METHOD_INTEREST_ONLY   RepaymentMethod = "interest_only"
)

// RateQuoteType 表示用户提供的报价利率周期口径。
type RateQuoteType string

const (
	RATE_QUOTE_TYPE_ANNUAL      RateQuoteType = "annual"
	RATE_QUOTE_TYPE_MONTHLY     RateQuoteType = "monthly"
	RATE_QUOTE_TYPE_DAILY       RateQuoteType = "daily"
	RATE_QUOTE_TYPE_INSTALLMENT RateQuoteType = "installment"
)

// FrequencyType 表示计划频率；首版固定 monthly / 1。
type FrequencyType string

const FREQUENCY_TYPE_MONTHLY FrequencyType = "monthly"

// DiscountType 表示折扣或减免如何作用于计划。
type DiscountType string

const (
	DISCOUNT_TYPE_NONE                 DiscountType = "none"
	DISCOUNT_TYPE_INTEREST_DISCOUNT    DiscountType = "interest_discount"
	DISCOUNT_TYPE_PER_PERIOD_REDUCTION DiscountType = "per_period_reduction"
	DISCOUNT_TYPE_TOTAL_REDUCTION      DiscountType = "total_reduction"
)

// IRRStatus 表示月度 IRR 求解结果；非 solved 状态不得持久化率值。
type IRRStatus string

const (
	IRR_STATUS_SOLVED                 IRRStatus = "solved"
	IRR_STATUS_SOLVED_ZERO            IRRStatus = "solved_zero"
	IRR_STATUS_NO_NONNEGATIVE_ROOT    IRRStatus = "no_nonnegative_root"
	IRR_STATUS_INSUFFICIENT_CASHFLOWS IRRStatus = "insufficient_cashflows"
	IRR_STATUS_OUT_OF_RANGE           IRRStatus = "out_of_range"
)

// ActionType 表示追加式贷款命令的固定类型。
type ActionType string

const (
	ACTION_TYPE_CREATE_CONTRACT    ActionType = "create_contract"
	ACTION_TYPE_REVISE_CONTRACT    ActionType = "revise_contract"
	ACTION_TYPE_APPLY_SETTLEMENT   ActionType = "apply_settlement"
	ACTION_TYPE_REVERSE_SETTLEMENT ActionType = "reverse_settlement"
	ACTION_TYPE_CLOSE_CONTRACT     ActionType = "close_contract"
	ACTION_TYPE_REOPEN_CONTRACT    ActionType = "reopen_contract"
	ACTION_TYPE_CANCEL_CONTRACT    ActionType = "cancel_contract"
)

// ActionStatus 表示持久幂等命令的执行状态。
type ActionStatus string

const (
	ACTION_STATUS_READY           ActionStatus = "ready"
	ACTION_STATUS_APPLYING        ActionStatus = "applying"
	ACTION_STATUS_APPLIED         ActionStatus = "applied"
	ACTION_STATUS_ACTION_REQUIRED ActionStatus = "action_required"
	ACTION_STATUS_FAILED          ActionStatus = "failed"
)

// ComponentType 表示一笔逻辑正式事件承担的单一贷款组件。
type ComponentType string

const (
	COMPONENT_TYPE_DISBURSEMENT ComponentType = "disbursement"
	COMPONENT_TYPE_PRINCIPAL    ComponentType = "principal"
	COMPONENT_TYPE_INTEREST     ComponentType = "interest"
	COMPONENT_TYPE_FEE          ComponentType = "fee"
)

// AllocationCreationMethod 表示分配复用既有事件还是由贷款动作创建事件。
type AllocationCreationMethod string

const (
	ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING AllocationCreationMethod = "attached_existing"
	ALLOCATION_CREATION_METHOD_LOAN_CREATED      AllocationCreationMethod = "loan_created"
)

// AllocationStatus 表示当前或历史正式交易分配的状态。
type AllocationStatus string

const (
	ALLOCATION_STATUS_ACTIVE          AllocationStatus = "active"
	ALLOCATION_STATUS_REVERSED        AllocationStatus = "reversed"
	ALLOCATION_STATUS_ACTION_REQUIRED AllocationStatus = "action_required"
)

// InstallmentProgressStatus 由活动 allocation 聚合派生，不持久化到逐期计划。
type InstallmentProgressStatus string

const (
	INSTALLMENT_PROGRESS_UNPAID  InstallmentProgressStatus = "unpaid"
	INSTALLMENT_PROGRESS_PARTIAL InstallmentProgressStatus = "partial"
	INSTALLMENT_PROGRESS_PAID    InstallmentProgressStatus = "paid"
)

func isContractStatus(value ContractStatus) bool {
	return value == CONTRACT_STATUS_ACTIVE || value == CONTRACT_STATUS_CLOSED || value == CONTRACT_STATUS_CANCELLED
}

func isContractType(value ContractType) bool {
	return value == CONTRACT_TYPE_CREDIT_CARD_INSTALLMENT || value == CONTRACT_TYPE_BANK_LOAN ||
		value == CONTRACT_TYPE_CONSUMER_LOAN || value == CONTRACT_TYPE_PERSONAL_LOAN
}

func isCloseReason(value CloseReasonCode) bool {
	return value == CLOSE_REASON_NONE || value == CLOSE_REASON_PAID_OFF || value == CLOSE_REASON_MANUAL_CLOSE || value == CLOSE_REASON_WRITTEN_OFF
}

func isFundingType(value FundingType) bool {
	return value == FUNDING_TYPE_CASH_DISBURSEMENT || value == FUNDING_TYPE_PURCHASE_INSTALLMENT
}

func isInputMode(value InputMode) bool {
	return value == INPUT_MODE_RATE || value == INPUT_MODE_REPAYMENT
}

func isRepaymentMethod(value RepaymentMethod) bool {
	return value == REPAYMENT_METHOD_FLAT || value == REPAYMENT_METHOD_EQUAL_PAYMENT ||
		value == REPAYMENT_METHOD_EQUAL_PRINCIPAL || value == REPAYMENT_METHOD_INTEREST_ONLY
}

func isRateQuoteType(value RateQuoteType) bool {
	return value == RATE_QUOTE_TYPE_ANNUAL || value == RATE_QUOTE_TYPE_MONTHLY ||
		value == RATE_QUOTE_TYPE_DAILY || value == RATE_QUOTE_TYPE_INSTALLMENT
}

func isDiscountType(value DiscountType) bool {
	return value == DISCOUNT_TYPE_NONE || value == DISCOUNT_TYPE_INTEREST_DISCOUNT ||
		value == DISCOUNT_TYPE_PER_PERIOD_REDUCTION || value == DISCOUNT_TYPE_TOTAL_REDUCTION
}

func isIRRStatus(value IRRStatus) bool {
	return value == IRR_STATUS_SOLVED || value == IRR_STATUS_SOLVED_ZERO || value == IRR_STATUS_NO_NONNEGATIVE_ROOT ||
		value == IRR_STATUS_INSUFFICIENT_CASHFLOWS || value == IRR_STATUS_OUT_OF_RANGE
}

func isActionType(value ActionType) bool {
	return value == ACTION_TYPE_CREATE_CONTRACT || value == ACTION_TYPE_REVISE_CONTRACT || value == ACTION_TYPE_APPLY_SETTLEMENT ||
		value == ACTION_TYPE_REVERSE_SETTLEMENT || value == ACTION_TYPE_CLOSE_CONTRACT || value == ACTION_TYPE_REOPEN_CONTRACT ||
		value == ACTION_TYPE_CANCEL_CONTRACT
}

func isActionStatus(value ActionStatus) bool {
	return value == ACTION_STATUS_READY || value == ACTION_STATUS_APPLYING || value == ACTION_STATUS_APPLIED ||
		value == ACTION_STATUS_ACTION_REQUIRED || value == ACTION_STATUS_FAILED
}

func isAllocationStatus(value AllocationStatus) bool {
	return value == ALLOCATION_STATUS_ACTIVE || value == ALLOCATION_STATUS_REVERSED || value == ALLOCATION_STATUS_ACTION_REQUIRED
}

func isComponentType(value ComponentType) bool {
	return value == COMPONENT_TYPE_DISBURSEMENT || value == COMPONENT_TYPE_PRINCIPAL || value == COMPONENT_TYPE_INTEREST || value == COMPONENT_TYPE_FEE
}

func isAllocationCreationMethod(value AllocationCreationMethod) bool {
	return value == ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING || value == ALLOCATION_CREATION_METHOD_LOAN_CREATED
}
