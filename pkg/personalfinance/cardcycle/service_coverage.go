package cardcycle

import (
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func (s *Service) RecordCoverage(c core.Context, request RecordCoverageRequest) (*CoverageIntervalView, error) {
	if s == nil || request.Uid < 1 || request.BatchId < 1 || request.TaskId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	batch, err := s.evidence.FindImportBatchById(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, persistError(err)
	}
	if batch == nil || batch.Uid != request.Uid || batch.BatchId != request.BatchId {
		return nil, serviceError(ErrServiceBatchNotFound, SERVICE_ERROR_BATCH_MISSING)
	}
	if !batchHasUsableCoverage(batch) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	ledgerAccountId := request.LedgerAccountId
	if batch.LedgerAccountId != nil && *batch.LedgerAccountId > 0 {
		if ledgerAccountId > 0 && ledgerAccountId != *batch.LedgerAccountId {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		ledgerAccountId = *batch.LedgerAccountId
	}
	if ledgerAccountId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.loadCreditCard(c, request.Uid, ledgerAccountId); err != nil {
		return nil, err
	}
	periodStart, periodEnd, err := statementCivilRange(batch)
	if err != nil {
		return nil, err
	}
	statementDate, dueDate := emptyCivilDate, emptyCivilDate
	header, err := s.evidence.FindCardHeaderByBatch(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, persistError(err)
	}
	if header != nil {
		if header.StatementDate != "" {
			statementDate = header.StatementDate
		}
		if header.DueDate != "" {
			dueDate = header.DueDate
		}
	}

	var saved *StatementCoverage
	now := s.now()
	nowUnix := now.Unix()
	if nowUnix < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	createdDate := now.In(time.UTC).Format(time.DateOnly)
	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		existing, findErr := tx.FindCoverageByBatch(request.BatchId)
		if findErr != nil {
			return persistError(findErr)
		}
		if existing != nil {
			saved = existing
			return nil
		}
		before, listErr := tx.ListCoverages(ledgerAccountId)
		if listErr != nil {
			return persistError(listErr)
		}
		coverage := &StatementCoverage{
			Uid: request.Uid, LedgerAccountId: ledgerAccountId, BatchId: request.BatchId,
			PeriodStart: periodStart, PeriodEnd: periodEnd, StatementDate: statementDate, DueDate: dueDate,
			CreatedUnixTime: nowUnix, CoverageId: s.generateId(),
		}
		if coverage.CoverageId < 1 {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if insertErr := tx.InsertCoverage(coverage); insertErr != nil {
			return persistError(insertErr)
		}
		if len(before) > 0 {
			if reviseErr := insertLateStatementRevisions(tx, request.Uid, request.TaskId, nowUnix, createdDate, before, coverage, s.generateId); reviseErr != nil {
				return reviseErr
			}
		}
		saved = coverage
		return nil
	})
	if err != nil {
		return nil, err
	}
	return coverageIntervalView(saved), nil
}

func (s *Service) GetCoverage(c core.Context, uid int64, ledgerAccountId int64, asOfDate string, yearMonth string) (*CoverageView, error) {
	if s == nil || uid < 1 || ledgerAccountId < 1 || !isServiceCivilDate(asOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if yearMonth == "" {
		var err error
		yearMonth, err = yearMonthOf(asOfDate)
		if err != nil {
			return nil, err
		}
	}
	if _, err := s.loadCreditCard(c, uid, ledgerAccountId); err != nil {
		return nil, err
	}
	windowStart, windowEnd, err := monthWindow(yearMonth, asOfDate)
	if err != nil {
		return nil, err
	}
	coverages, err := s.repository.ListCoverages(c, uid, ledgerAccountId)
	if err != nil {
		return nil, persistError(err)
	}
	_, gaps, overlaps, err := analyzeCoverage(coverageRanges(coverages), windowStart, windowEnd)
	if err != nil {
		return nil, err
	}
	revisions, err := s.repository.ListMonthRevisions(c, uid, yearMonth, maximumRevisionPageSize)
	if err != nil {
		return nil, persistError(err)
	}
	view := &CoverageView{
		LedgerAccountId: ledgerAccountId, AsOfDate: asOfDate, YearMonth: yearMonth,
		MonthStatus: monthStatusOf(gaps), Coverages: make([]*CoverageIntervalView, 0, len(coverages)),
		Gaps: dateRangePointers(gaps), Overlaps: dateRangePointers(overlaps),
		Revisions: make([]*MonthRevisionView, 0, len(revisions)),
	}
	for _, coverage := range coverages {
		view.Coverages = append(view.Coverages, coverageIntervalView(coverage))
	}
	for _, revision := range revisions {
		view.Revisions = append(view.Revisions, revisionView(revision))
	}
	return view, nil
}

func insertLateStatementRevisions(tx *RepositoryTransaction, uid int64, taskId int64, now int64, createdDate string, before []*StatementCoverage, coverage *StatementCoverage, generateId func() int64) error {
	if coverage == nil || generateId == nil {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	months, err := yearMonthsOverlapping(coverage.PeriodStart, coverage.PeriodEnd)
	if err != nil {
		return err
	}
	after := append([]*StatementCoverage{}, before...)
	after = append(after, coverage)
	for _, yearMonth := range months {
		last, lastErr := monthLastDate(yearMonth)
		if lastErr != nil {
			return lastErr
		}
		if last > createdDate {
			continue
		}
		start, startErr := monthStartDate(yearMonth)
		if startErr != nil {
			return startErr
		}
		_, gapsBefore, _, beforeErr := analyzeCoverage(coverageRanges(before), start, last)
		if beforeErr != nil {
			return beforeErr
		}
		_, gapsAfter, _, afterErr := analyzeCoverage(coverageRanges(after), start, last)
		if afterErr != nil {
			return afterErr
		}
		beforeDays, dayErr := gapDayCount(gapsBefore)
		if dayErr != nil {
			return dayErr
		}
		afterDays, dayErr := gapDayCount(gapsAfter)
		if dayErr != nil {
			return dayErr
		}
		if afterDays >= beforeDays {
			continue
		}
		revisionId := generateId()
		if revisionId < 1 {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if insertErr := tx.InsertMonthRevision(&MonthReportRevision{
			Uid: uid, YearMonth: yearMonth, TaskId: taskId, ReasonCode: REASON_LATE_STATEMENT,
			CreatedUnixTime: now, RevisionId: revisionId,
		}); insertErr != nil {
			return persistError(insertErr)
		}
	}
	return nil
}

func batchHasUsableCoverage(batch *importing.ImportBatch) bool {
	if batch == nil || batch.StatementStartUnixTime == nil || batch.StatementEndUnixTime == nil ||
		*batch.StatementStartUnixTime < 1 || *batch.StatementEndUnixTime < *batch.StatementStartUnixTime {
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

func statementCivilRange(batch *importing.ImportBatch) (string, string, error) {
	if !batchHasUsableCoverage(batch) {
		return "", "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	location := time.UTC
	if batch.StatementTimezoneUtcOffset != nil {
		offset := int(*batch.StatementTimezoneUtcOffset)
		if offset < -720 || offset > 840 {
			return "", "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		location = time.FixedZone("Statement Timezone", offset*60)
	}
	start := time.Unix(*batch.StatementStartUnixTime, 0).In(location).Format(time.DateOnly)
	end := time.Unix(*batch.StatementEndUnixTime, 0).In(location).Format(time.DateOnly)
	if !isServiceCivilDate(start) || !isServiceCivilDate(end) || end < start {
		return "", "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return start, end, nil
}
