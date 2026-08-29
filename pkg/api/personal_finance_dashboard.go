package api

import (
	"errors"
	"net/url"
	"strconv"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/dashboard"
)

type PersonalFinanceDashboardApplication interface {
	GetOverview(c core.Context, query dashboard.Query) (*dashboard.Overview, error)
}

var _ PersonalFinanceDashboardApplication = (*dashboard.Service)(nil)

type PersonalFinanceDashboardApi struct {
	application PersonalFinanceDashboardApplication
}

func NewPersonalFinanceDashboardApi(application PersonalFinanceDashboardApplication) (*PersonalFinanceDashboardApi, error) {
	if application == nil {
		return nil, errors.New("personal finance dashboard application is required")
	}
	return &PersonalFinanceDashboardApi{application: application}, nil
}

type personalFinanceDashboardAccountAmountResponse struct {
	Currency             string `json:"currency"`
	Assets               string `json:"assets"`
	Liabilities          string `json:"liabilities"`
	NetWorth             string `json:"netWorth"`
	LiquidFunds          string `json:"liquidFunds"`
	CreditCardLiability  string `json:"creditCardLiability"`
	DebtAccountLiability string `json:"debtAccountLiability"`
}

type personalFinanceDashboardCashFlowAmountResponse struct {
	Currency             string `json:"currency"`
	Income               string `json:"income"`
	Consumption          string `json:"consumption"`
	BalanceAdjustment    string `json:"balanceAdjustment"`
	LoanPrincipal        string `json:"loanPrincipal"`
	LoanInterest         string `json:"loanInterest"`
	LoanFee              string `json:"loanFee"`
	LoanDisbursement     string `json:"loanDisbursement"`
	InternalTransfer     string `json:"internalTransfer"`
	LiquidFundsNetChange string `json:"liquidFundsNetChange"`
}

type personalFinanceDashboardCashFlowResponse struct {
	Month   string                                            `json:"month"`
	Amounts []*personalFinanceDashboardCashFlowAmountResponse `json:"amounts"`
}

type personalFinanceDashboardCashFlowPeriodResponse struct {
	Kind      dashboard.CashFlowPeriodKind                      `json:"kind"`
	StartDate string                                            `json:"startDate"`
	EndDate   string                                            `json:"endDate"`
	Amounts   []*personalFinanceDashboardCashFlowAmountResponse `json:"amounts"`
}

type personalFinanceDashboardDebtAmountResponse struct {
	Currency                  string `json:"currency"`
	PlannedRemainingPrincipal string `json:"plannedRemainingPrincipal"`
	OverduePayment            string `json:"overduePayment"`
	DueWithin7Days            string `json:"dueWithin7Days"`
	DueWithin30Days           string `json:"dueWithin30Days"`
	DueThisMonth              string `json:"dueThisMonth"`
}

type personalFinanceDashboardDebtContractResponse struct {
	ContractId            string  `json:"contractId"`
	Name                  string  `json:"name"`
	Currency              string  `json:"currency"`
	RemainingPrincipal    string  `json:"remainingPrincipal"`
	RemainingInstallments int64   `json:"remainingInstallments"`
	EffectiveAprPptr      *string `json:"effectiveAprPptr"`
	NextDueDate           *string `json:"nextDueDate"`
	NextDueAmount         string  `json:"nextDueAmount"`
	LedgerOutstanding     *string `json:"ledgerOutstanding"`
	LedgerPlanDifference  *string `json:"ledgerPlanDifference"`
	ActionRequired        bool    `json:"actionRequired"`
}

type personalFinanceDashboardDebtCurveAmountResponse struct {
	Currency string `json:"currency"`
	Payment  string `json:"payment"`
}

type personalFinanceDashboardDebtCurveResponse struct {
	Month   string                                             `json:"month"`
	Amounts []*personalFinanceDashboardDebtCurveAmountResponse `json:"amounts"`
}

type personalFinanceDashboardDebtResponse struct {
	Amounts     []*personalFinanceDashboardDebtAmountResponse   `json:"amounts"`
	Contracts   []*personalFinanceDashboardDebtContractResponse `json:"contracts"`
	FutureCurve []*personalFinanceDashboardDebtCurveResponse    `json:"futureCurve"`
}

type personalFinanceDashboardDateRangeResponse struct {
	StartDate string `json:"startDate"`
	EndDate   string `json:"endDate"`
}

type personalFinanceDashboardSourceCoverageResponse struct {
	SourceAccountId   string                                       `json:"sourceAccountId"`
	MaskedDisplayName string                                       `json:"maskedDisplayName"`
	LedgerAccountId   *string                                      `json:"ledgerAccountId"`
	Intervals         []*personalFinanceDashboardDateRangeResponse `json:"intervals"`
	Gaps              []*personalFinanceDashboardDateRangeResponse `json:"gaps"`
	Overlaps          []*personalFinanceDashboardDateRangeResponse `json:"overlaps"`
	LatestCoveredDate *string                                      `json:"latestCoveredDate"`
	UnknownPeriod     bool                                         `json:"unknownPeriod"`
}

type personalFinanceDashboardCoverageResponse struct {
	SourceAccountCount       int64                                             `json:"sourceAccountCount"`
	MappedAccountCount       int64                                             `json:"mappedAccountCount"`
	CoveredAccountCount      int64                                             `json:"coveredAccountCount"`
	AccountsWithGaps         int64                                             `json:"accountsWithGaps"`
	LatestCoveredDate        *string                                           `json:"latestCoveredDate"`
	PendingRowCount          int64                                             `json:"pendingRowCount"`
	InvalidRowCount          int64                                             `json:"invalidRowCount"`
	ExactDuplicateRowCount   int64                                             `json:"exactDuplicateRowCount"`
	IdentityConflictRowCount int64                                             `json:"identityConflictRowCount"`
	FailedBatchCount         int64                                             `json:"failedBatchCount"`
	UnconfirmedExcluded      bool                                              `json:"unconfirmedExcluded"`
	Complete                 bool                                              `json:"complete"`
	Accounts                 []*personalFinanceDashboardSourceCoverageResponse `json:"accounts"`
}

type personalFinanceDashboardTrustResponse struct {
	LedgerTransactionCount       int64 `json:"ledgerTransactionCount"`
	ActiveLoanContractCount      int64 `json:"activeLoanContractCount"`
	LoanClassificationIssueCount int64 `json:"loanClassificationIssueCount"`
	AmountsGroupedByCurrency     bool  `json:"amountsGroupedByCurrency"`
	HistoricalBalanceDerived     bool  `json:"historicalBalanceDerived"`
	HasWarnings                  bool  `json:"hasWarnings"`
}

type personalFinanceDashboardDrilldownResponse struct {
	Accounts     string `json:"accounts"`
	Transactions string `json:"transactions"`
	Loans        string `json:"loans"`
	Imports      string `json:"imports"`
}

type personalFinanceDashboardResponse struct {
	StartDate         string                                            `json:"startDate"`
	AsOfDate          string                                            `json:"asOfDate"`
	GeneratedUnixTime int64                                             `json:"generatedUnixTime"`
	AccountSnapshot   []*personalFinanceDashboardAccountAmountResponse  `json:"accountSnapshot"`
	MonthlyCashFlow   []*personalFinanceDashboardCashFlowResponse       `json:"monthlyCashFlow"`
	CashFlowPeriods   []*personalFinanceDashboardCashFlowPeriodResponse `json:"cashFlowPeriods"`
	Debt              *personalFinanceDashboardDebtResponse             `json:"debt"`
	Coverage          *personalFinanceDashboardCoverageResponse         `json:"coverage"`
	Trust             *personalFinanceDashboardTrustResponse            `json:"trust"`
	Drilldown         *personalFinanceDashboardDrilldownResponse        `json:"drilldown"`
}

func (a *PersonalFinanceDashboardApi) OverviewHandler(c *core.WebContext) (any, *errs.Error) {
	if a == nil || a.application == nil || c == nil || c.Request == nil {
		return nil, errs.ErrOperationFailed
	}
	startDate, asOfDate, months, firstDayOfWeek, err := parsePersonalFinanceDashboardQuery(c.Request.URL.Query())
	if err != nil {
		return nil, errs.ErrParameterInvalid
	}
	location, timezoneErr := c.GetClientTimezone()
	if timezoneErr != nil || location == nil {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}
	result, serviceErr := a.application.GetOverview(c, dashboard.Query{
		Uid: c.GetCurrentUid(), StartDate: startDate, AsOfDate: asOfDate, Months: months,
		FirstDayOfWeek: firstDayOfWeek, Location: location,
	})
	if serviceErr != nil {
		if errors.Is(serviceErr, dashboard.ErrInvalidQuery) {
			return nil, errs.ErrParameterInvalid
		}
		log.Warnf(c, "[personal_finance_dashboard.overview] failed for user \"uid:%d\"", c.GetCurrentUid())
		return nil, errs.ErrOperationFailed
	}
	response, responseErr := newPersonalFinanceDashboardResponse(result)
	if responseErr != nil {
		log.Errorf(c, "[personal_finance_dashboard.overview] invalid result for user \"uid:%d\"", c.GetCurrentUid())
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

func parsePersonalFinanceDashboardQuery(values url.Values) (string, string, int, int, error) {
	if len(values) < 3 || len(values) > 4 || len(values["start_date"]) != 1 || len(values["as_of_date"]) != 1 || len(values["months"]) != 1 {
		return "", "", 0, 0, errors.New("dashboard query keys are invalid")
	}
	for key := range values {
		if key != "start_date" && key != "as_of_date" && key != "months" && key != "week_start" {
			return "", "", 0, 0, errors.New("dashboard query key is unknown")
		}
	}
	months, err := strconv.Atoi(values.Get("months"))
	if err != nil || months < dashboard.MinimumCashFlowMonths || months > dashboard.MaximumCashFlowMonths {
		return "", "", 0, 0, errors.New("dashboard month count is invalid")
	}
	startDate := values.Get("start_date")
	asOfDate := values.Get("as_of_date")
	if startDate == "" || asOfDate == "" {
		return "", "", 0, 0, errors.New("dashboard dates are required")
	}
	firstDayOfWeek := dashboard.MinimumFirstDayOfWeek
	if raw, exists := values["week_start"]; exists {
		if len(raw) != 1 {
			return "", "", 0, 0, errors.New("dashboard week start is repeated")
		}
		firstDayOfWeek, err = strconv.Atoi(raw[0])
		if err != nil || firstDayOfWeek < dashboard.MinimumFirstDayOfWeek || firstDayOfWeek > dashboard.MaximumFirstDayOfWeek {
			return "", "", 0, 0, errors.New("dashboard week start is invalid")
		}
	}
	return startDate, asOfDate, months, firstDayOfWeek, nil
}

func newPersonalFinanceDashboardResponse(value *dashboard.Overview) (*personalFinanceDashboardResponse, error) {
	if value == nil || value.Debt == nil || value.Coverage == nil || value.Trust == nil || value.StartDate == "" || value.AsOfDate == "" || value.GeneratedUnixTime < 1 {
		return nil, errors.New("dashboard result is incomplete")
	}
	coverage, err := dashboardCoverageResponse(value.Coverage)
	if err != nil {
		return nil, err
	}
	response := &personalFinanceDashboardResponse{
		StartDate: value.StartDate, AsOfDate: value.AsOfDate, GeneratedUnixTime: value.GeneratedUnixTime,
		AccountSnapshot: make([]*personalFinanceDashboardAccountAmountResponse, 0, len(value.AccountSnapshot)),
		MonthlyCashFlow: make([]*personalFinanceDashboardCashFlowResponse, 0, len(value.MonthlyCashFlow)),
		CashFlowPeriods: make([]*personalFinanceDashboardCashFlowPeriodResponse, 0, len(value.CashFlowPeriods)),
		Debt: &personalFinanceDashboardDebtResponse{
			Amounts:     make([]*personalFinanceDashboardDebtAmountResponse, 0, len(value.Debt.Amounts)),
			Contracts:   make([]*personalFinanceDashboardDebtContractResponse, 0, len(value.Debt.Contracts)),
			FutureCurve: make([]*personalFinanceDashboardDebtCurveResponse, 0, len(value.Debt.FutureCurve)),
		},
		Coverage: coverage,
		Trust: &personalFinanceDashboardTrustResponse{
			LedgerTransactionCount:       value.Trust.LedgerTransactionCount,
			ActiveLoanContractCount:      value.Trust.ActiveLoanContractCount,
			LoanClassificationIssueCount: value.Trust.LoanClassificationIssueCount,
			AmountsGroupedByCurrency:     value.Trust.AmountsGroupedByCurrency,
			HistoricalBalanceDerived:     value.Trust.HistoricalBalanceDerived,
			HasWarnings:                  value.Trust.HasWarnings,
		},
		Drilldown: &personalFinanceDashboardDrilldownResponse{
			Accounts: "/account/list", Transactions: "/transaction/list", Loans: "/personal-finance/loans", Imports: "/personal-finance/imports",
		},
	}
	for _, item := range value.AccountSnapshot {
		if item == nil {
			return nil, errors.New("dashboard account amount is nil")
		}
		response.AccountSnapshot = append(response.AccountSnapshot, &personalFinanceDashboardAccountAmountResponse{
			Currency: item.Currency, Assets: formatDashboardAmount(item.Assets), Liabilities: formatDashboardAmount(item.Liabilities),
			NetWorth: formatDashboardAmount(item.NetWorth), LiquidFunds: formatDashboardAmount(item.LiquidFunds),
			CreditCardLiability: formatDashboardAmount(item.CreditCardLiability), DebtAccountLiability: formatDashboardAmount(item.DebtAccountLiability),
		})
	}
	for _, month := range value.MonthlyCashFlow {
		if month == nil {
			return nil, errors.New("dashboard cash flow month is nil")
		}
		amounts, err := dashboardCashFlowAmountResponses(month.Amounts)
		if err != nil {
			return nil, err
		}
		response.MonthlyCashFlow = append(response.MonthlyCashFlow, &personalFinanceDashboardCashFlowResponse{Month: month.Month, Amounts: amounts})
	}
	expectedPeriods := []dashboard.CashFlowPeriodKind{
		dashboard.CashFlowPeriodToday, dashboard.CashFlowPeriodWeek, dashboard.CashFlowPeriodMonth, dashboard.CashFlowPeriodYear,
	}
	if len(value.CashFlowPeriods) != len(expectedPeriods) {
		return nil, errors.New("dashboard cash flow periods are incomplete")
	}
	for index, period := range value.CashFlowPeriods {
		if period == nil || period.Kind != expectedPeriods[index] || period.StartDate == "" || period.EndDate != value.AsOfDate || period.StartDate > period.EndDate {
			return nil, errors.New("dashboard cash flow period is invalid")
		}
		amounts, err := dashboardCashFlowAmountResponses(period.Amounts)
		if err != nil {
			return nil, err
		}
		response.CashFlowPeriods = append(response.CashFlowPeriods, &personalFinanceDashboardCashFlowPeriodResponse{
			Kind: period.Kind, StartDate: period.StartDate, EndDate: period.EndDate, Amounts: amounts,
		})
	}
	for _, item := range value.Debt.Amounts {
		if item == nil {
			return nil, errors.New("dashboard debt amount is nil")
		}
		response.Debt.Amounts = append(response.Debt.Amounts, &personalFinanceDashboardDebtAmountResponse{
			Currency: item.Currency, PlannedRemainingPrincipal: formatDashboardAmount(item.PlannedRemainingPrincipal),
			OverduePayment: formatDashboardAmount(item.OverduePayment), DueWithin7Days: formatDashboardAmount(item.DueWithin7Days),
			DueWithin30Days: formatDashboardAmount(item.DueWithin30Days), DueThisMonth: formatDashboardAmount(item.DueThisMonth),
		})
	}
	for _, item := range value.Debt.Contracts {
		if item == nil || item.ContractId < 1 {
			return nil, errors.New("dashboard debt contract is invalid")
		}
		response.Debt.Contracts = append(response.Debt.Contracts, &personalFinanceDashboardDebtContractResponse{
			ContractId: strconv.FormatInt(item.ContractId, 10), Name: item.Name, Currency: item.Currency,
			RemainingPrincipal: formatDashboardAmount(item.RemainingPrincipal), RemainingInstallments: item.RemainingInstallments,
			EffectiveAprPptr: formatDashboardOptionalAmount(item.EffectiveAprPptr), NextDueDate: cloneDashboardString(item.NextDueDate),
			NextDueAmount: formatDashboardAmount(item.NextDueAmount), LedgerOutstanding: formatDashboardOptionalAmount(item.LedgerOutstanding),
			LedgerPlanDifference: formatDashboardOptionalAmount(item.LedgerPlanDifference), ActionRequired: item.ActionRequired,
		})
	}
	for _, month := range value.Debt.FutureCurve {
		if month == nil {
			return nil, errors.New("dashboard debt curve month is nil")
		}
		mapped := &personalFinanceDashboardDebtCurveResponse{Month: month.Month, Amounts: make([]*personalFinanceDashboardDebtCurveAmountResponse, 0, len(month.Amounts))}
		for _, item := range month.Amounts {
			if item == nil {
				return nil, errors.New("dashboard debt curve amount is nil")
			}
			mapped.Amounts = append(mapped.Amounts, &personalFinanceDashboardDebtCurveAmountResponse{Currency: item.Currency, Payment: formatDashboardAmount(item.Payment)})
		}
		response.Debt.FutureCurve = append(response.Debt.FutureCurve, mapped)
	}
	return response, nil
}

func dashboardCashFlowAmountResponses(values []*dashboard.CashFlowCurrency) ([]*personalFinanceDashboardCashFlowAmountResponse, error) {
	result := make([]*personalFinanceDashboardCashFlowAmountResponse, 0, len(values))
	for _, item := range values {
		if item == nil {
			return nil, errors.New("dashboard cash flow amount is nil")
		}
		result = append(result, &personalFinanceDashboardCashFlowAmountResponse{
			Currency: item.Currency, Income: formatDashboardAmount(item.Income), Consumption: formatDashboardAmount(item.Consumption),
			BalanceAdjustment: formatDashboardAmount(item.BalanceAdjustment), LoanPrincipal: formatDashboardAmount(item.LoanPrincipal),
			LoanInterest: formatDashboardAmount(item.LoanInterest), LoanFee: formatDashboardAmount(item.LoanFee),
			LoanDisbursement: formatDashboardAmount(item.LoanDisbursement), InternalTransfer: formatDashboardAmount(item.InternalTransfer),
			LiquidFundsNetChange: formatDashboardAmount(item.LiquidFundsNetChange),
		})
	}
	return result, nil
}

func dashboardCoverageResponse(value *dashboard.CoverageSummary) (*personalFinanceDashboardCoverageResponse, error) {
	if value == nil {
		return nil, errors.New("dashboard coverage is nil")
	}
	response := &personalFinanceDashboardCoverageResponse{
		SourceAccountCount: value.SourceAccountCount, MappedAccountCount: value.MappedAccountCount,
		CoveredAccountCount: value.CoveredAccountCount, AccountsWithGaps: value.AccountsWithGaps,
		LatestCoveredDate: cloneDashboardString(value.LatestCoveredDate), PendingRowCount: value.PendingRowCount,
		InvalidRowCount: value.InvalidRowCount, ExactDuplicateRowCount: value.ExactDuplicateRowCount,
		IdentityConflictRowCount: value.IdentityConflictRowCount, FailedBatchCount: value.FailedBatchCount,
		UnconfirmedExcluded: value.UnconfirmedExcluded, Complete: value.Complete,
		Accounts: make([]*personalFinanceDashboardSourceCoverageResponse, 0, len(value.Accounts)),
	}
	for _, item := range value.Accounts {
		if item == nil || item.SourceAccountId < 1 || item.MaskedDisplayName == "" || (item.LedgerAccountId != nil && *item.LedgerAccountId < 1) {
			return nil, errors.New("dashboard source coverage is invalid")
		}
		intervals, err := dashboardDateRanges(item.Intervals)
		if err != nil {
			return nil, err
		}
		gaps, err := dashboardDateRanges(item.Gaps)
		if err != nil {
			return nil, err
		}
		overlaps, err := dashboardDateRanges(item.Overlaps)
		if err != nil {
			return nil, err
		}
		mapped := &personalFinanceDashboardSourceCoverageResponse{
			SourceAccountId: strconv.FormatInt(item.SourceAccountId, 10), MaskedDisplayName: item.MaskedDisplayName,
			LedgerAccountId: formatDashboardOptionalAmount(item.LedgerAccountId), LatestCoveredDate: cloneDashboardString(item.LatestCoveredDate),
			UnknownPeriod: item.UnknownPeriod, Intervals: intervals, Gaps: gaps, Overlaps: overlaps,
		}
		response.Accounts = append(response.Accounts, mapped)
	}
	return response, nil
}

func dashboardDateRanges(values []*dashboard.DateRange) ([]*personalFinanceDashboardDateRangeResponse, error) {
	result := make([]*personalFinanceDashboardDateRangeResponse, 0, len(values))
	for _, value := range values {
		if value == nil || value.StartDate == "" || value.EndDate == "" || value.StartDate > value.EndDate {
			return nil, errors.New("dashboard coverage date range is invalid")
		}
		result = append(result, &personalFinanceDashboardDateRangeResponse{StartDate: value.StartDate, EndDate: value.EndDate})
	}
	return result, nil
}

func formatDashboardAmount(value int64) string {
	return strconv.FormatInt(value, 10)
}

func formatDashboardOptionalAmount(value *int64) *string {
	if value == nil {
		return nil
	}
	formatted := strconv.FormatInt(*value, 10)
	return &formatted
}

func cloneDashboardString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
