package api

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/cardcycle"
)

type PersonalFinanceCardCycleApplication interface {
	ListAccounts(c core.Context, uid int64, asOfDate string) (*cardcycle.AccountListResult, error)
	SaveRule(c core.Context, request cardcycle.SaveRuleRequest) (*cardcycle.RuleView, error)
	GetCoverage(c core.Context, uid int64, ledgerAccountId int64, asOfDate string, yearMonth string) (*cardcycle.CoverageView, error)
	SaveBalanceReview(c core.Context, request cardcycle.SaveBalanceReviewRequest) (*cardcycle.BalanceReviewView, error)
}

var _ PersonalFinanceCardCycleApplication = (*cardcycle.Service)(nil)

type PersonalFinanceCardCycleApi struct {
	application PersonalFinanceCardCycleApplication
}

func NewPersonalFinanceCardCycleApi(application PersonalFinanceCardCycleApplication) (*PersonalFinanceCardCycleApi, error) {
	if application == nil {
		return nil, errors.New("personal finance card cycle application is required")
	}
	return &PersonalFinanceCardCycleApi{application: application}, nil
}

type personalFinanceCardCycleRuleSaveRequest struct {
	LedgerAccountId int64  `json:"ledgerAccountId,string"`
	StatementDay    int64  `json:"statementDay"`
	DueDay          int64  `json:"dueDay"`
	EffectiveFrom   string `json:"effectiveFrom"`
	IdempotencyKey  string `json:"idempotencyKey"`
}

type personalFinanceCardCycleBalanceReviewRequest struct {
	LedgerAccountId int64                         `json:"ledgerAccountId,string"`
	Status          cardcycle.BalanceReviewStatus `json:"status"`
	AsOfDate        string                        `json:"asOfDate"`
	ExpectedVersion int64                         `json:"expectedVersion"`
	IdempotencyKey  string                        `json:"idempotencyKey"`
}

type personalFinanceCardCycleDateRangeResponse struct {
	StartDate string `json:"startDate"`
	EndDate   string `json:"endDate"`
}

type personalFinanceCardCycleRuleResponse struct {
	Id              string               `json:"id"`
	LedgerAccountId string               `json:"ledgerAccountId"`
	RuleNumber      int64                `json:"ruleNumber"`
	StatementDay    int64                `json:"statementDay"`
	DueDay          int64                `json:"dueDay"`
	EffectiveFrom   string               `json:"effectiveFrom"`
	Status          cardcycle.RuleStatus `json:"status"`
	CreatedUnixTime int64                `json:"createdUnixTime"`
}

type personalFinanceCardCycleCoverageIntervalResponse struct {
	Id              string `json:"id"`
	BatchId         string `json:"batchId"`
	PeriodStart     string `json:"periodStart"`
	PeriodEnd       string `json:"periodEnd"`
	StatementDate   string `json:"statementDate"`
	DueDate         string `json:"dueDate"`
	CreatedUnixTime int64  `json:"createdUnixTime"`
}

type personalFinanceCardCycleRevisionResponse struct {
	Id              string `json:"id"`
	YearMonth       string `json:"yearMonth"`
	TaskId          string `json:"taskId"`
	ReasonCode      string `json:"reasonCode"`
	CreatedUnixTime int64  `json:"createdUnixTime"`
}

type personalFinanceCardCycleCoverageResponse struct {
	LedgerAccountId string                                              `json:"ledgerAccountId"`
	AsOfDate        string                                              `json:"asOfDate"`
	YearMonth       string                                              `json:"yearMonth"`
	MonthStatus     cardcycle.MonthReportStatus                         `json:"monthStatus"`
	Coverages       []*personalFinanceCardCycleCoverageIntervalResponse `json:"coverages"`
	Gaps            []*personalFinanceCardCycleDateRangeResponse        `json:"gaps"`
	Overlaps        []*personalFinanceCardCycleDateRangeResponse        `json:"overlaps"`
	Revisions       []*personalFinanceCardCycleRevisionResponse         `json:"revisions"`
}

type personalFinanceCardCycleBalanceReviewResponse struct {
	Id              string                        `json:"id"`
	LedgerAccountId string                        `json:"ledgerAccountId"`
	Status          cardcycle.BalanceReviewStatus `json:"status"`
	AsOfDate        string                        `json:"asOfDate"`
	Version         int64                         `json:"version"`
	UpdatedUnixTime int64                         `json:"updatedUnixTime"`
}

type personalFinanceCardCycleAccountResponse struct {
	LedgerAccountId string                                            `json:"ledgerAccountId"`
	DisplayName     string                                            `json:"displayName"`
	Currency        string                                            `json:"currency"`
	Hidden          bool                                              `json:"hidden"`
	ActiveRule      *personalFinanceCardCycleRuleResponse             `json:"activeRule"`
	LatestCoverage  *personalFinanceCardCycleCoverageIntervalResponse `json:"latestCoverage"`
	UncoveredGap    *personalFinanceCardCycleDateRangeResponse        `json:"uncoveredGap"`
	MonthStatus     cardcycle.MonthReportStatus                       `json:"monthStatus"`
	BalanceReview   *personalFinanceCardCycleBalanceReviewResponse    `json:"balanceReview"`
}

type personalFinanceCardCycleAccountListResponse struct {
	AsOfDate string                                     `json:"asOfDate"`
	Items    []*personalFinanceCardCycleAccountResponse `json:"items"`
}

func (a *PersonalFinanceCardCycleApi) CardCycleAccountListHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "as_of_date") {
		return nil, errs.ErrParameterInvalid
	}
	asOfDate, apiErr := personalFinanceCardCycleAsOfDate(c, strings.TrimSpace(c.Query("as_of_date")))
	if apiErr != nil {
		return nil, apiErr
	}
	result, err := a.application.ListAccounts(c, c.GetCurrentUid(), asOfDate)
	if err != nil {
		log.Warnf(c, "[personal_finance_card_cycle.accounts] failed for user \"uid:%d\" and code \"%s\"", c.GetCurrentUid(), cardcycle.ServiceErrorCodeOf(err))
		return nil, personalFinanceCardCycleServiceError(err)
	}
	return newPersonalFinanceCardCycleAccountListResponse(result), nil
}

func (a *PersonalFinanceCardCycleApi) CardCycleRuleSaveHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceCardCycleRuleSaveRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.SaveRule(c, cardcycle.SaveRuleRequest{
		Uid: c.GetCurrentUid(), LedgerAccountId: request.LedgerAccountId, StatementDay: request.StatementDay,
		DueDay: request.DueDay, EffectiveFrom: request.EffectiveFrom, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		log.Warnf(c, "[personal_finance_card_cycle.rules.save] failed for user \"uid:%d\" and account \"id:%d\"", c.GetCurrentUid(), request.LedgerAccountId)
		return nil, personalFinanceCardCycleServiceError(err)
	}
	return newPersonalFinanceCardCycleRuleResponse(result), nil
}

func (a *PersonalFinanceCardCycleApi) CardCycleCoverageHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "id", "as_of_date", "year_month") {
		return nil, errs.ErrParameterInvalid
	}
	accountId, err := strconv.ParseInt(strings.TrimSpace(c.Query("id")), 10, 64)
	if err != nil || accountId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	asOfDate, apiErr := personalFinanceCardCycleAsOfDate(c, strings.TrimSpace(c.Query("as_of_date")))
	if apiErr != nil {
		return nil, apiErr
	}
	yearMonth := strings.TrimSpace(c.Query("year_month"))
	result, getErr := a.application.GetCoverage(c, c.GetCurrentUid(), accountId, asOfDate, yearMonth)
	if getErr != nil {
		log.Warnf(c, "[personal_finance_card_cycle.coverage] failed for user \"uid:%d\" and account \"id:%d\"", c.GetCurrentUid(), accountId)
		return nil, personalFinanceCardCycleServiceError(getErr)
	}
	return newPersonalFinanceCardCycleCoverageResponse(result), nil
}

func (a *PersonalFinanceCardCycleApi) CardCycleBalanceReviewHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceCardCycleBalanceReviewRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.SaveBalanceReview(c, cardcycle.SaveBalanceReviewRequest{
		Uid: c.GetCurrentUid(), LedgerAccountId: request.LedgerAccountId, Status: request.Status,
		AsOfDate: request.AsOfDate, ExpectedVersion: request.ExpectedVersion, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		log.Warnf(c, "[personal_finance_card_cycle.balance_review] failed for user \"uid:%d\" and account \"id:%d\"", c.GetCurrentUid(), request.LedgerAccountId)
		return nil, personalFinanceCardCycleServiceError(err)
	}
	return newPersonalFinanceCardCycleBalanceReviewResponse(result), nil
}

func personalFinanceCardCycleAsOfDate(c *core.WebContext, raw string) (string, *errs.Error) {
	if raw != "" {
		if _, err := time.Parse(time.DateOnly, raw); err != nil || len(raw) != len(time.DateOnly) {
			return "", errs.ErrParameterInvalid
		}
		return raw, nil
	}
	location, err := c.GetClientTimezone()
	if err != nil || location == nil {
		return "", errs.ErrClientTimezoneOffsetInvalid
	}
	return time.Now().In(location).Format(time.DateOnly), nil
}

func newPersonalFinanceCardCycleAccountListResponse(result *cardcycle.AccountListResult) *personalFinanceCardCycleAccountListResponse {
	response := &personalFinanceCardCycleAccountListResponse{Items: []*personalFinanceCardCycleAccountResponse{}}
	if result == nil {
		return response
	}
	response.AsOfDate = result.AsOfDate
	for _, item := range result.Items {
		response.Items = append(response.Items, newPersonalFinanceCardCycleAccountResponse(item))
	}
	return response
}

func newPersonalFinanceCardCycleAccountResponse(value *cardcycle.CardAccountView) *personalFinanceCardCycleAccountResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceCardCycleAccountResponse{
		LedgerAccountId: strconv.FormatInt(value.LedgerAccountId, 10), DisplayName: value.DisplayName,
		Currency: value.Currency, Hidden: value.Hidden, ActiveRule: newPersonalFinanceCardCycleRuleResponse(value.ActiveRule),
		LatestCoverage: newPersonalFinanceCardCycleCoverageIntervalResponse(value.LatestCoverage),
		UncoveredGap:   newPersonalFinanceCardCycleDateRangeResponse(value.UncoveredGap),
		MonthStatus:    value.MonthStatus, BalanceReview: newPersonalFinanceCardCycleBalanceReviewResponse(value.BalanceReview),
	}
}

func newPersonalFinanceCardCycleRuleResponse(value *cardcycle.RuleView) *personalFinanceCardCycleRuleResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceCardCycleRuleResponse{
		Id: strconv.FormatInt(value.RuleId, 10), LedgerAccountId: strconv.FormatInt(value.LedgerAccountId, 10),
		RuleNumber: value.RuleNumber, StatementDay: value.StatementDay, DueDay: value.DueDay,
		EffectiveFrom: value.EffectiveFrom, Status: value.Status, CreatedUnixTime: value.CreatedUnixTime,
	}
}

func newPersonalFinanceCardCycleCoverageIntervalResponse(value *cardcycle.CoverageIntervalView) *personalFinanceCardCycleCoverageIntervalResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceCardCycleCoverageIntervalResponse{
		Id: strconv.FormatInt(value.CoverageId, 10), BatchId: strconv.FormatInt(value.BatchId, 10),
		PeriodStart: value.PeriodStart, PeriodEnd: value.PeriodEnd, StatementDate: value.StatementDate,
		DueDate: value.DueDate, CreatedUnixTime: value.CreatedUnixTime,
	}
}

func newPersonalFinanceCardCycleDateRangeResponse(value *cardcycle.DateRangeView) *personalFinanceCardCycleDateRangeResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceCardCycleDateRangeResponse{StartDate: value.StartDate, EndDate: value.EndDate}
}

func newPersonalFinanceCardCycleCoverageResponse(value *cardcycle.CoverageView) *personalFinanceCardCycleCoverageResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceCardCycleCoverageResponse{
		LedgerAccountId: strconv.FormatInt(value.LedgerAccountId, 10), AsOfDate: value.AsOfDate, YearMonth: value.YearMonth,
		MonthStatus: value.MonthStatus, Coverages: []*personalFinanceCardCycleCoverageIntervalResponse{},
		Gaps: []*personalFinanceCardCycleDateRangeResponse{}, Overlaps: []*personalFinanceCardCycleDateRangeResponse{},
		Revisions: []*personalFinanceCardCycleRevisionResponse{},
	}
	for _, item := range value.Coverages {
		response.Coverages = append(response.Coverages, newPersonalFinanceCardCycleCoverageIntervalResponse(item))
	}
	for _, item := range value.Gaps {
		response.Gaps = append(response.Gaps, newPersonalFinanceCardCycleDateRangeResponse(item))
	}
	for _, item := range value.Overlaps {
		response.Overlaps = append(response.Overlaps, newPersonalFinanceCardCycleDateRangeResponse(item))
	}
	for _, item := range value.Revisions {
		if item == nil {
			continue
		}
		response.Revisions = append(response.Revisions, &personalFinanceCardCycleRevisionResponse{
			Id: strconv.FormatInt(item.RevisionId, 10), YearMonth: item.YearMonth,
			TaskId: strconv.FormatInt(item.TaskId, 10), ReasonCode: item.ReasonCode, CreatedUnixTime: item.CreatedUnixTime,
		})
	}
	return response
}

func newPersonalFinanceCardCycleBalanceReviewResponse(value *cardcycle.BalanceReviewView) *personalFinanceCardCycleBalanceReviewResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceCardCycleBalanceReviewResponse{
		Id: strconv.FormatInt(value.ReviewId, 10), LedgerAccountId: strconv.FormatInt(value.LedgerAccountId, 10),
		Status: value.Status, AsOfDate: value.AsOfDate, Version: value.Version, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}

func personalFinanceCardCycleServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, cardcycle.ErrServiceInvalidRequest), errors.Is(err, cardcycle.ErrServiceAccountNotFound),
		errors.Is(err, cardcycle.ErrServiceAccountRejected), errors.Is(err, cardcycle.ErrServiceBatchNotFound):
		return errs.ErrParameterInvalid
	case errors.Is(err, cardcycle.ErrServiceVersionConflict):
		return errs.ErrRepeatedRequest
	default:
		return errs.ErrOperationFailed
	}
}
