package cardcycle

import (
	"sort"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

func (s *Service) ListAccounts(c core.Context, uid int64, asOfDate string) (*AccountListResult, error) {
	if s == nil || uid < 1 || !isServiceCivilDate(asOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	accounts, err := s.accounts.ListCreditCardAccounts(c, uid)
	if err != nil {
		return nil, persistError(err)
	}
	yearMonth, err := yearMonthOf(asOfDate)
	if err != nil {
		return nil, err
	}
	windowStart, windowEnd, err := monthWindow(yearMonth, asOfDate)
	if err != nil {
		return nil, err
	}
	items := make([]*CardAccountView, 0, len(accounts))
	for _, account := range accounts {
		if account.AccountId < 1 || account.DisplayName == "" {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		item := &CardAccountView{
			LedgerAccountId: account.AccountId, DisplayName: account.DisplayName,
			Currency: account.Currency, Hidden: account.Hidden,
		}
		rule, ruleErr := s.activeRule(c, uid, account.AccountId)
		if ruleErr != nil {
			return nil, ruleErr
		}
		item.ActiveRule = ruleView(rule)
		coverages, coverageErr := s.repository.ListCoverages(c, uid, account.AccountId)
		if coverageErr != nil {
			return nil, persistError(coverageErr)
		}
		item.LatestCoverage = coverageIntervalView(latestCoverage(coverages))
		gap, gapErr := uncoveredGapAfter(latestCoverage(coverages), asOfDate)
		if gapErr != nil {
			return nil, gapErr
		}
		item.UncoveredGap = gap
		_, gaps, _, analyzeErr := analyzeCoverage(coverageRanges(coverages), windowStart, windowEnd)
		if analyzeErr != nil {
			return nil, analyzeErr
		}
		item.MonthStatus = monthStatusOf(gaps)
		review, reviewErr := s.repository.FindBalanceReviewByAccount(c, uid, account.AccountId)
		if reviewErr != nil {
			return nil, persistError(reviewErr)
		}
		item.BalanceReview = balanceReviewView(review)
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].LedgerAccountId < items[j].LedgerAccountId
	})
	return &AccountListResult{AsOfDate: asOfDate, Items: items}, nil
}
