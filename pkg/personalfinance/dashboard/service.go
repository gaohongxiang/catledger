package dashboard

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

const dashboardRepositoryPageSize = 100

type Service struct {
	ledger  LedgerReader
	loans   LoanReader
	imports ImportReader
}

func NewService(ledger LedgerReader, loanReader LoanReader, importReader ImportReader) (*Service, error) {
	if ledger == nil || loanReader == nil || importReader == nil {
		return nil, ErrInvalidQuery
	}
	return &Service{ledger: ledger, loans: loanReader, imports: importReader}, nil
}

func (s *Service) GetOverview(c core.Context, query Query) (*Overview, error) {
	start, asOf, err := validateQuery(query)
	if err != nil || s == nil || s.ledger == nil || s.loans == nil || s.imports == nil {
		return nil, ErrInvalidQuery
	}
	generatedAt := query.GeneratedAt
	if generatedAt.IsZero() {
		generatedAt = time.Now()
	}
	minimumTransactionTime, err := unixMilliseconds(start)
	if err != nil {
		return nil, ErrInvalidQuery
	}
	ledgerData, err := s.ledger.ReadLedgerData(c, query.Uid, minimumTransactionTime, MaximumLedgerTransactionCount)
	if err != nil {
		if errors.Is(err, ErrReadLimitReached) {
			return nil, ErrReadLimitReached
		}
		return nil, fmt.Errorf("%w: ledger", ErrDependencyFailure)
	}
	allocations, err := s.loans.ListDashboardAllocations(c, query.Uid)
	if err != nil {
		return nil, fmt.Errorf("%w: loan allocations", ErrDependencyFailure)
	}
	snapshot, cashFlow, cashFlowPeriods, classificationIssues, err := deriveLedgerOverview(
		ledgerData, allocations, start, asOf, query.Months, query.FirstDayOfWeek, query.Location,
	)
	if err != nil {
		return nil, err
	}
	debt, activeLoans, loanWarnings, err := s.deriveDebt(c, query.Uid, query.AsOfDate, asOf)
	if err != nil {
		return nil, err
	}
	coverage, err := s.deriveCoverage(c, query.Uid, query.StartDate, query.AsOfDate, query.Location)
	if err != nil {
		return nil, err
	}
	transactionCount, err := safeLength(len(ledgerData.Transactions))
	if err != nil {
		return nil, err
	}
	trust := &TrustSummary{
		LedgerTransactionCount: transactionCount, ActiveLoanContractCount: activeLoans,
		LoanClassificationIssueCount: classificationIssues, AmountsGroupedByCurrency: true,
		HistoricalBalanceDerived: true,
	}
	trust.HasWarnings = !coverage.Complete || classificationIssues > 0 || loanWarnings
	return &Overview{
		StartDate: query.StartDate, AsOfDate: query.AsOfDate, GeneratedUnixTime: generatedAt.Unix(),
		AccountSnapshot: snapshot, MonthlyCashFlow: cashFlow, CashFlowPeriods: cashFlowPeriods,
		Debt: debt, Coverage: coverage, Trust: trust,
	}, nil
}

func validateQuery(query Query) (time.Time, time.Time, error) {
	if query.Uid < 1 || query.Location == nil || query.Months < MinimumCashFlowMonths || query.Months > MaximumCashFlowMonths ||
		query.FirstDayOfWeek < MinimumFirstDayOfWeek || query.FirstDayOfWeek > MaximumFirstDayOfWeek {
		return time.Time{}, time.Time{}, ErrInvalidQuery
	}
	start, err := parseCivilDate(query.StartDate, query.Location)
	if err != nil {
		return time.Time{}, time.Time{}, ErrInvalidQuery
	}
	asOf, err := parseCivilDate(query.AsOfDate, query.Location)
	if err != nil || start.After(asOf) || start.After(cashFlowRequiredStart(asOf, query.Months, query.Location)) {
		return time.Time{}, time.Time{}, ErrInvalidQuery
	}
	return start, asOf, nil
}

func cashFlowRequiredStart(asOf time.Time, months int, location *time.Location) time.Time {
	asOfMonth := time.Date(asOf.Year(), asOf.Month(), 1, 0, 0, 0, 0, location)
	trendStart := asOfMonth.AddDate(0, -(months - 1), 0)
	yearStart := time.Date(asOf.Year(), time.January, 1, 0, 0, 0, 0, location)
	if trendStart.Before(yearStart) {
		return trendStart
	}
	return yearStart
}

func parseCivilDate(value string, location *time.Location) (time.Time, error) {
	if len(value) != len(time.DateOnly) || location == nil {
		return time.Time{}, ErrInvalidQuery
	}
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Format(time.DateOnly) != value {
		return time.Time{}, ErrInvalidQuery
	}
	result := time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, location)
	if result.Format(time.DateOnly) != value {
		return time.Time{}, ErrInvalidQuery
	}
	return result, nil
}

func unixMilliseconds(value time.Time) (int64, error) {
	seconds := value.Unix()
	if seconds < 1 || seconds > math.MaxInt64/1000 {
		return 0, ErrInvalidQuery
	}
	return seconds * 1000, nil
}

func deriveLedgerOverview(data *LedgerData, allocations []*loans.DashboardAllocation, start time.Time, asOf time.Time, months int, firstDayOfWeek int, location *time.Location) ([]*AccountCurrencySnapshot, []*MonthlyCashFlow, []*CashFlowPeriod, int64, error) {
	if data == nil || location == nil || months < MinimumCashFlowMonths || months > MaximumCashFlowMonths ||
		firstDayOfWeek < MinimumFirstDayOfWeek || firstDayOfWeek > MaximumFirstDayOfWeek {
		return nil, nil, nil, 0, ErrInvariantViolation
	}
	requiredStart := cashFlowRequiredStart(asOf, months, location)
	if start.After(requiredStart) {
		return nil, nil, nil, 0, ErrInvalidQuery
	}
	accountMap := make(map[int64]*LedgerAccount, len(data.Accounts))
	balances := make(map[int64]int64, len(data.Accounts))
	for _, account := range data.Accounts {
		if !validLedgerAccount(account) || accountMap[account.AccountId] != nil {
			return nil, nil, nil, 0, ErrInvariantViolation
		}
		accountMap[account.AccountId] = account
		balances[account.AccountId] = account.CurrentBalance
	}
	allocationMap := make(map[int64]*loans.DashboardAllocation, len(allocations))
	for _, allocation := range allocations {
		if allocation == nil || allocation.TransactionId < 1 || allocation.AllocatedAmount < 1 || allocationMap[allocation.TransactionId] != nil {
			return nil, nil, nil, 0, ErrInvariantViolation
		}
		allocationMap[allocation.TransactionId] = allocation
	}
	asOfNext, err := addCivilDays(asOf, 1)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	asOfExclusive, err := unixMilliseconds(asOfNext)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	monthStarts := make([]time.Time, months)
	asOfMonth := time.Date(asOf.Year(), asOf.Month(), 1, 0, 0, 0, 0, location)
	flows := make(map[string]map[string]*CashFlowCurrency, months)
	for index := 0; index < months; index++ {
		monthStarts[index] = asOfMonth.AddDate(0, index-(months-1), 0)
		flows[monthStarts[index].Format("2006-01")] = make(map[string]*CashFlowCurrency)
	}
	flowMinimum, err := unixMilliseconds(requiredStart)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	type periodAccumulator struct {
		kind    CashFlowPeriodKind
		start   time.Time
		amounts map[string]*CashFlowCurrency
	}
	weekOffset := (int(asOf.Weekday()) - firstDayOfWeek + 7) % 7
	periodAccumulators := []*periodAccumulator{
		{kind: CashFlowPeriodToday, start: asOf, amounts: make(map[string]*CashFlowCurrency)},
		{kind: CashFlowPeriodWeek, start: asOf.AddDate(0, 0, -weekOffset), amounts: make(map[string]*CashFlowCurrency)},
		{kind: CashFlowPeriodMonth, start: asOfMonth, amounts: make(map[string]*CashFlowCurrency)},
		{kind: CashFlowPeriodYear, start: time.Date(asOf.Year(), time.January, 1, 0, 0, 0, 0, location), amounts: make(map[string]*CashFlowCurrency)},
	}
	seenTransactions := make(map[int64]struct{}, len(data.Transactions))
	var classificationIssues int64
	for _, transaction := range data.Transactions {
		if !validLedgerTransaction(transaction) {
			return nil, nil, nil, 0, ErrInvariantViolation
		}
		if _, exists := seenTransactions[transaction.TransactionId]; exists {
			return nil, nil, nil, 0, ErrInvariantViolation
		}
		seenTransactions[transaction.TransactionId] = struct{}{}
		account := accountMap[transaction.AccountId]
		if transaction.TransactionTime >= asOfExclusive && account != nil {
			effect, effectErr := transactionBalanceEffect(transaction)
			if effectErr != nil {
				return nil, nil, nil, 0, effectErr
			}
			balances[account.AccountId], effectErr = checkedSubtract(balances[account.AccountId], effect)
			if effectErr != nil {
				return nil, nil, nil, 0, effectErr
			}
		}
		if transaction.TransactionTime < flowMinimum || transaction.TransactionTime >= asOfExclusive || account == nil || account.Hidden || !account.Single {
			continue
		}
		instant := time.Unix(transaction.TransactionTime/1000, (transaction.TransactionTime%1000)*int64(time.Millisecond)).In(location)
		month := instant.Format("2006-01")
		currencyFlows := flows[month]
		periodTargets := make([]*periodAccumulator, 0, len(periodAccumulators))
		for _, period := range periodAccumulators {
			if !instant.Before(period.start) {
				periodTargets = append(periodTargets, period)
			}
		}
		if currencyFlows == nil && len(periodTargets) == 0 {
			continue
		}
		effect, effectErr := transactionBalanceEffect(transaction)
		if effectErr != nil {
			return nil, nil, nil, 0, effectErr
		}
		allocation := allocationMap[transaction.TransactionId]
		component, classified := classifyLoanTransaction(transaction, allocation)
		if allocation != nil && !classified {
			classificationIssues, effectErr = checkedAdd(classificationIssues, 1)
			if effectErr != nil {
				return nil, nil, nil, 0, effectErr
			}
		}
		if currencyFlows != nil {
			flow := cashFlowCurrency(currencyFlows, account.Currency)
			if effectErr = applyCashFlowTransaction(flow, transaction, account, effect, component); effectErr != nil {
				return nil, nil, nil, 0, effectErr
			}
		}
		for _, period := range periodTargets {
			flow := cashFlowCurrency(period.amounts, account.Currency)
			if effectErr = applyCashFlowTransaction(flow, transaction, account, effect, component); effectErr != nil {
				return nil, nil, nil, 0, effectErr
			}
		}
	}

	snapshotMap := make(map[string]*AccountCurrencySnapshot)
	for accountId, account := range accountMap {
		if account.Hidden || !account.Single {
			continue
		}
		item := snapshotMap[account.Currency]
		if item == nil {
			item = &AccountCurrencySnapshot{Currency: account.Currency}
			snapshotMap[account.Currency] = item
		}
		balance := balances[accountId]
		var aggregateErr error
		switch account.Kind {
		case LedgerAccountKindAsset:
			item.Assets, aggregateErr = checkedAdd(item.Assets, balance)
			if aggregateErr == nil && account.Liquid {
				item.LiquidFunds, aggregateErr = checkedAdd(item.LiquidFunds, balance)
			}
		case LedgerAccountKindCreditCard:
			liability, negateErr := checkedNegate(balance)
			if negateErr != nil {
				return nil, nil, nil, 0, negateErr
			}
			item.Liabilities, aggregateErr = checkedAdd(item.Liabilities, liability)
			if aggregateErr == nil {
				item.CreditCardLiability, aggregateErr = checkedAdd(item.CreditCardLiability, liability)
			}
		case LedgerAccountKindDebt:
			liability, negateErr := checkedNegate(balance)
			if negateErr != nil {
				return nil, nil, nil, 0, negateErr
			}
			item.Liabilities, aggregateErr = checkedAdd(item.Liabilities, liability)
			if aggregateErr == nil {
				item.DebtAccountLiability, aggregateErr = checkedAdd(item.DebtAccountLiability, liability)
			}
		default:
			return nil, nil, nil, 0, ErrInvariantViolation
		}
		if aggregateErr != nil {
			return nil, nil, nil, 0, aggregateErr
		}
	}
	snapshot := make([]*AccountCurrencySnapshot, 0, len(snapshotMap))
	for _, item := range snapshotMap {
		var netErr error
		item.NetWorth, netErr = checkedSubtract(item.Assets, item.Liabilities)
		if netErr != nil {
			return nil, nil, nil, 0, netErr
		}
		snapshot = append(snapshot, item)
	}
	sort.Slice(snapshot, func(i, j int) bool { return snapshot[i].Currency < snapshot[j].Currency })

	monthly := make([]*MonthlyCashFlow, 0, months)
	for _, monthStart := range monthStarts {
		month := monthStart.Format("2006-01")
		currencyMap := flows[month]
		monthly = append(monthly, &MonthlyCashFlow{Month: month, Amounts: sortedCashFlowCurrencies(currencyMap)})
	}
	periods := make([]*CashFlowPeriod, 0, len(periodAccumulators))
	for _, period := range periodAccumulators {
		periods = append(periods, &CashFlowPeriod{
			Kind: period.kind, StartDate: period.start.Format(time.DateOnly), EndDate: asOf.Format(time.DateOnly),
			Amounts: sortedCashFlowCurrencies(period.amounts),
		})
	}
	return snapshot, monthly, periods, classificationIssues, nil
}

func cashFlowCurrency(values map[string]*CashFlowCurrency, currency string) *CashFlowCurrency {
	flow := values[currency]
	if flow == nil {
		flow = &CashFlowCurrency{Currency: currency}
		values[currency] = flow
	}
	return flow
}

func applyCashFlowTransaction(flow *CashFlowCurrency, transaction *LedgerTransaction, account *LedgerAccount, balanceEffect int64, component loans.ComponentType) error {
	if flow == nil || transaction == nil || account == nil {
		return ErrInvariantViolation
	}
	var err error
	if account.Liquid {
		flow.LiquidFundsNetChange, err = checkedAdd(flow.LiquidFundsNetChange, balanceEffect)
		if err != nil {
			return err
		}
	}
	if transaction.EconomicNature == LedgerTransactionEconomicNatureRefund {
		if transaction.Type != LedgerTransactionIncome {
			return ErrInvariantViolation
		}
		// 退款在核心账本中以流入交易恢复资产余额，但在现金流中冲减消费，不是收入。
		flow.Consumption, err = checkedSubtract(flow.Consumption, transaction.Amount)
		return err
	}
	switch transaction.Type {
	case LedgerTransactionModifyBalance:
		flow.BalanceAdjustment, err = checkedAdd(flow.BalanceAdjustment, transaction.Adjustment)
	case LedgerTransactionIncome:
		flow.Income, err = checkedAdd(flow.Income, transaction.Amount)
	case LedgerTransactionExpense:
		switch component {
		case loans.COMPONENT_TYPE_INTEREST:
			flow.LoanInterest, err = checkedAdd(flow.LoanInterest, transaction.Amount)
		case loans.COMPONENT_TYPE_FEE:
			flow.LoanFee, err = checkedAdd(flow.LoanFee, transaction.Amount)
		default:
			flow.Consumption, err = checkedAdd(flow.Consumption, transaction.Amount)
		}
	case LedgerTransactionTransferOut:
		switch component {
		case loans.COMPONENT_TYPE_PRINCIPAL:
			flow.LoanPrincipal, err = checkedAdd(flow.LoanPrincipal, transaction.Amount)
		case loans.COMPONENT_TYPE_DISBURSEMENT:
			flow.LoanDisbursement, err = checkedAdd(flow.LoanDisbursement, transaction.Amount)
		default:
			flow.InternalTransfer, err = checkedAdd(flow.InternalTransfer, transaction.Amount)
		}
	case LedgerTransactionTransferIn:
		// 双侧正式行只参与账户余额与流动资金净变化，业务分类只计 transfer-out 主侧。
	default:
		return ErrInvariantViolation
	}
	return err
}

func sortedCashFlowCurrencies(values map[string]*CashFlowCurrency) []*CashFlowCurrency {
	result := make([]*CashFlowCurrency, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Currency < result[j].Currency })
	return result
}

func classifyLoanTransaction(transaction *LedgerTransaction, allocation *loans.DashboardAllocation) (loans.ComponentType, bool) {
	if allocation == nil || transaction == nil || allocation.AllocatedAmount != transaction.Amount {
		return "", false
	}
	switch allocation.ComponentType {
	case loans.COMPONENT_TYPE_INTEREST, loans.COMPONENT_TYPE_FEE:
		return allocation.ComponentType, transaction.Type == LedgerTransactionExpense
	case loans.COMPONENT_TYPE_PRINCIPAL, loans.COMPONENT_TYPE_DISBURSEMENT:
		return allocation.ComponentType, transaction.Type == LedgerTransactionTransferOut
	default:
		return "", false
	}
}

func transactionBalanceEffect(transaction *LedgerTransaction) (int64, error) {
	switch transaction.Type {
	case LedgerTransactionModifyBalance:
		return transaction.Adjustment, nil
	case LedgerTransactionIncome, LedgerTransactionTransferIn:
		return transaction.Amount, nil
	case LedgerTransactionExpense, LedgerTransactionTransferOut:
		return checkedNegate(transaction.Amount)
	default:
		return 0, ErrInvariantViolation
	}
}

func validLedgerAccount(account *LedgerAccount) bool {
	return account != nil && account.AccountId > 0 && validCurrency(account.Currency) &&
		(account.Kind == LedgerAccountKindAsset || account.Kind == LedgerAccountKindCreditCard || account.Kind == LedgerAccountKindDebt)
}

func validLedgerTransaction(transaction *LedgerTransaction) bool {
	if transaction == nil || transaction.TransactionId < 1 || transaction.AccountId < 1 || transaction.TransactionTime < 1 {
		return false
	}
	switch transaction.Type {
	case LedgerTransactionModifyBalance, LedgerTransactionIncome, LedgerTransactionExpense,
		LedgerTransactionTransferOut, LedgerTransactionTransferIn:
		return true
	default:
		return false
	}
}

func validCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for index := range value {
		if value[index] < 'A' || value[index] > 'Z' {
			return false
		}
	}
	return true
}

func addCivilDays(value time.Time, days int) (time.Time, error) {
	result := value.AddDate(0, 0, days)
	if result.Hour() != 0 || result.Minute() != 0 || result.Second() != 0 || result.Nanosecond() != 0 {
		return time.Time{}, ErrInvariantViolation
	}
	return result, nil
}

func checkedAdd(left int64, right int64) (int64, error) {
	if (right > 0 && left > math.MaxInt64-right) || (right < 0 && left < math.MinInt64-right) {
		return 0, ErrInvariantViolation
	}
	return left + right, nil
}

func checkedNegate(value int64) (int64, error) {
	if value == math.MinInt64 {
		return 0, ErrInvariantViolation
	}
	return -value, nil
}

func checkedSubtract(left int64, right int64) (int64, error) {
	negated, err := checkedNegate(right)
	if err != nil {
		return 0, err
	}
	return checkedAdd(left, negated)
}

func safeLength(value int) (int64, error) {
	if value < 0 || uint64(value) > math.MaxInt64 {
		return 0, ErrInvariantViolation
	}
	return int64(value), nil
}
