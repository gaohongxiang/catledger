package dashboard

import (
	"fmt"
	"sort"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

func (s *Service) deriveDebt(c core.Context, uid int64, asOfDate string, asOf time.Time) (*DebtSummary, int64, bool, error) {
	result := &DebtSummary{Amounts: make([]*DebtCurrencySummary, 0), Contracts: make([]*DebtContractSummary, 0), FutureCurve: make([]*DebtCurveMonth, 0, FutureDebtCurveMonths)}
	amountMap := make(map[string]*DebtCurrencySummary)
	curveMap := make(map[string]map[string]*DebtCurveCurrency, FutureDebtCurveMonths)
	curveStart := time.Date(asOf.Year(), asOf.Month(), 1, 0, 0, 0, 0, asOf.Location())
	curveEnd := curveStart.AddDate(0, FutureDebtCurveMonths, 0)
	for index := 0; index < FutureDebtCurveMonths; index++ {
		month := curveStart.AddDate(0, index, 0).Format("2006-01")
		curveMap[month] = make(map[string]*DebtCurveCurrency)
	}
	sevenDayEnd := asOf.AddDate(0, 0, 7).Format(time.DateOnly)
	thirtyDayEnd := asOf.AddDate(0, 0, 30).Format(time.DateOnly)
	monthEnd := curveStart.AddDate(0, 1, -1).Format(time.DateOnly)

	var cursor *loans.ContractCursor
	var activeCount int64
	loanWarnings := false
	for {
		page, err := s.loans.ListContracts(c, uid, loans.CONTRACT_STATUS_ACTIVE, cursor, dashboardRepositoryPageSize, asOfDate)
		if err != nil || page == nil {
			return nil, 0, false, fmt.Errorf("%w: loan contracts", ErrDependencyFailure)
		}
		if len(page.Items) > dashboardRepositoryPageSize {
			return nil, 0, false, ErrInvariantViolation
		}
		for _, summary := range page.Items {
			if summary == nil || summary.Contract == nil || summary.Contract.ContractId < 1 {
				return nil, 0, false, ErrInvariantViolation
			}
			detail, detailErr := s.loans.GetContract(c, uid, summary.Contract.ContractId, asOfDate)
			if detailErr != nil || detail == nil || detail.Contract == nil || detail.CurrentRevision == nil {
				return nil, 0, false, fmt.Errorf("%w: loan detail", ErrDependencyFailure)
			}
			// 合同可在列表与详情两次读取之间被显式关闭；不把已关闭合同留在 active 快照。
			if detail.Contract.Status != loans.CONTRACT_STATUS_ACTIVE {
				continue
			}
			if !validCurrency(detail.Contract.Currency) || detail.Remaining.PrincipalAmount < 0 || len(detail.Installments) != len(detail.InstallmentProgress) {
				return nil, 0, false, ErrInvariantViolation
			}
			activeCount, err = checkedAdd(activeCount, 1)
			if err != nil {
				return nil, 0, false, err
			}
			if activeCount > MaximumActiveLoanContractCount {
				return nil, 0, false, ErrReadLimitReached
			}
			currency := detail.Contract.Currency
			amounts := amountMap[currency]
			if amounts == nil {
				amounts = &DebtCurrencySummary{Currency: currency}
				amountMap[currency] = amounts
			}
			amounts.PlannedRemainingPrincipal, err = checkedAdd(amounts.PlannedRemainingPrincipal, detail.Remaining.PrincipalAmount)
			if err != nil {
				return nil, 0, false, err
			}
			contract := &DebtContractSummary{
				ContractId: detail.Contract.ContractId, Name: detail.Contract.Name, Currency: currency,
				RemainingPrincipal:   detail.Remaining.PrincipalAmount,
				EffectiveAprPptr:     cloneInt64(detail.CurrentRevision.EffectiveAprPptr),
				LedgerOutstanding:    cloneInt64(detail.LedgerOutstandingAmount),
				LedgerPlanDifference: cloneInt64(detail.LedgerPlanDifferenceAmount),
				ActionRequired:       detail.ActionRequired,
			}
			if detail.ActionRequired || detail.InvalidAllocationCount > 0 || (detail.LedgerPlanDifferenceAmount != nil && *detail.LedgerPlanDifferenceAmount != 0) {
				loanWarnings = true
				contract.ActionRequired = true
			}
			for index, progress := range detail.InstallmentProgress {
				installment := detail.Installments[index]
				if progress == nil || installment == nil || progress.InstallmentId != installment.InstallmentId ||
					progress.DueDate != installment.DueDate || progress.OutstandingPayment < 0 || progress.Components.OutstandingPrincipal < 0 {
					return nil, 0, false, ErrInvariantViolation
				}
				if progress.OutstandingPayment == 0 {
					continue
				}
				if _, parseErr := parseCivilDate(progress.DueDate, asOf.Location()); parseErr != nil {
					return nil, 0, false, ErrInvariantViolation
				}
				contract.RemainingInstallments, err = checkedAdd(contract.RemainingInstallments, 1)
				if err != nil {
					return nil, 0, false, err
				}
				if contract.NextDueDate == nil || progress.DueDate < *contract.NextDueDate {
					dueDate := progress.DueDate
					contract.NextDueDate = &dueDate
					contract.NextDueAmount = progress.OutstandingPayment
				}
				if progress.DueDate < asOfDate {
					amounts.OverduePayment, err = checkedAdd(amounts.OverduePayment, progress.OutstandingPayment)
				} else {
					if progress.DueDate <= sevenDayEnd {
						amounts.DueWithin7Days, err = checkedAdd(amounts.DueWithin7Days, progress.OutstandingPayment)
					}
					if err == nil && progress.DueDate <= thirtyDayEnd {
						amounts.DueWithin30Days, err = checkedAdd(amounts.DueWithin30Days, progress.OutstandingPayment)
					}
					if err == nil && progress.DueDate <= monthEnd {
						amounts.DueThisMonth, err = checkedAdd(amounts.DueThisMonth, progress.OutstandingPayment)
					}
				}
				if err != nil {
					return nil, 0, false, err
				}
				dueTime, _ := parseCivilDate(progress.DueDate, asOf.Location())
				if !dueTime.Before(asOf) && dueTime.Before(curveEnd) {
					month := dueTime.Format("2006-01")
					curveCurrency := curveMap[month][currency]
					if curveCurrency == nil {
						curveCurrency = &DebtCurveCurrency{Currency: currency}
						curveMap[month][currency] = curveCurrency
					}
					curveCurrency.Payment, err = checkedAdd(curveCurrency.Payment, progress.OutstandingPayment)
					if err != nil {
						return nil, 0, false, err
					}
				}
			}
			result.Contracts = append(result.Contracts, contract)
		}
		if page.NextCursor == nil {
			break
		}
		if cursor != nil && (page.NextCursor.UpdatedUnixTime > cursor.UpdatedUnixTime ||
			(page.NextCursor.UpdatedUnixTime == cursor.UpdatedUnixTime && page.NextCursor.ContractId >= cursor.ContractId)) {
			return nil, 0, false, ErrInvariantViolation
		}
		cursor = page.NextCursor
	}
	for _, amounts := range amountMap {
		result.Amounts = append(result.Amounts, amounts)
	}
	sort.Slice(result.Amounts, func(i, j int) bool { return result.Amounts[i].Currency < result.Amounts[j].Currency })
	for index := 0; index < FutureDebtCurveMonths; index++ {
		month := curveStart.AddDate(0, index, 0).Format("2006-01")
		currencyMap := curveMap[month]
		amounts := make([]*DebtCurveCurrency, 0, len(currencyMap))
		for _, amount := range currencyMap {
			amounts = append(amounts, amount)
		}
		sort.Slice(amounts, func(i, j int) bool { return amounts[i].Currency < amounts[j].Currency })
		result.FutureCurve = append(result.FutureCurve, &DebtCurveMonth{Month: month, Amounts: amounts})
	}
	return result, activeCount, loanWarnings, nil
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
