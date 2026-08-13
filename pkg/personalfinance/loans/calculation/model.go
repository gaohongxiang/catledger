package calculation

import "errors"

const (
	// CalculationVersion 标识冻结的贷款计划算法。
	CalculationVersion = "loan-calculation-v1"
	// RoundingVersion 标识正金额舍入规则。
	RoundingVersion = "loan-rounding-half-up-v1"
	// IRRVersion 标识月度等间隔 IRR 算法。
	IRRVersion = "periodic-irr-v1"
	// ScheduleDigestVersion 标识计划摘要的规范编码。
	ScheduleDigestVersion = "schedule-digest-v1"

	// PPTRScale 是 1.0 的定点整数表示。
	PPTRScale int64 = 1_000_000_000_000
	// MaxIRRPPTR 是 periodic-irr-v1 使用的闭区间上界。
	MaxIRRPPTR int64 = 2_000_000_000_000
	// MaxTermCount 以 100 年月度计划限制纯计算入口的最大工作量。
	MaxTermCount int64 = 1_200
)

var (
	ErrInvalidInput     = errors.New("invalid loan calculation input")
	ErrInvalidCashflows = errors.New("invalid periodic IRR cashflows")
	ErrInvalidResult    = errors.New("invalid loan calculation result")
	ErrOverflow         = errors.New("loan calculation overflow")
)

// InputMode 表示计划按合同利率或已知应还额生成。
type InputMode string

const (
	InputModeRate      InputMode = "rate"
	InputModeRepayment InputMode = "repayment"
)

// RepaymentMethod 标识首版四种月度还款方式之一。
type RepaymentMethod string

const (
	RepaymentMethodFlat           RepaymentMethod = "flat"
	RepaymentMethodEqualPayment   RepaymentMethod = "equal_payment"
	RepaymentMethodEqualPrincipal RepaymentMethod = "equal_principal"
	RepaymentMethodInterestOnly   RepaymentMethod = "interest_only"
)

// RateQuoteType 标识合同报价利率口径。
type RateQuoteType string

const (
	RateQuoteTypeAnnual      RateQuoteType = "annual"
	RateQuoteTypeMonthly     RateQuoteType = "monthly"
	RateQuoteTypeDaily       RateQuoteType = "daily"
	RateQuoteTypeInstallment RateQuoteType = "installment"
)

// DiscountType 标识首版互斥优惠方式。
type DiscountType string

const (
	DiscountTypeNone         DiscountType = "none"
	DiscountTypeInterestRate DiscountType = "interest_rate"
	DiscountTypePerPeriod    DiscountType = "per_period"
	DiscountTypeTotal        DiscountType = "total"
)

// IRRStatus 表示 periodic-irr-v1 是否生成可持久化利率。
type IRRStatus string

const (
	IRRStatusSolved            IRRStatus = "solved"
	IRRStatusSolvedZero        IRRStatus = "solved_zero"
	IRRStatusNoNonnegativeRoot IRRStatus = "no_nonnegative_root"
	IRRStatusInsufficientFlows IRRStatus = "insufficient_cashflows"
	IRRStatusOutOfRange        IRRStatus = "out_of_range"
)

// Input 是 loan-calculation-v1 的规范计算输入。金额使用非负最小货币单位整数，
// 比例使用 pptr；可空合同字段使用指针，避免把非法的零值/NULL 组合静默归一化。
type Input struct {
	PrincipalAmount          int64
	ActualDisbursementAmount int64
	UpfrontFeeAmount         int64
	PerPeriodFeeAmount       int64
	PaymentBasisAmount       *int64
	TermCount                int64
	FirstDueDate             string
	InputMode                InputMode
	RepaymentMethod          RepaymentMethod
	RateQuoteType            RateQuoteType
	QuotedRatePPTR           *int64
	DiscountType             DiscountType
	DiscountRatePPTR         *int64
	DiscountAmount           int64
}

// Installment 包含 v004 持久化的不可变逐期字段。PreDiscount 前缀字段表示
// 优惠前计划，其余金额字段表示优惠后的实际应付计划。
type Installment struct {
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

// IRRResult 对无解状态保留空利率；零利率使用指向 0 的非空指针表示。
type IRRResult struct {
	Status           IRRStatus
	MonthlyIRRPPTR   *int64
	SimpleAPRPPTR    *int64
	EffectiveAPRPPTR *int64
}

// Result 是 loan-calculation-v1 的完整确定性输出。
type Result struct {
	CalculationVersion            string
	RoundingVersion               string
	IRRVersion                    string
	ActualDisbursementAmount      int64
	PeriodicRatePPTR              int64
	ScheduleDigest                string
	Installments                  []Installment
	PreDiscountTotalPaymentAmount int64
	PreDiscountTotalCostAmount    int64
	TotalPaymentAmount            int64
	TotalInterestAmount           int64
	TotalFeeAmount                int64
	TotalDiscountAmount           int64
	TotalCostAmount               int64
	CostRatioPPTR                 int64
	IRR                           IRRResult
}

// ValidationError 只报告稳定字段和原因，不携带用户输入的金额或日期。
type ValidationError struct {
	Kind   error
	Field  string
	Reason string
}

func (err *ValidationError) Error() string {
	return err.Kind.Error() + ": " + err.Field + ": " + err.Reason
}

func (err *ValidationError) Unwrap() error {
	return err.Kind
}

func invalidInput(field, reason string) error {
	return &ValidationError{Kind: ErrInvalidInput, Field: field, Reason: reason}
}

func invalidCashflows(reason string) error {
	return &ValidationError{Kind: ErrInvalidCashflows, Field: "cashflows", Reason: reason}
}

func invalidResult(field, reason string) error {
	return &ValidationError{Kind: ErrInvalidResult, Field: field, Reason: reason}
}
