package dashboard

import (
	"fmt"
	"sort"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func (s *Service) deriveCoverage(c core.Context, uid int64, startDate string, asOfDate string, location *time.Location) (*CoverageSummary, error) {
	accounts, err := s.imports.ListSourceAccounts(c, uid)
	if err != nil {
		return nil, fmt.Errorf("%w: source accounts", ErrDependencyFailure)
	}
	batches, err := s.loadImportBatches(c, uid)
	if err != nil {
		return nil, err
	}
	result := &CoverageSummary{UnconfirmedExcluded: true, Accounts: make([]*SourceCoverage, 0)}
	hasOverlap := false
	accountMap := make(map[int64]*importing.SourceAccount)
	for _, account := range accounts {
		if account == nil || account.Uid != uid || account.SourceAccountId < 1 || account.MaskedDisplayName == "" {
			return nil, ErrInvariantViolation
		}
		if account.Status != importing.SOURCE_ACCOUNT_STATUS_ACTIVE {
			continue
		}
		if accountMap[account.SourceAccountId] != nil {
			return nil, ErrInvariantViolation
		}
		accountMap[account.SourceAccountId] = account
		result.SourceAccountCount, err = checkedAdd(result.SourceAccountCount, 1)
		if err != nil {
			return nil, err
		}
		if account.LedgerAccountId != nil {
			result.MappedAccountCount, err = checkedAdd(result.MappedAccountCount, 1)
			if err != nil {
				return nil, err
			}
		}
	}

	latestByFile := make(map[int64]*importing.ImportBatch)
	coverageByFile := make(map[int64]*importing.ImportBatch)
	for _, batch := range batches {
		if !validCoverageBatchIdentity(batch, uid) {
			return nil, ErrInvariantViolation
		}
		if newerBatch(batch, latestByFile[batch.FileId]) {
			latestByFile[batch.FileId] = batch
		}
		if batchHasUsableCoverage(batch) && newerBatch(batch, coverageByFile[batch.FileId]) {
			coverageByFile[batch.FileId] = batch
		}
	}
	unknownByAccount := make(map[int64]bool)
	for _, batch := range latestByFile {
		if err := addLatestBatchCounters(result, batch); err != nil {
			return nil, err
		}
		if batch.SourceAccountId != nil && accountMap[*batch.SourceAccountId] != nil &&
			batch.Status != importing.IMPORT_BATCH_STATUS_DISCARDED && !batchHasUsableCoverage(batch) {
			unknownByAccount[*batch.SourceAccountId] = true
		}
	}
	intervalsByAccount := make(map[int64][]*DateRange)
	for _, batch := range coverageByFile {
		if batch.SourceAccountId == nil || accountMap[*batch.SourceAccountId] == nil {
			continue
		}
		interval, intervalErr := statementDateRange(batch, location)
		if intervalErr != nil {
			return nil, intervalErr
		}
		intervalsByAccount[*batch.SourceAccountId] = append(intervalsByAccount[*batch.SourceAccountId], interval)
	}

	for accountId, account := range accountMap {
		intervals, gaps, overlaps, latest, intervalErr := analyzeCoverageIntervals(intervalsByAccount[accountId], startDate, asOfDate)
		if intervalErr != nil {
			return nil, intervalErr
		}
		item := &SourceCoverage{
			SourceAccountId: accountId, MaskedDisplayName: account.MaskedDisplayName,
			LedgerAccountId: cloneInt64(account.LedgerAccountId), Intervals: intervals, Gaps: gaps,
			Overlaps: overlaps, LatestCoveredDate: latest, UnknownPeriod: unknownByAccount[accountId],
		}
		if len(intervals) > 0 {
			result.CoveredAccountCount, err = checkedAdd(result.CoveredAccountCount, 1)
			if err != nil {
				return nil, err
			}
		}
		if len(gaps) > 0 || item.UnknownPeriod {
			result.AccountsWithGaps, err = checkedAdd(result.AccountsWithGaps, 1)
			if err != nil {
				return nil, err
			}
		}
		if len(overlaps) > 0 {
			hasOverlap = true
		}
		if latest != nil && (result.LatestCoveredDate == nil || *latest > *result.LatestCoveredDate) {
			result.LatestCoveredDate = cloneString(latest)
		}
		result.Accounts = append(result.Accounts, item)
	}
	sort.Slice(result.Accounts, func(i, j int) bool {
		if result.Accounts[i].MaskedDisplayName != result.Accounts[j].MaskedDisplayName {
			return result.Accounts[i].MaskedDisplayName < result.Accounts[j].MaskedDisplayName
		}
		return result.Accounts[i].SourceAccountId < result.Accounts[j].SourceAccountId
	})
	result.Complete = result.SourceAccountCount > 0 &&
		result.MappedAccountCount == result.SourceAccountCount &&
		result.CoveredAccountCount == result.SourceAccountCount && result.AccountsWithGaps == 0 &&
		result.PendingRowCount == 0 && result.InvalidRowCount == 0 &&
		result.IdentityConflictRowCount == 0 && result.FailedBatchCount == 0 && !hasOverlap
	return result, nil
}

func (s *Service) loadImportBatches(c core.Context, uid int64) ([]*importing.ImportBatch, error) {
	result := make([]*importing.ImportBatch, 0)
	offset := 0
	for {
		page, total, err := s.imports.ListImportBatches(c, uid, 0, offset, dashboardRepositoryPageSize)
		if err != nil || total < 0 || total > MaximumImportBatchCount {
			if total > MaximumImportBatchCount {
				return nil, ErrReadLimitReached
			}
			return nil, fmt.Errorf("%w: import batches", ErrDependencyFailure)
		}
		if len(page) == 0 {
			if int64(offset) < total {
				return nil, ErrInvariantViolation
			}
			break
		}
		if len(page) > dashboardRepositoryPageSize {
			return nil, ErrInvariantViolation
		}
		result = append(result, page...)
		offset += len(page)
		if int64(offset) >= total {
			break
		}
	}
	return result, nil
}

func validCoverageBatchIdentity(batch *importing.ImportBatch, uid int64) bool {
	return batch != nil && batch.Uid == uid && batch.FileId > 0 && batch.BatchId > 0 &&
		batch.CreatedUnixTime > 0 && batch.UpdatedUnixTime >= batch.CreatedUnixTime &&
		batch.TotalRowCount >= 0 && batch.ValidRowCount >= 0 && batch.InvalidRowCount >= 0 &&
		batch.ExactDuplicateRowCount >= 0 && batch.IdentityConflictRowCount >= 0 &&
		batch.PendingRowCount >= 0 && batch.PostedRowCount >= 0
}

func newerBatch(candidate *importing.ImportBatch, current *importing.ImportBatch) bool {
	return current == nil || candidate.CreatedUnixTime > current.CreatedUnixTime ||
		(candidate.CreatedUnixTime == current.CreatedUnixTime && candidate.BatchId > current.BatchId)
}

func batchHasUsableCoverage(batch *importing.ImportBatch) bool {
	if batch == nil || batch.SourceAccountId == nil || batch.StatementStartUnixTime == nil || batch.StatementEndUnixTime == nil ||
		*batch.SourceAccountId < 1 || *batch.StatementStartUnixTime < 1 || *batch.StatementEndUnixTime < *batch.StatementStartUnixTime {
		return false
	}
	switch batch.Status {
	case importing.IMPORT_BATCH_STATUS_READY, importing.IMPORT_BATCH_STATUS_POSTING,
		importing.IMPORT_BATCH_STATUS_PARTIALLY_POSTED, importing.IMPORT_BATCH_STATUS_COMPLETED:
		return true
	default:
		return false
	}
}

func addLatestBatchCounters(result *CoverageSummary, batch *importing.ImportBatch) error {
	if result == nil || batch == nil {
		return ErrInvariantViolation
	}
	if batch.Status == importing.IMPORT_BATCH_STATUS_DISCARDED {
		return nil
	}
	var err error
	result.PendingRowCount, err = checkedAdd(result.PendingRowCount, batch.PendingRowCount)
	if err == nil {
		result.InvalidRowCount, err = checkedAdd(result.InvalidRowCount, batch.InvalidRowCount)
	}
	if err == nil {
		result.ExactDuplicateRowCount, err = checkedAdd(result.ExactDuplicateRowCount, batch.ExactDuplicateRowCount)
	}
	if err == nil {
		result.IdentityConflictRowCount, err = checkedAdd(result.IdentityConflictRowCount, batch.IdentityConflictRowCount)
	}
	if err == nil && batch.Status == importing.IMPORT_BATCH_STATUS_FAILED {
		result.FailedBatchCount, err = checkedAdd(result.FailedBatchCount, 1)
	}
	return err
}

func statementDateRange(batch *importing.ImportBatch, fallback *time.Location) (*DateRange, error) {
	if !batchHasUsableCoverage(batch) || fallback == nil {
		return nil, ErrInvariantViolation
	}
	location := fallback
	if batch.StatementTimezoneUtcOffset != nil {
		offset := int(*batch.StatementTimezoneUtcOffset)
		if offset < -720 || offset > 840 {
			return nil, ErrInvariantViolation
		}
		location = time.FixedZone("Statement Timezone", offset*60)
	}
	start := time.Unix(*batch.StatementStartUnixTime, 0).In(location).Format(time.DateOnly)
	end := time.Unix(*batch.StatementEndUnixTime, 0).In(location).Format(time.DateOnly)
	if start > end {
		return nil, ErrInvariantViolation
	}
	return &DateRange{StartDate: start, EndDate: end}, nil
}

func analyzeCoverageIntervals(values []*DateRange, reportStart string, reportEnd string) ([]*DateRange, []*DateRange, []*DateRange, *string, error) {
	if reportStart > reportEnd {
		return nil, nil, nil, nil, ErrInvalidQuery
	}
	intervals := make([]*DateRange, 0, len(values))
	for _, value := range values {
		if value == nil || value.StartDate > value.EndDate {
			return nil, nil, nil, nil, ErrInvariantViolation
		}
		start := value.StartDate
		end := value.EndDate
		if start < reportStart {
			start = reportStart
		}
		if end > reportEnd {
			end = reportEnd
		}
		if start <= end {
			intervals = append(intervals, &DateRange{StartDate: start, EndDate: end})
		}
	}
	sort.Slice(intervals, func(i, j int) bool {
		if intervals[i].StartDate != intervals[j].StartDate {
			return intervals[i].StartDate < intervals[j].StartDate
		}
		return intervals[i].EndDate < intervals[j].EndDate
	})
	gaps := make([]*DateRange, 0)
	overlaps := make([]*DateRange, 0)
	if len(intervals) == 0 {
		return intervals, []*DateRange{{StartDate: reportStart, EndDate: reportEnd}}, overlaps, nil, nil
	}
	currentEnd := ""
	for _, interval := range intervals {
		if currentEnd == "" {
			if interval.StartDate > reportStart {
				gapEnd, err := addDateText(interval.StartDate, -1)
				if err != nil {
					return nil, nil, nil, nil, err
				}
				gaps = append(gaps, &DateRange{StartDate: reportStart, EndDate: gapEnd})
			}
			currentEnd = interval.EndDate
			continue
		}
		if interval.StartDate <= currentEnd {
			overlapEnd := currentEnd
			if interval.EndDate < overlapEnd {
				overlapEnd = interval.EndDate
			}
			overlaps = append(overlaps, &DateRange{StartDate: interval.StartDate, EndDate: overlapEnd})
			if interval.EndDate > currentEnd {
				currentEnd = interval.EndDate
			}
			continue
		}
		nextCovered, err := addDateText(currentEnd, 1)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		if interval.StartDate > nextCovered {
			gapEnd, gapErr := addDateText(interval.StartDate, -1)
			if gapErr != nil {
				return nil, nil, nil, nil, gapErr
			}
			gaps = append(gaps, &DateRange{StartDate: nextCovered, EndDate: gapEnd})
		}
		if interval.EndDate > currentEnd {
			currentEnd = interval.EndDate
		}
	}
	if currentEnd < reportEnd {
		gapStart, err := addDateText(currentEnd, 1)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		gaps = append(gaps, &DateRange{StartDate: gapStart, EndDate: reportEnd})
	}
	latest := currentEnd
	return intervals, gaps, overlaps, &latest, nil
}

func addDateText(value string, days int) (string, error) {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Format(time.DateOnly) != value {
		return "", ErrInvariantViolation
	}
	return parsed.AddDate(0, 0, days).Format(time.DateOnly), nil
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
