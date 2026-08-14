package dashboard

import (
	"errors"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
)

const (
	MaximumLedgerTransactionCount  = 100000
	MaximumImportBatchCount        = 100000
	MaximumActiveLoanContractCount = 10000
	MinimumCashFlowMonths          = 1
	MaximumCashFlowMonths          = 24
	FutureDebtCurveMonths          = 12
	MinimumFirstDayOfWeek          = 0
	MaximumFirstDayOfWeek          = 6
)

var (
	ErrInvalidQuery       = errors.New("dashboard query is invalid")
	ErrReadLimitReached   = errors.New("dashboard read limit reached")
	ErrDependencyFailure  = errors.New("dashboard dependency failed")
	ErrInvariantViolation = errors.New("dashboard invariant violation")
)

type LedgerAccountKind string

const (
	LedgerAccountKindAsset      LedgerAccountKind = "asset"
	LedgerAccountKindCreditCard LedgerAccountKind = "credit_card"
	LedgerAccountKindDebt       LedgerAccountKind = "debt"
)

type LedgerTransactionType string

const (
	LedgerTransactionModifyBalance LedgerTransactionType = "modify_balance"
	LedgerTransactionIncome        LedgerTransactionType = "income"
	LedgerTransactionExpense       LedgerTransactionType = "expense"
	LedgerTransactionTransferOut   LedgerTransactionType = "transfer_out"
	LedgerTransactionTransferIn    LedgerTransactionType = "transfer_in"
)

// LedgerAccount 是总览所需的最小账户事实；名称、备注和显示属性不会进入聚合层。
type LedgerAccount struct {
	AccountId      int64
	Kind           LedgerAccountKind
	Currency       string
	CurrentBalance int64
	Liquid         bool
	Hidden         bool
	Single         bool
}

// LedgerTransaction 是总览所需的最小正式交易事实。
type LedgerTransaction struct {
	TransactionId   int64
	Type            LedgerTransactionType
	AccountId       int64
	TransactionTime int64
	Amount          int64
	Adjustment      int64
}

type LedgerData struct {
	Accounts     []*LedgerAccount
	Transactions []*LedgerTransaction
}

type LedgerReader interface {
	ReadLedgerData(c core.Context, uid int64, minimumTransactionTime int64, maximumTransactions int) (*LedgerData, error)
}

type LoanReader interface {
	ListContracts(c core.Context, uid int64, status loans.ContractStatus, cursor *loans.ContractCursor, limit int, asOfDate string) (*loans.ContractListResult, error)
	GetContract(c core.Context, uid int64, contractId int64, asOfDate string) (*loans.ContractDetail, error)
	ListDashboardAllocations(c core.Context, uid int64) ([]*loans.DashboardAllocation, error)
}

type ImportReader interface {
	ListSourceAccounts(c core.Context, uid int64) ([]*importing.SourceAccount, error)
	ListImportBatches(c core.Context, uid int64, fileId int64, offset int, limit int) ([]*importing.ImportBatch, int64, error)
}

type Query struct {
	Uid            int64
	StartDate      string
	AsOfDate       string
	Months         int
	FirstDayOfWeek int
	Location       *time.Location
	GeneratedAt    time.Time
}

type AccountCurrencySnapshot struct {
	Currency             string
	Assets               int64
	Liabilities          int64
	NetWorth             int64
	LiquidFunds          int64
	CreditCardLiability  int64
	DebtAccountLiability int64
}

type CashFlowCurrency struct {
	Currency             string
	Income               int64
	Consumption          int64
	BalanceAdjustment    int64
	LoanPrincipal        int64
	LoanInterest         int64
	LoanFee              int64
	LoanDisbursement     int64
	InternalTransfer     int64
	LiquidFundsNetChange int64
}

type MonthlyCashFlow struct {
	Month   string
	Amounts []*CashFlowCurrency
}

type CashFlowPeriodKind string

const (
	CashFlowPeriodToday CashFlowPeriodKind = "today"
	CashFlowPeriodWeek  CashFlowPeriodKind = "week"
	CashFlowPeriodMonth CashFlowPeriodKind = "month"
	CashFlowPeriodYear  CashFlowPeriodKind = "year"
)

type CashFlowPeriod struct {
	Kind      CashFlowPeriodKind
	StartDate string
	EndDate   string
	Amounts   []*CashFlowCurrency
}

type DebtCurrencySummary struct {
	Currency                  string
	PlannedRemainingPrincipal int64
	OverduePayment            int64
	DueWithin7Days            int64
	DueWithin30Days           int64
	DueThisMonth              int64
}

type DebtContractSummary struct {
	ContractId            int64
	Name                  string
	Currency              string
	RemainingPrincipal    int64
	RemainingInstallments int64
	EffectiveAprPptr      *int64
	NextDueDate           *string
	NextDueAmount         int64
	LedgerOutstanding     *int64
	LedgerPlanDifference  *int64
	ActionRequired        bool
}

type DebtCurveCurrency struct {
	Currency string
	Payment  int64
}

type DebtCurveMonth struct {
	Month   string
	Amounts []*DebtCurveCurrency
}

type DebtSummary struct {
	Amounts     []*DebtCurrencySummary
	Contracts   []*DebtContractSummary
	FutureCurve []*DebtCurveMonth
}

type DateRange struct {
	StartDate string
	EndDate   string
}

type SourceCoverage struct {
	SourceAccountId   int64
	MaskedDisplayName string
	LedgerAccountId   *int64
	Intervals         []*DateRange
	Gaps              []*DateRange
	Overlaps          []*DateRange
	LatestCoveredDate *string
	UnknownPeriod     bool
}

type CoverageSummary struct {
	SourceAccountCount       int64
	MappedAccountCount       int64
	CoveredAccountCount      int64
	AccountsWithGaps         int64
	LatestCoveredDate        *string
	PendingRowCount          int64
	InvalidRowCount          int64
	ExactDuplicateRowCount   int64
	IdentityConflictRowCount int64
	FailedBatchCount         int64
	UnconfirmedExcluded      bool
	Complete                 bool
	Accounts                 []*SourceCoverage
}

type TrustSummary struct {
	LedgerTransactionCount       int64
	ActiveLoanContractCount      int64
	LoanClassificationIssueCount int64
	AmountsGroupedByCurrency     bool
	HistoricalBalanceDerived     bool
	HasWarnings                  bool
}

type Overview struct {
	StartDate         string
	AsOfDate          string
	GeneratedUnixTime int64
	AccountSnapshot   []*AccountCurrencySnapshot
	MonthlyCashFlow   []*MonthlyCashFlow
	CashFlowPeriods   []*CashFlowPeriod
	Debt              *DebtSummary
	Coverage          *CoverageSummary
	Trust             *TrustSummary
}
