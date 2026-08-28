package api

import (
	"errors"
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
)

const (
	personalFinanceInstallmentDefaultListLimit = 20
	personalFinanceInstallmentMaximumListLimit = 100
)

type PersonalFinanceInstallmentsApplication interface {
	ListCandidates(c core.Context, uid int64, status installments.CandidateStatus, cursor *installments.CandidateCursor, limit int) (*installments.CandidateListResult, error)
	GetCandidate(c core.Context, uid int64, candidateId int64) (*installments.CandidateView, error)
	ConfirmCandidate(c core.Context, request installments.ConfirmRequest) (*installments.CandidateView, error)
}

type personalFinanceInstallmentIngester interface {
	IngestBatches(c core.Context, request installments.IngestRequest) (*installments.IngestResult, error)
}

type personalFinanceInstallmentCoordinator interface {
	personalFinanceInstallmentIngester
	GetCandidate(c core.Context, uid int64, candidateId int64) (*installments.CandidateView, error)
	FindCandidatesByRawRows(c core.Context, uid int64, rowIds []int64) ([]*installments.CandidateView, error)
	PromoteAfterPosting(c core.Context, request installments.PromoteRequest) error
	DiscardContractDrafts(c core.Context, uid int64, candidateIds []int64) error
}

var _ PersonalFinanceInstallmentsApplication = (*installments.Service)(nil)

type PersonalFinanceInstallmentsApi struct {
	application PersonalFinanceInstallmentsApplication
}

func NewPersonalFinanceInstallmentsApi(application PersonalFinanceInstallmentsApplication) (*PersonalFinanceInstallmentsApi, error) {
	if application == nil {
		return nil, errors.New("personal finance installment application is required")
	}
	return &PersonalFinanceInstallmentsApi{application: application}, nil
}

type personalFinanceInstallmentConfirmRequest struct {
	CandidateId                      int64                                       `json:"candidateId,string"`
	ExpectedVersion                  int64                                       `json:"expectedVersion"`
	TreatAsInstallment               *bool                                       `json:"treatAsInstallment"`
	LiabilityAccountId               *int64                                      `json:"liabilityAccountId,string"`
	TermCount                        *int64                                      `json:"termCount"`
	OpeningCompletedInstallmentCount int64                                       `json:"openingCompletedInstallmentCount"`
	PurchaseRelation                 installments.PurchaseRelation               `json:"purchaseRelation"`
	LinkedPurchaseTransactionId      *int64                                      `json:"linkedPurchaseTransactionId,string"`
	LinkedContractId                 *int64                                      `json:"linkedContractId,string"`
	Contract                         *personalFinanceLoanContractIdentityRequest `json:"contract"`
	Calculation                      *personalFinanceLoanCalculationRequest      `json:"calculation"`
}

type personalFinanceInstallmentMemberResponse struct {
	Id              string                  `json:"id"`
	Kind            installments.MemberKind `json:"kind"`
	RefId           string                  `json:"refId"`
	Role            installments.MemberRole `json:"role"`
	PeriodNumber    *int64                  `json:"periodNumber"`
	CreatedUnixTime int64                   `json:"createdUnixTime"`
}

type personalFinanceInstallmentCandidateResponse struct {
	Id                          string                                      `json:"id"`
	Status                      installments.CandidateStatus                `json:"status"`
	Version                     int64                                       `json:"version"`
	LiabilityAccountId          *string                                     `json:"liabilityAccountId"`
	TermCount                   *int64                                      `json:"termCount"`
	LinkedContractId            *string                                     `json:"linkedContractId"`
	PurchaseRelation            installments.PurchaseRelation               `json:"purchaseRelation"`
	LinkedPurchaseTransactionId *string                                     `json:"linkedPurchaseTransactionId"`
	PrincipalAmount             *int64                                      `json:"principalAmount"`
	PaymentAmount               *int64                                      `json:"paymentAmount"`
	InterestAmount              *int64                                      `json:"interestAmount"`
	FeeAmount                   *int64                                      `json:"feeAmount"`
	RepaymentMethod             installments.RepaymentMethod                `json:"repaymentMethod"`
	FirstDueDate                string                                      `json:"firstDueDate"`
	CurrentPeriod               *int64                                      `json:"currentPeriod"`
	CreatedUnixTime             int64                                       `json:"createdUnixTime"`
	UpdatedUnixTime             int64                                       `json:"updatedUnixTime"`
	Members                     []*personalFinanceInstallmentMemberResponse `json:"members"`
}

type personalFinanceInstallmentListResponse struct {
	Items      []*personalFinanceInstallmentCandidateResponse `json:"items"`
	NextCursor *personalFinanceInstallmentCursorResponse      `json:"nextCursor"`
}

type personalFinanceInstallmentCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	CandidateId     string `json:"candidateId"`
}

func (a *PersonalFinanceInstallmentsApi) InstallmentCandidateListHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "status", "limit", "cursor_updated_unix_time", "cursor_candidate_id") {
		return nil, errs.ErrParameterInvalid
	}
	status := installments.CandidateStatus(strings.TrimSpace(c.Query("status")))
	if !isPersonalFinanceInstallmentCandidateStatus(status) {
		return nil, errs.ErrParameterInvalid
	}
	limit := personalFinanceInstallmentDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > personalFinanceInstallmentMaximumListLimit {
			return nil, errs.ErrParameterInvalid
		}
		limit = parsed
	}
	var cursor *installments.CandidateCursor
	if rawTime := strings.TrimSpace(c.Query("cursor_updated_unix_time")); rawTime != "" || strings.TrimSpace(c.Query("cursor_candidate_id")) != "" {
		updated, err := strconv.ParseInt(rawTime, 10, 64)
		candidateId, idErr := strconv.ParseInt(strings.TrimSpace(c.Query("cursor_candidate_id")), 10, 64)
		if err != nil || idErr != nil || updated < 1 || candidateId < 1 {
			return nil, errs.ErrParameterInvalid
		}
		cursor = &installments.CandidateCursor{UpdatedUnixTime: updated, CandidateId: candidateId}
	}
	result, err := a.application.ListCandidates(c, c.GetCurrentUid(), status, cursor, limit)
	if err != nil {
		log.Warnf(c, "[personal_finance_installments.list] failed for user \"uid:%d\" and code \"%s\"", c.GetCurrentUid(), installments.ServiceErrorCodeOf(err))
		return nil, personalFinanceInstallmentServiceError(err)
	}
	return newPersonalFinanceInstallmentListResponse(result), nil
}

func (a *PersonalFinanceInstallmentsApi) InstallmentCandidateGetHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "id") {
		return nil, errs.ErrParameterInvalid
	}
	candidateId, err := strconv.ParseInt(strings.TrimSpace(c.Query("id")), 10, 64)
	if err != nil || candidateId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	result, getErr := a.application.GetCandidate(c, c.GetCurrentUid(), candidateId)
	if getErr != nil {
		log.Warnf(c, "[personal_finance_installments.get] failed for user \"uid:%d\" and candidate \"id:%d\"", c.GetCurrentUid(), candidateId)
		return nil, personalFinanceInstallmentServiceError(getErr)
	}
	return newPersonalFinanceInstallmentCandidateResponse(result), nil
}

func (a *PersonalFinanceInstallmentsApi) InstallmentCandidateConfirmHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceInstallmentConfirmRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	if request.TreatAsInstallment == nil || request.CandidateId < 1 || request.ExpectedVersion < 1 {
		return nil, errs.ErrParameterInvalid
	}
	spec, err := request.contractSpec()
	if err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.ConfirmCandidate(c, installments.ConfirmRequest{
		Uid: c.GetCurrentUid(), CandidateId: request.CandidateId, ExpectedVersion: request.ExpectedVersion,
		TreatAsInstallment: *request.TreatAsInstallment, LiabilityAccountId: request.LiabilityAccountId,
		TermCount: request.TermCount, PurchaseRelation: request.PurchaseRelation,
		LinkedPurchaseTransactionId: request.LinkedPurchaseTransactionId, LinkedContractId: request.LinkedContractId,
		Contract: spec,
	})
	if err != nil {
		log.Warnf(c, "[personal_finance_installments.confirm] failed for user \"uid:%d\" and candidate \"id:%d\"", c.GetCurrentUid(), request.CandidateId)
		return nil, personalFinanceInstallmentServiceError(err)
	}
	return newPersonalFinanceInstallmentCandidateResponse(result), nil
}

func newPersonalFinanceInstallmentListResponse(result *installments.CandidateListResult) *personalFinanceInstallmentListResponse {
	response := &personalFinanceInstallmentListResponse{Items: []*personalFinanceInstallmentCandidateResponse{}}
	if result == nil {
		return response
	}
	for _, item := range result.Items {
		response.Items = append(response.Items, newPersonalFinanceInstallmentCandidateResponse(item))
	}
	if result.NextCursor != nil {
		response.NextCursor = &personalFinanceInstallmentCursorResponse{
			UpdatedUnixTime: result.NextCursor.UpdatedUnixTime,
			CandidateId:     strconv.FormatInt(result.NextCursor.CandidateId, 10),
		}
	}
	return response
}

func newPersonalFinanceInstallmentCandidateResponse(value *installments.CandidateView) *personalFinanceInstallmentCandidateResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceInstallmentCandidateResponse{
		Id: strconv.FormatInt(value.CandidateId, 10), Status: value.Status, Version: value.Version,
		TermCount: value.TermCount, PurchaseRelation: value.PurchaseRelation,
		PrincipalAmount: value.PrincipalAmount, PaymentAmount: value.PaymentAmount,
		InterestAmount: value.InterestAmount, FeeAmount: value.FeeAmount, RepaymentMethod: value.RepaymentMethod,
		FirstDueDate: value.FirstDueDate, CurrentPeriod: value.CurrentPeriod,
		CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
		Members: []*personalFinanceInstallmentMemberResponse{},
	}
	response.LiabilityAccountId = formatOptionalId(value.LiabilityAccountId)
	response.LinkedContractId = formatOptionalId(value.LinkedContractId)
	response.LinkedPurchaseTransactionId = formatOptionalId(value.LinkedPurchaseTransactionId)
	for _, member := range value.Members {
		if member == nil {
			continue
		}
		response.Members = append(response.Members, &personalFinanceInstallmentMemberResponse{
			Id: strconv.FormatInt(member.MemberId, 10), Kind: member.MemberKind,
			RefId: strconv.FormatInt(member.MemberRefId, 10), Role: member.MemberRole,
			PeriodNumber: member.PeriodNumber, CreatedUnixTime: member.CreatedUnixTime,
		})
	}
	return response
}

func formatOptionalId(value *int64) *string {
	if value == nil {
		return nil
	}
	text := strconv.FormatInt(*value, 10)
	return &text
}

func (request *personalFinanceInstallmentConfirmRequest) contractSpec() (*loans.ContractSpec, error) {
	if request == nil {
		return nil, errors.New("installment confirm request is required")
	}
	if request.Contract == nil && request.Calculation == nil {
		return nil, nil
	}
	if request.Contract == nil || request.Calculation == nil {
		return nil, errors.New("installment contract details are incomplete")
	}
	spec, err := (&personalFinanceLoanCreateRequest{Contract: *request.Contract, Calculation: *request.Calculation,
		OpeningCompletedInstallmentCount: request.OpeningCompletedInstallmentCount}).spec()
	if err != nil {
		return nil, err
	}
	return &spec, nil
}

func personalFinanceInstallmentQueryAllowed(c *core.WebContext, allowed ...string) bool {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return false
	}
	allow := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allow[key] = struct{}{}
	}
	for key, values := range c.Request.URL.Query() {
		if _, ok := allow[key]; !ok || len(values) != 1 {
			return false
		}
	}
	return true
}

func isPersonalFinanceInstallmentCandidateStatus(value installments.CandidateStatus) bool {
	switch value {
	case installments.CANDIDATE_STATUS_PENDING, installments.CANDIDATE_STATUS_NEEDS_DETAILS, installments.CANDIDATE_STATUS_LINKED,
		installments.CANDIDATE_STATUS_CONVERTED, installments.CANDIDATE_STATUS_DISMISSED, installments.CANDIDATE_STATUS_ACTION_REQUIRED:
		return true
	default:
		return false
	}
}

func personalFinanceInstallmentServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, installments.ErrServiceInvalidRequest), errors.Is(err, installments.ErrServiceCandidateNotFound),
		errors.Is(err, installments.ErrServiceAccountRejected), errors.Is(err, installments.ErrServiceContractRejected):
		return errs.ErrParameterInvalid
	case errors.Is(err, installments.ErrServiceVersionConflict), errors.Is(err, installments.ErrServiceStateConflict):
		return errs.ErrRepeatedRequest
	default:
		return errs.ErrOperationFailed
	}
}
