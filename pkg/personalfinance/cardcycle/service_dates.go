package cardcycle

import (
	"sort"
	"time"
)

func isServiceCivilDate(value string) bool {
	if len(value) != len(time.DateOnly) {
		return false
	}
	parsed, err := time.Parse(time.DateOnly, value)
	return err == nil && parsed.Format(time.DateOnly) == value
}

func isServiceYearMonth(value string) bool {
	if len(value) != len("2006-01") {
		return false
	}
	parsed, err := time.Parse("2006-01", value)
	return err == nil && parsed.Format("2006-01") == value
}

func yearMonthOf(value string) (string, error) {
	if !isServiceCivilDate(value) {
		return "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return value[:len("2006-01")], nil
}

func monthStartDate(yearMonth string) (string, error) {
	if !isServiceYearMonth(yearMonth) {
		return "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return yearMonth + "-01", nil
}

func monthLastDate(yearMonth string) (string, error) {
	start, err := time.Parse("2006-01-02", yearMonth+"-01")
	if err != nil {
		return "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return start.AddDate(0, 1, -1).Format(time.DateOnly), nil
}

func addCivilDays(value string, days int) (string, error) {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Format(time.DateOnly) != value {
		return "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return parsed.AddDate(0, 0, days).Format(time.DateOnly), nil
}

func minCivilDate(left string, right string) string {
	if left < right {
		return left
	}
	return right
}

func maxCivilDate(left string, right string) string {
	if left > right {
		return left
	}
	return right
}

func yearMonthsOverlapping(periodStart string, periodEnd string) ([]string, error) {
	if !isServiceCivilDate(periodStart) || !isServiceCivilDate(periodEnd) || periodEnd < periodStart {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	start, err := time.Parse(time.DateOnly, periodStart)
	if err != nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	end, err := time.Parse(time.DateOnly, periodEnd)
	if err != nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	cursor := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, time.UTC)
	last := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, time.UTC)
	months := make([]string, 0)
	for !cursor.After(last) {
		months = append(months, cursor.Format("2006-01"))
		cursor = cursor.AddDate(0, 1, 0)
	}
	return months, nil
}

func monthWindow(yearMonth string, asOfDate string) (string, string, error) {
	start, err := monthStartDate(yearMonth)
	if err != nil {
		return "", "", err
	}
	last, err := monthLastDate(yearMonth)
	if err != nil {
		return "", "", err
	}
	if !isServiceCivilDate(asOfDate) {
		return "", "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if asOfDate < start {
		return "", "", serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return start, minCivilDate(last, asOfDate), nil
}

func coverageRanges(values []*StatementCoverage) []DateRangeView {
	ranges := make([]DateRangeView, 0, len(values))
	for _, value := range values {
		if value == nil {
			continue
		}
		ranges = append(ranges, DateRangeView{StartDate: value.PeriodStart, EndDate: value.PeriodEnd})
	}
	return ranges
}

func analyzeCoverage(values []DateRangeView, windowStart string, windowEnd string) ([]DateRangeView, []DateRangeView, []DateRangeView, error) {
	if !isServiceCivilDate(windowStart) || !isServiceCivilDate(windowEnd) || windowEnd < windowStart {
		return nil, nil, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	clipped := make([]DateRangeView, 0, len(values))
	for _, value := range values {
		if !isServiceCivilDate(value.StartDate) || !isServiceCivilDate(value.EndDate) || value.EndDate < value.StartDate {
			return nil, nil, nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		start := maxCivilDate(value.StartDate, windowStart)
		end := minCivilDate(value.EndDate, windowEnd)
		if start <= end {
			clipped = append(clipped, DateRangeView{StartDate: start, EndDate: end})
		}
	}
	sort.Slice(clipped, func(i, j int) bool {
		if clipped[i].StartDate != clipped[j].StartDate {
			return clipped[i].StartDate < clipped[j].StartDate
		}
		return clipped[i].EndDate < clipped[j].EndDate
	})
	if len(clipped) == 0 {
		return clipped, []DateRangeView{{StartDate: windowStart, EndDate: windowEnd}}, []DateRangeView{}, nil
	}
	gaps := make([]DateRangeView, 0)
	overlaps := make([]DateRangeView, 0)
	currentEnd := ""
	for _, interval := range clipped {
		if currentEnd == "" {
			if interval.StartDate > windowStart {
				gapEnd, err := addCivilDays(interval.StartDate, -1)
				if err != nil {
					return nil, nil, nil, err
				}
				gaps = append(gaps, DateRangeView{StartDate: windowStart, EndDate: gapEnd})
			}
			currentEnd = interval.EndDate
			continue
		}
		if interval.StartDate <= currentEnd {
			overlapEnd := minCivilDate(currentEnd, interval.EndDate)
			overlaps = append(overlaps, DateRangeView{StartDate: interval.StartDate, EndDate: overlapEnd})
			if interval.EndDate > currentEnd {
				currentEnd = interval.EndDate
			}
			continue
		}
		nextCovered, err := addCivilDays(currentEnd, 1)
		if err != nil {
			return nil, nil, nil, err
		}
		if interval.StartDate > nextCovered {
			gapEnd, gapErr := addCivilDays(interval.StartDate, -1)
			if gapErr != nil {
				return nil, nil, nil, gapErr
			}
			gaps = append(gaps, DateRangeView{StartDate: nextCovered, EndDate: gapEnd})
		}
		if interval.EndDate > currentEnd {
			currentEnd = interval.EndDate
		}
	}
	if currentEnd < windowEnd {
		gapStart, err := addCivilDays(currentEnd, 1)
		if err != nil {
			return nil, nil, nil, err
		}
		gaps = append(gaps, DateRangeView{StartDate: gapStart, EndDate: windowEnd})
	}
	return clipped, gaps, overlaps, nil
}

func gapDayCount(gaps []DateRangeView) (int, error) {
	total := 0
	for _, gap := range gaps {
		start, err := time.Parse(time.DateOnly, gap.StartDate)
		if err != nil {
			return 0, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		end, err := time.Parse(time.DateOnly, gap.EndDate)
		if err != nil {
			return 0, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		total += int(end.Sub(start).Hours()/24) + 1
	}
	return total, nil
}

func dateRangePointers(values []DateRangeView) []*DateRangeView {
	result := make([]*DateRangeView, 0, len(values))
	for i := range values {
		item := values[i]
		result = append(result, &item)
	}
	return result
}

func latestCoverage(values []*StatementCoverage) *StatementCoverage {
	var latest *StatementCoverage
	for _, value := range values {
		if value == nil {
			continue
		}
		if latest == nil || value.PeriodEnd > latest.PeriodEnd ||
			(value.PeriodEnd == latest.PeriodEnd && value.CoverageId > latest.CoverageId) {
			latest = value
		}
	}
	return latest
}

func uncoveredGapAfter(latest *StatementCoverage, asOfDate string) (*DateRangeView, error) {
	if !isServiceCivilDate(asOfDate) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if latest == nil {
		return nil, nil
	}
	if latest.PeriodEnd >= asOfDate {
		return nil, nil
	}
	start, err := addCivilDays(latest.PeriodEnd, 1)
	if err != nil {
		return nil, err
	}
	if start > asOfDate {
		return nil, nil
	}
	return &DateRangeView{StartDate: start, EndDate: asOfDate}, nil
}

func monthStatusOf(gaps []DateRangeView) MonthReportStatus {
	if len(gaps) == 0 {
		return MONTH_STATUS_CONFIRMED
	}
	return MONTH_STATUS_PROVISIONAL
}
