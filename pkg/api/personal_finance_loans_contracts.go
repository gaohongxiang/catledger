package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans/calculation"
)

const (
	personalFinanceLoanDefaultListLimit       = 20
	personalFinanceLoanMaximumListLimit       = 100
	maximumJavaScriptSafeInteger        int64 = 1<<53 - 1
)

// PersonalFinanceLoansContractsApplication 是贷款计算与合同生命周期 HTTP 边界所需的最小应用接口。
type PersonalFinanceLoansContractsApplication interface {
	Calculate(request loans.CalculateRequest) (*loans.CalculationResult, error)
	ListContracts(c core.Context, uid int64, status loans.ContractStatus, cursor *loans.ContractCursor, limit int, asOfDate string) (*loans.ContractListResult, error)
	GetContract(c core.Context, uid int64, contractId int64, asOfDate string) (*loans.ContractDetail, error)
	CreateContract(c core.Context, request loans.CreateContractRequest) (*loans.CommandResult, error)
	ReviseContract(c core.Context, request loans.ReviseContractRequest) (*loans.CommandResult, error)
	CloseContract(c core.Context, request loans.CloseContractRequest) (*loans.CommandResult, error)
	ReopenContract(c core.Context, request loans.ContractCommandRequest) (*loans.CommandResult, error)
	CancelContract(c core.Context, request loans.ContractCommandRequest) (*loans.CommandResult, error)
}

var _ PersonalFinanceLoansContractsApplication = (*loans.Service)(nil)

// PersonalFinanceLoansContractsApi 提供尚未注册路由的贷款计算与合同生命周期处理器。
type PersonalFinanceLoansContractsApi struct {
	application PersonalFinanceLoansContractsApplication
	now         func() time.Time
}

// NewPersonalFinanceLoansContractsApi 创建可由组合根注入的薄 HTTP 边界。
func NewPersonalFinanceLoansContractsApi(application PersonalFinanceLoansContractsApplication) (*PersonalFinanceLoansContractsApi, error) {
	if application == nil {
		return nil, errors.New("personal finance loan application is required")
	}
	return &PersonalFinanceLoansContractsApi{application: application, now: time.Now}, nil
}

type personalFinanceLoanCalculationRequest struct {
	EffectiveDate            string                   `json:"effectiveDate"`
	ContractDate             string                   `json:"contractDate"`
	FirstDueDate             string                   `json:"firstDueDate"`
	FundingType              loans.FundingType        `json:"fundingType"`
	InputMode                loans.InputMode          `json:"inputMode"`
	RepaymentMethod          loans.RepaymentMethod    `json:"repaymentMethod"`
	RateQuoteType            loans.RateQuoteType      `json:"rateQuoteType"`
	PrincipalAmount          int64                    `json:"principalAmount"`
	ActualDisbursementAmount int64                    `json:"actualDisbursementAmount"`
	UpfrontFeeAmount         int64                    `json:"upfrontFeeAmount"`
	PerPeriodFeeAmount       int64                    `json:"perPeriodFeeAmount"`
	PaymentBasisAmount       *int64                   `json:"paymentBasisAmount"`
	TermCount                int64                    `json:"termCount"`
	QuotedRatePptr           *personalFinanceLoanPptr `json:"quotedRatePptr"`
	DiscountType             loans.DiscountType       `json:"discountType"`
	DiscountRatePptr         *personalFinanceLoanPptr `json:"discountRatePptr"`
	DiscountAmount           int64                    `json:"discountAmount"`
}

type personalFinanceLoanPptr string

func (value *personalFinanceLoanPptr) UnmarshalJSON(encoded []byte) error {
	if string(encoded) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(encoded, &text); err != nil {
		return errors.New("loan pptr must be a decimal string")
	}
	if _, err := parsePersonalFinanceLoanPptr(text); err != nil {
		return err
	}
	*value = personalFinanceLoanPptr(text)
	return nil
}

type personalFinanceLoanContractIdentityRequest struct {
	Name                    string             `json:"name"`
	LenderName              string             `json:"lenderName"`
	ContractType            loans.ContractType `json:"contractType"`
	LiabilityAccountId      int64              `json:"liabilityAccountId,string"`
	DefaultPaymentAccountId *int64             `json:"defaultPaymentAccountId,string"`
	Currency                string             `json:"currency"`
	Note                    string             `json:"note"`
}

type personalFinanceLoanCreateRequest struct {
	Contract       personalFinanceLoanContractIdentityRequest `json:"contract"`
	Calculation    personalFinanceLoanCalculationRequest      `json:"calculation"`
	IdempotencyKey string                                     `json:"idempotencyKey"`
}

type personalFinanceLoanReviseRequest struct {
	ContractId              int64                                 `json:"contractId,string"`
	ExpectedContractVersion int64                                 `json:"expectedContractVersion"`
	Calculation             personalFinanceLoanCalculationRequest `json:"calculation"`
	IdempotencyKey          string                                `json:"idempotencyKey"`
}

type personalFinanceLoanLifecycleRequest struct {
	ContractId              int64  `json:"contractId,string"`
	ExpectedContractVersion int64  `json:"expectedContractVersion"`
	IdempotencyKey          string `json:"idempotencyKey"`
}

type personalFinanceLoanCloseRequest struct {
	ContractId              int64                 `json:"contractId,string"`
	ExpectedContractVersion int64                 `json:"expectedContractVersion"`
	CloseReason             loans.CloseReasonCode `json:"closeReason"`
	IdempotencyKey          string                `json:"idempotencyKey"`
}

type personalFinanceLoanListRequest struct {
	Status loans.ContractStatus
	Cursor *loans.ContractCursor
	Limit  int
}

type personalFinanceLoanCalculationInputResponse struct {
	EffectiveDate            string                `json:"effectiveDate"`
	FundingType              loans.FundingType     `json:"fundingType"`
	InputMode                loans.InputMode       `json:"inputMode"`
	RepaymentMethod          loans.RepaymentMethod `json:"repaymentMethod"`
	RateQuoteType            loans.RateQuoteType   `json:"rateQuoteType"`
	ContractDate             string                `json:"contractDate"`
	FirstDueDate             string                `json:"firstDueDate"`
	PrincipalAmount          int64                 `json:"principalAmount"`
	ActualDisbursementAmount int64                 `json:"actualDisbursementAmount"`
	UpfrontFeeAmount         int64                 `json:"upfrontFeeAmount"`
	PerPeriodFeeAmount       int64                 `json:"perPeriodFeeAmount"`
	TermCount                int64                 `json:"termCount"`
	QuotedRatePptr           *string               `json:"quotedRatePptr,omitempty"`
	PaymentBasisAmount       *int64                `json:"paymentBasisAmount,omitempty"`
	DiscountType             loans.DiscountType    `json:"discountType"`
	DiscountRatePptr         *string               `json:"discountRatePptr,omitempty"`
	DiscountAmount           int64                 `json:"discountAmount"`
}

type personalFinanceLoanCalculationSummaryResponse struct {
	PreDiscountTotalPaymentAmount int64   `json:"preDiscountTotalPaymentAmount"`
	PreDiscountTotalCostAmount    int64   `json:"preDiscountTotalCostAmount"`
	TotalPaymentAmount            int64   `json:"totalPaymentAmount"`
	TotalInterestAmount           int64   `json:"totalInterestAmount"`
	TotalFeeAmount                int64   `json:"totalFeeAmount"`
	TotalDiscountAmount           int64   `json:"totalDiscountAmount"`
	TotalCostAmount               int64   `json:"totalCostAmount"`
	CostRatioPptr                 string  `json:"costRatioPptr"`
	IrrStatus                     string  `json:"irrStatus"`
	MonthlyIrrPptr                *string `json:"monthlyIrrPptr,omitempty"`
	SimpleAprPptr                 *string `json:"simpleAprPptr,omitempty"`
	EffectiveAprPptr              *string `json:"effectiveAprPptr,omitempty"`
}

type personalFinanceLoanCalculatedInstallmentResponse struct {
	InstallmentNumber         int64  `json:"installmentNumber"`
	DueDate                   string `json:"dueDate"`
	BeginningPrincipalAmount  int64  `json:"beginningPrincipalAmount"`
	PrincipalAmount           int64  `json:"principalAmount"`
	InterestAmount            int64  `json:"interestAmount"`
	FeeAmount                 int64  `json:"feeAmount"`
	DiscountAmount            int64  `json:"discountAmount"`
	PaymentAmount             int64  `json:"paymentAmount"`
	EndingPrincipalAmount     int64  `json:"endingPrincipalAmount"`
	PreDiscountInterestAmount int64  `json:"preDiscountInterestAmount"`
	PreDiscountFeeAmount      int64  `json:"preDiscountFeeAmount"`
	PreDiscountPaymentAmount  int64  `json:"preDiscountPaymentAmount"`
}

type personalFinanceLoanCalculationResponse struct {
	CalculationVersion string                                              `json:"calculationVersion"`
	RoundingVersion    string                                              `json:"roundingVersion"`
	IrrVersion         string                                              `json:"irrVersion"`
	Summary            *personalFinanceLoanCalculationSummaryResponse      `json:"summary"`
	Installments       []*personalFinanceLoanCalculatedInstallmentResponse `json:"installments"`
}

type personalFinanceLoanContractResponse struct {
	Id                      int64                  `json:"id,string"`
	Name                    string                 `json:"name"`
	LenderName              string                 `json:"lenderName"`
	ContractType            loans.ContractType     `json:"contractType"`
	Status                  loans.ContractStatus   `json:"status"`
	CloseReason             *loans.CloseReasonCode `json:"closeReason,omitempty"`
	LiabilityAccountId      int64                  `json:"liabilityAccountId,string"`
	DefaultPaymentAccountId *int64                 `json:"defaultPaymentAccountId,string,omitempty"`
	Currency                string                 `json:"currency"`
	Note                    string                 `json:"note"`
	Version                 int64                  `json:"version"`
	CurrentRevisionId       int64                  `json:"currentRevisionId,string"`
	CreatedUnixTime         int64                  `json:"createdUnixTime"`
	UpdatedUnixTime         int64                  `json:"updatedUnixTime"`
	ClosedUnixTime          *int64                 `json:"closedUnixTime,omitempty"`
}

type personalFinanceLoanRevisionResponse struct {
	Id                 int64                                        `json:"id,string"`
	RevisionNumber     int64                                        `json:"revisionNumber"`
	PreviousRevisionId *int64                                       `json:"previousRevisionId,string,omitempty"`
	EffectiveDate      string                                       `json:"effectiveDate"`
	Input              *personalFinanceLoanCalculationInputResponse `json:"input"`
	Calculation        *personalFinanceLoanCalculationResponse      `json:"calculation"`
	CreatedUnixTime    int64                                        `json:"createdUnixTime"`
}

type personalFinanceLoanReasonResponse struct {
	Code string `json:"code"`
}

type personalFinanceLoanInstallmentProgressResponse struct {
	SettlementStatus           loans.InstallmentProgressStatus      `json:"settlementStatus"`
	Overdue                    bool                                 `json:"overdue"`
	AllocatedPrincipalAmount   int64                                `json:"allocatedPrincipalAmount"`
	AllocatedInterestAmount    int64                                `json:"allocatedInterestAmount"`
	AllocatedFeeAmount         int64                                `json:"allocatedFeeAmount"`
	OutstandingPrincipalAmount int64                                `json:"outstandingPrincipalAmount"`
	OutstandingInterestAmount  int64                                `json:"outstandingInterestAmount"`
	OutstandingFeeAmount       int64                                `json:"outstandingFeeAmount"`
	OutstandingPaymentAmount   int64                                `json:"outstandingPaymentAmount"`
	ActionRequired             bool                                 `json:"actionRequired"`
	ReasonCodes                []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
}

type personalFinanceLoanInstallmentResponse struct {
	*personalFinanceLoanCalculatedInstallmentResponse
	Id         int64                                           `json:"id,string"`
	RevisionId int64                                           `json:"revisionId,string"`
	Progress   *personalFinanceLoanInstallmentProgressResponse `json:"progress"`
}

type personalFinanceLoanAllocationSummaryResponse struct {
	ActiveAllocationCount         int64 `json:"activeAllocationCount"`
	ActionRequiredAllocationCount int64 `json:"actionRequiredAllocationCount"`
	AllocatedDisbursementAmount   int64 `json:"allocatedDisbursementAmount"`
	AllocatedPrincipalAmount      int64 `json:"allocatedPrincipalAmount"`
	AllocatedInterestAmount       int64 `json:"allocatedInterestAmount"`
	AllocatedFeeAmount            int64 `json:"allocatedFeeAmount"`
}

type personalFinanceLoanLiabilityComparisonResponse struct {
	PlannedOutstandingPrincipalAmount int64                                `json:"plannedOutstandingPrincipalAmount"`
	LedgerOutstandingLiabilityAmount  int64                                `json:"ledgerOutstandingLiabilityAmount"`
	DifferenceAmount                  int64                                `json:"differenceAmount"`
	ActionRequired                    bool                                 `json:"actionRequired"`
	ReasonCodes                       []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
}

type personalFinanceLoanContractDetailResponse struct {
	Contract            *personalFinanceLoanContractResponse            `json:"contract"`
	CurrentRevision     *personalFinanceLoanRevisionResponse            `json:"currentRevision"`
	Installments        []*personalFinanceLoanInstallmentResponse       `json:"installments"`
	Allocations         *personalFinanceLoanAllocationSummaryResponse   `json:"allocations"`
	LiabilityComparison *personalFinanceLoanLiabilityComparisonResponse `json:"liabilityComparison"`
	AsOfDate            string                                          `json:"asOfDate"`
}

type personalFinanceLoanContractSummaryResponse struct {
	Contract                   *personalFinanceLoanContractResponse           `json:"contract"`
	Calculation                *personalFinanceLoanCalculationSummaryResponse `json:"calculation"`
	PaidInstallmentCount       int64                                          `json:"paidInstallmentCount"`
	PartialInstallmentCount    int64                                          `json:"partialInstallmentCount"`
	TotalInstallmentCount      int64                                          `json:"totalInstallmentCount"`
	OutstandingPrincipalAmount int64                                          `json:"outstandingPrincipalAmount"`
	OutstandingPaymentAmount   int64                                          `json:"outstandingPaymentAmount"`
	ActionRequired             bool                                           `json:"actionRequired"`
	ReasonCodes                []*personalFinanceLoanReasonResponse           `json:"reasonCodes"`
}

type personalFinanceLoanCursorResponse struct {
	Status          loans.ContractStatus `json:"status"`
	UpdatedUnixTime int64                `json:"updatedUnixTime"`
	ContractId      int64                `json:"contractId,string"`
}

type personalFinanceLoanPageResponse struct {
	Items      []*personalFinanceLoanContractSummaryResponse `json:"items"`
	NextCursor *personalFinanceLoanCursorResponse            `json:"nextCursor,omitempty"`
}

type personalFinanceLoanActionResponse struct {
	ActionId    int64                                `json:"actionId,string"`
	Status      loans.ActionStatus                   `json:"status"`
	Allocations []any                                `json:"allocations"`
	Replayed    bool                                 `json:"replayed"`
	ReasonCodes []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
}

// LoanCalculateHandler 执行无持久化副作用的规范贷款计算。
func (a *PersonalFinanceLoansContractsApi) LoanCalculateHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanCalculationRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	terms, err := request.terms()
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.application == nil {
		return nil, errs.ErrOperationFailed
	}
	result, err := a.application.Calculate(loans.CalculateRequest{Terms: terms})
	if err != nil {
		a.logServiceFailure(c, "calculate", 0, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanCalculationResponse(result)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.calculate] invalid result for user \"uid:%d\"", c.GetCurrentUid())
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanContractListHandler 返回当前用户按状态和稳定游标分页的合同摘要。
func (a *PersonalFinanceLoansContractsApi) LoanContractListHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceLoanListRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	asOfDate, apiErr := a.clientCivilDate(c)
	if apiErr != nil {
		return nil, apiErr
	}
	result, err := a.application.ListContracts(c, c.GetCurrentUid(), request.Status, request.Cursor, request.Limit, asOfDate)
	if err != nil {
		a.logServiceFailure(c, "list_contracts", 0, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanPageResponse(result, request.Status)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.list_contracts] invalid result for user \"uid:%d\"", c.GetCurrentUid())
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanContractGetHandler 返回当前用户合同的当前计划和账本差异。
func (a *PersonalFinanceLoansContractsApi) LoanContractGetHandler(c *core.WebContext) (any, *errs.Error) {
	contractId, err := parsePersonalFinanceLoanContractQuery(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	asOfDate, apiErr := a.clientCivilDate(c)
	if apiErr != nil {
		return nil, apiErr
	}
	result, err := a.application.GetContract(c, c.GetCurrentUid(), contractId, asOfDate)
	if err != nil {
		a.logServiceFailure(c, "get_contract", contractId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanContractDetailResponse(result, asOfDate)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.get_contract] invalid result for user \"uid:%d\" and contract \"id:%d\"", c.GetCurrentUid(), contractId)
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanContractCreateHandler 创建当前用户的贷款合同和首个不可变计划。
func (a *PersonalFinanceLoansContractsApi) LoanContractCreateHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanCreateRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	spec, err := request.spec()
	if err != nil || !isPersonalFinanceLoanIdempotencyKey(request.IdempotencyKey) {
		if err == nil {
			err = errors.New("loan idempotency key is invalid")
		}
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	result, err := a.application.CreateContract(c, loans.CreateContractRequest{Uid: c.GetCurrentUid(), Spec: spec, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		a.logServiceFailure(c, "create_contract", 0, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	return a.actionResponse(c, "create_contract", result)
}

// LoanContractReviseHandler 仅复用同 uid 当前合同的身份字段，客户端只能提交新计算输入。
func (a *PersonalFinanceLoansContractsApi) LoanContractReviseHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanReviseRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	terms, err := request.Calculation.terms()
	if err != nil || request.ContractId < 1 || !isPersonalFinanceLoanSafeNumber(request.ExpectedContractVersion) || request.ExpectedContractVersion < 1 || !isPersonalFinanceLoanIdempotencyKey(request.IdempotencyKey) {
		if err == nil {
			err = errors.New("loan revision request is invalid")
		}
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	uid := c.GetCurrentUid()
	current, err := a.application.GetContract(c, uid, request.ContractId, a.now().UTC().Format(time.DateOnly))
	if err != nil {
		a.logServiceFailure(c, "revise_contract_read", request.ContractId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	if current == nil || current.Contract == nil {
		return nil, errs.ErrOperationFailed
	}
	if current.Contract.Version != request.ExpectedContractVersion {
		return nil, errs.ErrRepeatedRequest
	}
	identity := current.Contract
	spec := loans.ContractSpec{Name: identity.Name, LenderName: identity.LenderName, ContractType: identity.ContractType,
		LiabilityAccountId: identity.LiabilityAccountId, DefaultPaymentAccountId: clonePersonalFinanceLoanInt64(identity.DefaultPaymentAccountId),
		Currency: identity.Currency, Note: identity.Note, Terms: terms}
	result, err := a.application.ReviseContract(c, loans.ReviseContractRequest{Uid: uid, ContractId: request.ContractId,
		ExpectedContractVersion: request.ExpectedContractVersion, Spec: spec, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		a.logServiceFailure(c, "revise_contract", request.ContractId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	return a.actionResponse(c, "revise_contract", result)
}

// LoanContractCloseHandler 显式关闭当前用户合同。
func (a *PersonalFinanceLoansContractsApi) LoanContractCloseHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanCloseRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if err := validatePersonalFinanceLoanLifecycleRequest(request.ContractId, request.ExpectedContractVersion, request.IdempotencyKey); err != nil || !isPersonalFinanceLoanCloseReason(request.CloseReason) {
		if err == nil {
			err = errors.New("loan close reason is invalid")
		}
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	result, err := a.application.CloseContract(c, loans.CloseContractRequest{Uid: c.GetCurrentUid(), ContractId: request.ContractId,
		ExpectedContractVersion: request.ExpectedContractVersion, Reason: request.CloseReason, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		a.logServiceFailure(c, "close_contract", request.ContractId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	return a.actionResponse(c, "close_contract", result)
}

// LoanContractReopenHandler 恢复已关闭合同。
func (a *PersonalFinanceLoansContractsApi) LoanContractReopenHandler(c *core.WebContext) (any, *errs.Error) {
	return a.lifecycleHandler(c, "reopen_contract", a.application.ReopenContract)
}

// LoanContractCancelHandler 取消从未产生分配历史的合同。
func (a *PersonalFinanceLoansContractsApi) LoanContractCancelHandler(c *core.WebContext) (any, *errs.Error) {
	return a.lifecycleHandler(c, "cancel_contract", a.application.CancelContract)
}

func (a *PersonalFinanceLoansContractsApi) lifecycleHandler(c *core.WebContext, operation string, execute func(core.Context, loans.ContractCommandRequest) (*loans.CommandResult, error)) (any, *errs.Error) {
	request := new(personalFinanceLoanLifecycleRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if err := validatePersonalFinanceLoanLifecycleRequest(request.ContractId, request.ExpectedContractVersion, request.IdempotencyKey); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	result, err := execute(c, loans.ContractCommandRequest{Uid: c.GetCurrentUid(), ContractId: request.ContractId,
		ExpectedContractVersion: request.ExpectedContractVersion, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		a.logServiceFailure(c, operation, request.ContractId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	return a.actionResponse(c, operation, result)
}

func (a *PersonalFinanceLoansContractsApi) actionResponse(c *core.WebContext, operation string, result *loans.CommandResult) (any, *errs.Error) {
	response, err := newPersonalFinanceLoanActionResponse(result)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.%s] invalid result for user \"uid:%d\"", operation, c.GetCurrentUid())
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

func (a *PersonalFinanceLoansContractsApi) clientCivilDate(c *core.WebContext) (string, *errs.Error) {
	if a == nil || a.application == nil || a.now == nil || c == nil {
		return "", errs.ErrOperationFailed
	}
	location, err := c.GetClientTimezone()
	if err != nil || location == nil {
		return "", errs.ErrClientTimezoneOffsetInvalid
	}
	return a.now().In(location).Format(time.DateOnly), nil
}

func (a *PersonalFinanceLoansContractsApi) logServiceFailure(c *core.WebContext, operation string, contractId int64, err error) {
	code := loans.ServiceErrorCodeOf(err)
	if contractId > 0 {
		log.Warnf(c, "[personal_finance_loans.%s] failed for user \"uid:%d\", contract \"id:%d\" and code \"%s\"", operation, c.GetCurrentUid(), contractId, code)
		return
	}
	log.Warnf(c, "[personal_finance_loans.%s] failed for user \"uid:%d\" and code \"%s\"", operation, c.GetCurrentUid(), code)
}

func decodePersonalFinanceLoanJSON(c *core.WebContext, destination any) error {
	if c == nil || c.Request == nil || c.Request.Body == nil || destination == nil {
		return errors.New("loan request is required")
	}
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("loan request contains multiple JSON values")
		}
		return err
	}
	return nil
}

func (request *personalFinanceLoanCalculationRequest) terms() (loans.CalculationTerms, error) {
	if request == nil || !isPersonalFinanceLoanAmount(request.PrincipalAmount, true) || !isPersonalFinanceLoanAmount(request.ActualDisbursementAmount, true) ||
		!isPersonalFinanceLoanAmount(request.UpfrontFeeAmount, false) || !isPersonalFinanceLoanAmount(request.PerPeriodFeeAmount, false) ||
		!isPersonalFinanceLoanOptionalAmount(request.PaymentBasisAmount, true) || !isPersonalFinanceLoanAmount(request.DiscountAmount, false) ||
		!isPersonalFinanceLoanSafeNumber(request.TermCount) || request.TermCount < 1 || request.TermCount > calculation.MaxTermCount {
		return loans.CalculationTerms{}, errors.New("loan calculation numeric input is invalid")
	}
	quoted, err := personalFinanceLoanPptrValue(request.QuotedRatePptr)
	if err != nil {
		return loans.CalculationTerms{}, err
	}
	discountRate, err := personalFinanceLoanPptrValue(request.DiscountRatePptr)
	if err != nil {
		return loans.CalculationTerms{}, err
	}
	return loans.CalculationTerms{EffectiveDate: request.EffectiveDate, ContractDate: request.ContractDate, FirstDueDate: request.FirstDueDate,
		FundingType: request.FundingType, InputMode: request.InputMode, RepaymentMethod: request.RepaymentMethod, RateQuoteType: request.RateQuoteType,
		PrincipalAmount: request.PrincipalAmount, ActualDisbursementAmount: request.ActualDisbursementAmount, UpfrontFeeAmount: request.UpfrontFeeAmount,
		PerPeriodFeeAmount: request.PerPeriodFeeAmount, PaymentBasisAmount: clonePersonalFinanceLoanInt64(request.PaymentBasisAmount), TermCount: request.TermCount,
		QuotedRatePptr: quoted, DiscountType: request.DiscountType, DiscountRatePptr: discountRate, DiscountAmount: request.DiscountAmount}, nil
}

func (request *personalFinanceLoanCreateRequest) spec() (loans.ContractSpec, error) {
	if request == nil || request.Contract.LiabilityAccountId < 1 || (request.Contract.DefaultPaymentAccountId != nil && *request.Contract.DefaultPaymentAccountId < 1) ||
		!utf8.ValidString(request.Contract.Name) || !utf8.ValidString(request.Contract.LenderName) || !utf8.ValidString(request.Contract.Note) ||
		utf8.RuneCountInString(request.Contract.Name) > 128 || utf8.RuneCountInString(request.Contract.LenderName) > 128 || utf8.RuneCountInString(request.Contract.Note) > 255 {
		return loans.ContractSpec{}, errors.New("loan contract identity is invalid")
	}
	terms, err := request.Calculation.terms()
	if err != nil {
		return loans.ContractSpec{}, err
	}
	return loans.ContractSpec{Name: request.Contract.Name, LenderName: request.Contract.LenderName, ContractType: request.Contract.ContractType,
		LiabilityAccountId: request.Contract.LiabilityAccountId, DefaultPaymentAccountId: clonePersonalFinanceLoanInt64(request.Contract.DefaultPaymentAccountId),
		Currency: request.Contract.Currency, Note: request.Contract.Note, Terms: terms}, nil
}

func parsePersonalFinanceLoanListRequest(c *core.WebContext) (*personalFinanceLoanListRequest, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return nil, errors.New("loan contract list request is required")
	}
	values := c.Request.URL.Query()
	if err := validatePersonalFinanceLoanQueryKeys(values, "status", "cursor_updated_unix_time", "cursor_contract_id", "limit"); err != nil {
		return nil, err
	}
	request := &personalFinanceLoanListRequest{Status: loans.ContractStatus(values.Get("status")), Limit: personalFinanceLoanDefaultListLimit}
	if !isPersonalFinanceLoanContractStatus(request.Status) {
		return nil, errors.New("loan contract status is invalid")
	}
	updatedText, contractText := values.Get("cursor_updated_unix_time"), values.Get("cursor_contract_id")
	if (updatedText == "") != (contractText == "") {
		return nil, errors.New("loan contract cursor is incomplete")
	}
	if updatedText != "" {
		updated, err := parsePersonalFinanceLoanPositiveInt64(updatedText)
		if err != nil {
			return nil, err
		}
		contractId, err := parsePersonalFinanceLoanPositiveInt64(contractText)
		if err != nil {
			return nil, err
		}
		request.Cursor = &loans.ContractCursor{UpdatedUnixTime: updated, ContractId: contractId}
	}
	if text := values.Get("limit"); text != "" {
		limit, err := strconv.Atoi(text)
		if err != nil || limit < 1 || limit > personalFinanceLoanMaximumListLimit {
			return nil, errors.New("loan contract limit is invalid")
		}
		request.Limit = limit
	}
	return request, nil
}

func parsePersonalFinanceLoanContractQuery(c *core.WebContext) (int64, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return 0, errors.New("loan contract request is required")
	}
	values := c.Request.URL.Query()
	if err := validatePersonalFinanceLoanQueryKeys(values, "contract_id"); err != nil {
		return 0, err
	}
	return parsePersonalFinanceLoanPositiveInt64(values.Get("contract_id"))
}

func validatePersonalFinanceLoanQueryKeys(values url.Values, allowed ...string) error {
	allow := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allow[key] = struct{}{}
	}
	for key, entries := range values {
		if _, ok := allow[key]; !ok || len(entries) != 1 {
			return fmt.Errorf("loan query parameter %q is invalid", key)
		}
	}
	return nil
}

func parsePersonalFinanceLoanPositiveInt64(value string) (int64, error) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("positive loan identifier is required")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, errors.New("positive loan identifier is required")
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		return 0, errors.New("positive loan identifier is required")
	}
	return parsed, nil
}

func validatePersonalFinanceLoanLifecycleRequest(contractId int64, version int64, key string) error {
	if contractId < 1 || version < 1 || !isPersonalFinanceLoanSafeNumber(version) || !isPersonalFinanceLoanIdempotencyKey(key) {
		return errors.New("loan lifecycle request is invalid")
	}
	return nil
}

func parsePersonalFinanceLoanPptr(value string) (int64, error) {
	if value == "" {
		return 0, errors.New("loan pptr is empty")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, errors.New("loan pptr must contain only decimal digits")
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, errors.New("loan pptr is out of range")
	}
	return parsed, nil
}

func personalFinanceLoanPptrValue(value *personalFinanceLoanPptr) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := parsePersonalFinanceLoanPptr(string(*value))
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func isPersonalFinanceLoanIdempotencyKey(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range []byte(value) {
		if char < 0x21 || char > 0x7e {
			return false
		}
	}
	return true
}

func isPersonalFinanceLoanAmount(value int64, positive bool) bool {
	return value >= 0 && (!positive || value > 0) && value <= models.MaximumTransactionAmount
}

func isPersonalFinanceLoanOptionalAmount(value *int64, positive bool) bool {
	return value == nil || isPersonalFinanceLoanAmount(*value, positive)
}

func isPersonalFinanceLoanSafeNumber(value int64) bool {
	return value >= 0 && value <= maximumJavaScriptSafeInteger
}

func isPersonalFinanceLoanSafeSignedNumber(value int64) bool {
	return value >= -maximumJavaScriptSafeInteger && value <= maximumJavaScriptSafeInteger
}

func clonePersonalFinanceLoanInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func personalFinanceLoanPptrString(value *int64) *string {
	if value == nil {
		return nil
	}
	text := strconv.FormatInt(*value, 10)
	return &text
}

func newPersonalFinanceLoanCalculationResponse(value *loans.CalculationResult) (*personalFinanceLoanCalculationResponse, error) {
	if value == nil || value.CalculationVersion != calculation.CalculationVersion || value.RoundingVersion != calculation.RoundingVersion || value.IrrVersion != calculation.IRRVersion ||
		!isPersonalFinanceLoanAmount(value.ActualDisbursementAmount, true) || value.PeriodicRatePptr < 0 {
		return nil, errors.New("loan calculation result is invalid")
	}
	summary, err := newPersonalFinanceLoanCalculationSummary(value.PreDiscountTotalPaymentAmount, value.PreDiscountTotalCostAmount,
		value.TotalPaymentAmount, value.TotalInterestAmount, value.TotalFeeAmount, value.TotalDiscountAmount, value.TotalCostAmount,
		value.CostRatioPptr, loans.IRRStatus(value.IRR.Status), value.IRR.MonthlyIRRPPTR, value.IRR.SimpleAPRPPTR, value.IRR.EffectiveAPRPPTR)
	if err != nil {
		return nil, err
	}
	installments := make([]*personalFinanceLoanCalculatedInstallmentResponse, 0, len(value.Installments))
	for index := range value.Installments {
		row, err := newPersonalFinanceLoanCalculatedInstallment(value.Installments[index])
		if err != nil || row.InstallmentNumber != int64(index+1) {
			return nil, errors.New("loan calculation installment is invalid")
		}
		installments = append(installments, row)
	}
	if len(installments) == 0 {
		return nil, errors.New("loan calculation installments are empty")
	}
	return &personalFinanceLoanCalculationResponse{CalculationVersion: value.CalculationVersion, RoundingVersion: value.RoundingVersion,
		IrrVersion: value.IrrVersion, Summary: summary, Installments: installments}, nil
}

func newPersonalFinanceLoanCalculationSummary(prePayment, preCost, totalPayment, interest, fee, discount, totalCost, costRatio int64,
	irrStatus loans.IRRStatus, monthly, simple, effective *int64) (*personalFinanceLoanCalculationSummaryResponse, error) {
	for _, amount := range []int64{prePayment, preCost, totalPayment, interest, fee, discount, totalCost} {
		if !isPersonalFinanceLoanAmount(amount, false) {
			return nil, errors.New("loan calculation summary amount is invalid")
		}
	}
	if costRatio < 0 || !isPersonalFinanceLoanIRRStatus(irrStatus) {
		return nil, errors.New("loan calculation summary rate is invalid")
	}
	if irrStatus == loans.IRR_STATUS_SOLVED || irrStatus == loans.IRR_STATUS_SOLVED_ZERO {
		if monthly == nil || simple == nil || effective == nil || *monthly < 0 || *simple < 0 || *effective < 0 {
			return nil, errors.New("solved loan IRR is incomplete")
		}
		if irrStatus == loans.IRR_STATUS_SOLVED_ZERO && (*monthly != 0 || *simple != 0 || *effective != 0) {
			return nil, errors.New("zero loan IRR is inconsistent")
		}
	} else if monthly != nil || simple != nil || effective != nil {
		return nil, errors.New("unsolved loan IRR contains rates")
	}
	return &personalFinanceLoanCalculationSummaryResponse{PreDiscountTotalPaymentAmount: prePayment, PreDiscountTotalCostAmount: preCost,
		TotalPaymentAmount: totalPayment, TotalInterestAmount: interest, TotalFeeAmount: fee, TotalDiscountAmount: discount,
		TotalCostAmount: totalCost, CostRatioPptr: strconv.FormatInt(costRatio, 10), IrrStatus: string(irrStatus),
		MonthlyIrrPptr: personalFinanceLoanPptrString(monthly), SimpleAprPptr: personalFinanceLoanPptrString(simple),
		EffectiveAprPptr: personalFinanceLoanPptrString(effective)}, nil
}

func newPersonalFinanceLoanCalculatedInstallment(value calculation.Installment) (*personalFinanceLoanCalculatedInstallmentResponse, error) {
	for _, amount := range []int64{value.BeginningPrincipalAmount, value.PrincipalAmount, value.InterestAmount, value.FeeAmount,
		value.DiscountAmount, value.PaymentAmount, value.EndingPrincipalAmount, value.PreDiscountInterestAmount,
		value.PreDiscountFeeAmount, value.PreDiscountPaymentAmount} {
		if !isPersonalFinanceLoanAmount(amount, false) {
			return nil, errors.New("loan installment amount is invalid")
		}
	}
	if value.InstallmentNumber < 1 || !isPersonalFinanceLoanSafeNumber(value.InstallmentNumber) {
		return nil, errors.New("loan installment number is invalid")
	}
	if value.PrincipalAmount > value.BeginningPrincipalAmount || value.EndingPrincipalAmount != value.BeginningPrincipalAmount-value.PrincipalAmount ||
		value.PaymentAmount != value.PrincipalAmount+value.InterestAmount+value.FeeAmount ||
		value.PreDiscountPaymentAmount != value.PrincipalAmount+value.PreDiscountInterestAmount+value.PreDiscountFeeAmount ||
		value.PreDiscountInterestAmount+value.PreDiscountFeeAmount < value.InterestAmount+value.FeeAmount ||
		value.DiscountAmount != value.PreDiscountInterestAmount+value.PreDiscountFeeAmount-value.InterestAmount-value.FeeAmount {
		return nil, errors.New("loan installment components are inconsistent")
	}
	if _, err := calculation.ParseCivilDate(value.DueDate); err != nil {
		return nil, errors.New("loan installment date is invalid")
	}
	return &personalFinanceLoanCalculatedInstallmentResponse{InstallmentNumber: value.InstallmentNumber, DueDate: value.DueDate,
		BeginningPrincipalAmount: value.BeginningPrincipalAmount, PrincipalAmount: value.PrincipalAmount, InterestAmount: value.InterestAmount,
		FeeAmount: value.FeeAmount, DiscountAmount: value.DiscountAmount, PaymentAmount: value.PaymentAmount, EndingPrincipalAmount: value.EndingPrincipalAmount,
		PreDiscountInterestAmount: value.PreDiscountInterestAmount, PreDiscountFeeAmount: value.PreDiscountFeeAmount,
		PreDiscountPaymentAmount: value.PreDiscountPaymentAmount}, nil
}

func newPersonalFinanceLoanContractResponse(value *loans.ContractResult) (*personalFinanceLoanContractResponse, error) {
	if value == nil || value.ContractId < 1 || value.LiabilityAccountId < 1 || value.CurrentRevisionId < 1 || value.Version < 1 ||
		!isPersonalFinanceLoanSafeNumber(value.Version) || !isPersonalFinanceLoanSafeNumber(value.CreatedUnixTime) || value.CreatedUnixTime < 1 ||
		!isPersonalFinanceLoanSafeNumber(value.UpdatedUnixTime) || value.UpdatedUnixTime < 1 || !isPersonalFinanceLoanContractType(value.ContractType) ||
		!isPersonalFinanceLoanContractStatus(value.Status) || !utf8.ValidString(value.Name) || !utf8.ValidString(value.LenderName) || !utf8.ValidString(value.Note) ||
		strings.TrimSpace(value.Name) == "" || utf8.RuneCountInString(value.Name) > 128 || utf8.RuneCountInString(value.LenderName) > 128 || utf8.RuneCountInString(value.Note) > 255 ||
		!isPersonalFinanceLoanCurrency(value.Currency) || strings.IndexByte(value.Name, 0) >= 0 || strings.IndexByte(value.LenderName, 0) >= 0 || strings.IndexByte(value.Note, 0) >= 0 ||
		(value.DefaultPaymentAccountId != nil && *value.DefaultPaymentAccountId < 1) || (value.ClosedUnixTime != nil && (*value.ClosedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(*value.ClosedUnixTime))) {
		return nil, errors.New("loan contract result is invalid")
	}
	response := &personalFinanceLoanContractResponse{Id: value.ContractId, Name: value.Name, LenderName: value.LenderName,
		ContractType: value.ContractType, Status: value.Status, LiabilityAccountId: value.LiabilityAccountId,
		DefaultPaymentAccountId: clonePersonalFinanceLoanInt64(value.DefaultPaymentAccountId), Currency: value.Currency, Note: value.Note,
		Version: value.Version, CurrentRevisionId: value.CurrentRevisionId, CreatedUnixTime: value.CreatedUnixTime,
		UpdatedUnixTime: value.UpdatedUnixTime, ClosedUnixTime: clonePersonalFinanceLoanInt64(value.ClosedUnixTime)}
	if value.CloseReasonCode != loans.CLOSE_REASON_NONE {
		if value.Status != loans.CONTRACT_STATUS_CLOSED || !isPersonalFinanceLoanCloseReason(value.CloseReasonCode) {
			return nil, errors.New("loan close reason is invalid")
		}
		reason := value.CloseReasonCode
		response.CloseReason = &reason
	} else if value.Status == loans.CONTRACT_STATUS_CLOSED {
		return nil, errors.New("closed loan contract has no reason")
	}
	if value.Status == loans.CONTRACT_STATUS_CLOSED && value.ClosedUnixTime == nil || value.Status != loans.CONTRACT_STATUS_CLOSED && value.ClosedUnixTime != nil {
		return nil, errors.New("loan contract close state is inconsistent")
	}
	return response, nil
}

func newPersonalFinanceLoanRevisionInput(value *loans.RevisionResult) (*personalFinanceLoanCalculationInputResponse, error) {
	if value == nil || value.FrequencyType != loans.FREQUENCY_TYPE_MONTHLY || value.FrequencyInterval != 1 || value.TermCount < 1 ||
		!isPersonalFinanceLoanSafeNumber(value.TermCount) || !isPersonalFinanceLoanAmount(value.PrincipalAmount, true) ||
		!isPersonalFinanceLoanAmount(value.ActualDisbursementAmount, true) || !isPersonalFinanceLoanAmount(value.UpfrontFeeAmount, false) ||
		!isPersonalFinanceLoanAmount(value.PerPeriodFeeAmount, false) || !isPersonalFinanceLoanOptionalAmount(value.PaymentBasisAmount, true) ||
		!isPersonalFinanceLoanAmount(value.DiscountAmount, false) || (value.QuotedRatePptr != nil && *value.QuotedRatePptr < 0) ||
		(value.DiscountRatePptr != nil && *value.DiscountRatePptr < 0) {
		return nil, errors.New("loan revision input is invalid")
	}
	for _, date := range []string{value.EffectiveDate, value.ContractDate, value.FirstDueDate} {
		if _, err := calculation.ParseCivilDate(date); err != nil {
			return nil, errors.New("loan revision date is invalid")
		}
	}
	if !isPersonalFinanceLoanFundingType(value.FundingType) || !isPersonalFinanceLoanInputMode(value.InputMode) ||
		!isPersonalFinanceLoanRepaymentMethod(value.RepaymentMethod) || !isPersonalFinanceLoanRateQuoteType(value.RateQuoteType) ||
		!isPersonalFinanceLoanDiscountType(value.DiscountType) {
		return nil, errors.New("loan revision stable code is invalid")
	}
	if value.ActualDisbursementAmount != value.PrincipalAmount-value.UpfrontFeeAmount ||
		(value.InputMode == loans.INPUT_MODE_RATE && (value.RateQuoteType == "" || value.QuotedRatePptr == nil || value.PaymentBasisAmount != nil)) ||
		(value.InputMode == loans.INPUT_MODE_REPAYMENT && (value.RateQuoteType != "" || value.QuotedRatePptr != nil || value.PaymentBasisAmount == nil)) {
		return nil, errors.New("loan revision input mode is inconsistent")
	}
	switch value.DiscountType {
	case loans.DISCOUNT_TYPE_NONE:
		if value.DiscountRatePptr != nil || value.DiscountAmount != 0 {
			return nil, errors.New("loan revision discount is inconsistent")
		}
	case loans.DISCOUNT_TYPE_INTEREST_RATE:
		if value.DiscountRatePptr == nil || value.DiscountAmount != 0 {
			return nil, errors.New("loan revision discount is inconsistent")
		}
	case loans.DISCOUNT_TYPE_PER_PERIOD, loans.DISCOUNT_TYPE_TOTAL:
		if value.DiscountRatePptr != nil || value.DiscountAmount < 1 {
			return nil, errors.New("loan revision discount is inconsistent")
		}
	}
	return &personalFinanceLoanCalculationInputResponse{EffectiveDate: value.EffectiveDate, FundingType: value.FundingType,
		InputMode: value.InputMode, RepaymentMethod: value.RepaymentMethod, RateQuoteType: value.RateQuoteType,
		ContractDate: value.ContractDate, FirstDueDate: value.FirstDueDate, PrincipalAmount: value.PrincipalAmount,
		ActualDisbursementAmount: value.ActualDisbursementAmount, UpfrontFeeAmount: value.UpfrontFeeAmount,
		PerPeriodFeeAmount: value.PerPeriodFeeAmount, TermCount: value.TermCount, QuotedRatePptr: personalFinanceLoanPptrString(value.QuotedRatePptr),
		PaymentBasisAmount: clonePersonalFinanceLoanInt64(value.PaymentBasisAmount), DiscountType: value.DiscountType,
		DiscountRatePptr: personalFinanceLoanPptrString(value.DiscountRatePptr), DiscountAmount: value.DiscountAmount}, nil
}

func newPersonalFinanceLoanRevisionResponse(value *loans.RevisionResult, installments []*loans.InstallmentResult) (*personalFinanceLoanRevisionResponse, error) {
	if value == nil || value.RevisionId < 1 || value.ContractId < 1 || value.RevisionNumber < 1 || !isPersonalFinanceLoanSafeNumber(value.RevisionNumber) ||
		(value.PreviousRevisionId != nil && *value.PreviousRevisionId < 1) || value.CreatedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(value.CreatedUnixTime) ||
		value.CalculationVersion != loans.CALCULATION_VERSION_V1 || value.RoundingVersion != loans.ROUNDING_VERSION_V1 || value.IrrVersion != loans.IRR_VERSION_V1 {
		return nil, errors.New("loan revision result is invalid")
	}
	if (value.RevisionNumber == 1 && value.PreviousRevisionId != nil) || (value.RevisionNumber > 1 && value.PreviousRevisionId == nil) {
		return nil, errors.New("loan revision chain is invalid")
	}
	input, err := newPersonalFinanceLoanRevisionInput(value)
	if err != nil {
		return nil, err
	}
	summary, err := newPersonalFinanceLoanCalculationSummary(value.PreDiscountTotalPaymentAmount, value.PreDiscountTotalCostAmount,
		value.TotalPaymentAmount, value.TotalInterestAmount, value.TotalFeeAmount, value.TotalDiscountAmount, value.TotalCostAmount,
		value.CostRatioPptr, value.IrrStatus, value.MonthlyIrrPptr, value.SimpleAprPptr, value.EffectiveAprPptr)
	if err != nil {
		return nil, err
	}
	rows := make([]*personalFinanceLoanCalculatedInstallmentResponse, 0, len(installments))
	for index, installment := range installments {
		if installment == nil || installment.InstallmentId < 1 {
			return nil, errors.New("loan revision installment is invalid")
		}
		row, err := newPersonalFinanceLoanCalculatedInstallment(calculation.Installment{InstallmentNumber: installment.InstallmentNumber,
			DueDate: installment.DueDate, BeginningPrincipalAmount: installment.BeginningPrincipalAmount, PrincipalAmount: installment.PrincipalAmount,
			InterestAmount: installment.InterestAmount, FeeAmount: installment.FeeAmount, DiscountAmount: installment.DiscountAmount,
			PaymentAmount: installment.PaymentAmount, EndingPrincipalAmount: installment.EndingPrincipalAmount,
			PreDiscountInterestAmount: installment.PreDiscountInterestAmount, PreDiscountFeeAmount: installment.PreDiscountFeeAmount,
			PreDiscountPaymentAmount: installment.PreDiscountPaymentAmount})
		if err != nil || row.InstallmentNumber != int64(index+1) {
			return nil, errors.New("loan revision installment order is invalid")
		}
		rows = append(rows, row)
	}
	if int64(len(rows)) != value.TermCount {
		return nil, errors.New("loan revision installment count is invalid")
	}
	return &personalFinanceLoanRevisionResponse{Id: value.RevisionId, RevisionNumber: value.RevisionNumber,
		PreviousRevisionId: clonePersonalFinanceLoanInt64(value.PreviousRevisionId), EffectiveDate: value.EffectiveDate, Input: input,
		Calculation: &personalFinanceLoanCalculationResponse{CalculationVersion: string(value.CalculationVersion), RoundingVersion: string(value.RoundingVersion),
			IrrVersion: string(value.IrrVersion), Summary: summary, Installments: rows}, CreatedUnixTime: value.CreatedUnixTime}, nil
}

func newPersonalFinanceLoanPageResponse(value *loans.ContractListResult, status loans.ContractStatus) (*personalFinanceLoanPageResponse, error) {
	if value == nil {
		return nil, errors.New("loan contract page is required")
	}
	response := &personalFinanceLoanPageResponse{Items: make([]*personalFinanceLoanContractSummaryResponse, 0, len(value.Items))}
	seen := make(map[int64]struct{}, len(value.Items))
	for _, item := range value.Items {
		if item == nil || item.Contract == nil || item.CurrentRevision == nil || item.Contract.Status != status ||
			item.CurrentRevision.ContractId != item.Contract.ContractId || item.CurrentRevision.RevisionId != item.Contract.CurrentRevisionId ||
			item.CurrentRevision.TermCount != item.Progress.InstallmentCount || item.CurrentRevision.CalculationVersion != loans.CALCULATION_VERSION_V1 ||
			item.CurrentRevision.RoundingVersion != loans.ROUNDING_VERSION_V1 || item.CurrentRevision.IrrVersion != loans.IRR_VERSION_V1 {
			return nil, errors.New("loan contract summary is invalid")
		}
		if _, err := newPersonalFinanceLoanRevisionInput(item.CurrentRevision); err != nil {
			return nil, err
		}
		if _, duplicate := seen[item.Contract.ContractId]; duplicate {
			return nil, errors.New("loan contract summary is duplicated")
		}
		seen[item.Contract.ContractId] = struct{}{}
		contract, err := newPersonalFinanceLoanContractResponse(item.Contract)
		if err != nil {
			return nil, err
		}
		calculationSummary, err := newPersonalFinanceLoanCalculationSummary(item.CurrentRevision.PreDiscountTotalPaymentAmount,
			item.CurrentRevision.PreDiscountTotalCostAmount, item.CurrentRevision.TotalPaymentAmount, item.CurrentRevision.TotalInterestAmount,
			item.CurrentRevision.TotalFeeAmount, item.CurrentRevision.TotalDiscountAmount, item.CurrentRevision.TotalCostAmount,
			item.CurrentRevision.CostRatioPptr, item.CurrentRevision.IrrStatus, item.CurrentRevision.MonthlyIrrPptr,
			item.CurrentRevision.SimpleAprPptr, item.CurrentRevision.EffectiveAprPptr)
		if err != nil || !isPersonalFinanceLoanProgress(item.Progress) {
			return nil, errors.New("loan contract progress is invalid")
		}
		response.Items = append(response.Items, &personalFinanceLoanContractSummaryResponse{Contract: contract, Calculation: calculationSummary,
			PaidInstallmentCount: item.Progress.PaidInstallmentCount, PartialInstallmentCount: item.Progress.PartialInstallmentCount,
			TotalInstallmentCount: item.Progress.InstallmentCount, OutstandingPrincipalAmount: item.Progress.OutstandingPrincipal,
			OutstandingPaymentAmount: item.Progress.OutstandingPayment, ReasonCodes: []*personalFinanceLoanReasonResponse{}})
	}
	if value.NextCursor != nil {
		if value.NextCursor.ContractId < 1 || value.NextCursor.UpdatedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(value.NextCursor.UpdatedUnixTime) {
			return nil, errors.New("loan contract cursor is invalid")
		}
		response.NextCursor = &personalFinanceLoanCursorResponse{Status: status, UpdatedUnixTime: value.NextCursor.UpdatedUnixTime, ContractId: value.NextCursor.ContractId}
	}
	return response, nil
}

func newPersonalFinanceLoanContractDetailResponse(value *loans.ContractDetail, asOfDate string) (*personalFinanceLoanContractDetailResponse, error) {
	if value == nil || value.Contract == nil || value.CurrentRevision == nil || value.Contract.ContractId != value.CurrentRevision.ContractId ||
		value.LedgerOutstandingAmount == nil || value.LedgerPlanDifferenceAmount == nil {
		return nil, errors.New("loan contract detail is incomplete")
	}
	if _, err := calculation.ParseCivilDate(asOfDate); err != nil {
		return nil, errors.New("loan contract as-of date is invalid")
	}
	contract, err := newPersonalFinanceLoanContractResponse(value.Contract)
	if err != nil {
		return nil, err
	}
	revision, err := newPersonalFinanceLoanRevisionResponse(value.CurrentRevision, value.Installments)
	if err != nil || len(value.Installments) != len(value.InstallmentProgress) {
		return nil, errors.New("loan contract plan is invalid")
	}
	progressById := make(map[int64]*loans.InstallmentProgress, len(value.InstallmentProgress))
	for _, progress := range value.InstallmentProgress {
		if progress == nil || progress.InstallmentId < 1 || !isPersonalFinanceLoanInstallmentProgress(progress) || progressById[progress.InstallmentId] != nil {
			return nil, errors.New("loan installment progress is invalid")
		}
		progressById[progress.InstallmentId] = progress
	}
	installments := make([]*personalFinanceLoanInstallmentResponse, 0, len(value.Installments))
	allocatedPrincipal, allocatedInterest, allocatedFee, allocationCount := int64(0), int64(0), int64(0), int64(0)
	for index, item := range value.Installments {
		progress := progressById[item.InstallmentId]
		if progress == nil || progress.InstallmentNumber != item.InstallmentNumber || progress.DueDate != item.DueDate {
			return nil, errors.New("loan installment progress does not match plan")
		}
		if progress.Components.PlannedPrincipalAmount != item.PrincipalAmount || progress.Components.PlannedInterestAmount != item.InterestAmount ||
			progress.Components.PlannedFeeAmount != item.FeeAmount || progress.Components.AllocatedPrincipalAmount > item.PrincipalAmount ||
			progress.Components.AllocatedInterestAmount > item.InterestAmount || progress.Components.AllocatedFeeAmount > item.FeeAmount ||
			progress.Components.OutstandingPrincipal != item.PrincipalAmount-progress.Components.AllocatedPrincipalAmount ||
			progress.Components.OutstandingInterest != item.InterestAmount-progress.Components.AllocatedInterestAmount ||
			progress.Components.OutstandingFee != item.FeeAmount-progress.Components.AllocatedFeeAmount {
			return nil, errors.New("loan installment progress components are inconsistent")
		}
		allocatedPrincipal += progress.Components.AllocatedPrincipalAmount
		allocatedInterest += progress.Components.AllocatedInterestAmount
		allocatedFee += progress.Components.AllocatedFeeAmount
		allocationCount += progress.AllocationCount
		installments = append(installments, &personalFinanceLoanInstallmentResponse{personalFinanceLoanCalculatedInstallmentResponse: revision.Calculation.Installments[index],
			Id: item.InstallmentId, RevisionId: value.CurrentRevision.RevisionId, Progress: &personalFinanceLoanInstallmentProgressResponse{
				SettlementStatus: progress.Status, Overdue: progress.Overdue, AllocatedPrincipalAmount: progress.Components.AllocatedPrincipalAmount,
				AllocatedInterestAmount: progress.Components.AllocatedInterestAmount, AllocatedFeeAmount: progress.Components.AllocatedFeeAmount,
				OutstandingPrincipalAmount: progress.Components.OutstandingPrincipal, OutstandingInterestAmount: progress.Components.OutstandingInterest,
				OutstandingFeeAmount: progress.Components.OutstandingFee, OutstandingPaymentAmount: progress.OutstandingPayment,
				ReasonCodes: []*personalFinanceLoanReasonResponse{}}})
	}
	allocations, err := newPersonalFinanceLoanAllocationSummary(value.ActiveAllocationAggregates)
	if err != nil || !isPersonalFinanceLoanProgress(value.Progress) || !isPersonalFinanceLoanAmount(value.Remaining.PrincipalAmount, false) ||
		!isPersonalFinanceLoanAmount(value.Remaining.PaymentAmount, false) || !isPersonalFinanceLoanAmount(value.Remaining.InterestAmount, false) ||
		!isPersonalFinanceLoanAmount(value.Remaining.FeeAmount, false) || value.Remaining.PaymentAmount != value.Progress.OutstandingPayment ||
		value.Remaining.PrincipalAmount != value.Progress.OutstandingPrincipal || value.Remaining.InterestAmount != value.Progress.OutstandingInterest ||
		value.Remaining.FeeAmount != value.Progress.OutstandingFee || allocatedPrincipal != allocations.AllocatedPrincipalAmount ||
		allocatedInterest != allocations.AllocatedInterestAmount || allocatedFee != allocations.AllocatedFeeAmount || allocationCount > allocations.ActiveAllocationCount ||
		!isPersonalFinanceLoanAmount(*value.LedgerOutstandingAmount, false) || !isPersonalFinanceLoanSafeSignedNumber(*value.LedgerPlanDifferenceAmount) ||
		*value.LedgerPlanDifferenceAmount != *value.LedgerOutstandingAmount-value.Remaining.PrincipalAmount {
		return nil, errors.New("loan liability comparison is invalid")
	}
	return &personalFinanceLoanContractDetailResponse{Contract: contract, CurrentRevision: revision, Installments: installments, Allocations: allocations,
		LiabilityComparison: &personalFinanceLoanLiabilityComparisonResponse{PlannedOutstandingPrincipalAmount: value.Remaining.PrincipalAmount,
			LedgerOutstandingLiabilityAmount: *value.LedgerOutstandingAmount, DifferenceAmount: *value.LedgerPlanDifferenceAmount,
			ActionRequired: *value.LedgerPlanDifferenceAmount != 0, ReasonCodes: []*personalFinanceLoanReasonResponse{}}, AsOfDate: asOfDate}, nil
}

func newPersonalFinanceLoanAllocationSummary(values []*loans.AllocationAggregate) (*personalFinanceLoanAllocationSummaryResponse, error) {
	response := new(personalFinanceLoanAllocationSummaryResponse)
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == nil || value.AllocationCount < 1 || !isPersonalFinanceLoanSafeNumber(value.AllocationCount) || !isPersonalFinanceLoanAmount(value.AllocatedAmount, true) {
			return nil, errors.New("loan allocation aggregate is invalid")
		}
		installmentId := int64(0)
		if value.InstallmentId != nil {
			installmentId = *value.InstallmentId
		}
		key := fmt.Sprintf("%d:%s", installmentId, value.ComponentType)
		if _, duplicate := seen[key]; duplicate {
			return nil, errors.New("loan allocation aggregate is duplicated")
		}
		seen[key] = struct{}{}
		if response.ActiveAllocationCount > maximumJavaScriptSafeInteger-value.AllocationCount {
			return nil, errors.New("loan allocation count overflows")
		}
		response.ActiveAllocationCount += value.AllocationCount
		target := &response.AllocatedDisbursementAmount
		switch value.ComponentType {
		case loans.COMPONENT_TYPE_DISBURSEMENT:
			if value.InstallmentId != nil {
				return nil, errors.New("loan disbursement allocation has installment")
			}
		case loans.COMPONENT_TYPE_PRINCIPAL:
			target = &response.AllocatedPrincipalAmount
		case loans.COMPONENT_TYPE_INTEREST:
			target = &response.AllocatedInterestAmount
		case loans.COMPONENT_TYPE_FEE:
			target = &response.AllocatedFeeAmount
		default:
			return nil, errors.New("loan allocation component is invalid")
		}
		if value.ComponentType != loans.COMPONENT_TYPE_DISBURSEMENT && (value.InstallmentId == nil || *value.InstallmentId < 1) ||
			*target > models.MaximumTransactionAmount-value.AllocatedAmount {
			return nil, errors.New("loan allocation aggregate is inconsistent")
		}
		*target += value.AllocatedAmount
	}
	return response, nil
}

func newPersonalFinanceLoanActionResponse(value *loans.CommandResult) (*personalFinanceLoanActionResponse, error) {
	if value == nil || value.Action == nil {
		return nil, errors.New("loan action result is required")
	}
	action := value.Action
	if action.ActionId < 1 || action.ContractId < 1 || action.ExpectedContractVersion < 0 || action.AppliedContractVersion < 0 ||
		!isPersonalFinanceLoanSafeNumber(action.ExpectedContractVersion) || !isPersonalFinanceLoanSafeNumber(action.AppliedContractVersion) ||
		!isPersonalFinanceLoanActionType(action.ActionType) || !isPersonalFinanceLoanActionStatus(action.Status) || action.CreatedUnixTime < 1 ||
		!isPersonalFinanceLoanSafeNumber(action.CreatedUnixTime) || action.UpdatedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(action.UpdatedUnixTime) ||
		!isPersonalFinanceLoanOptionalTime(action.StartedUnixTime) || !isPersonalFinanceLoanOptionalTime(action.CompletedUnixTime) || !isPersonalFinanceLoanOptionalTime(action.FailedUnixTime) {
		return nil, errors.New("loan action result is invalid")
	}
	if (action.ActionType == loans.ACTION_TYPE_CREATE_CONTRACT && action.ExpectedContractVersion != 0) ||
		(action.ActionType != loans.ACTION_TYPE_CREATE_CONTRACT && action.ExpectedContractVersion < 1) ||
		action.Status == loans.ACTION_STATUS_READY || action.Status == loans.ACTION_STATUS_APPLYING ||
		action.StartedUnixTime == nil || (action.Status != loans.ACTION_STATUS_FAILED && action.CompletedUnixTime == nil) {
		return nil, errors.New("loan action terminal state is invalid")
	}
	seen := make(map[loans.ServiceErrorCode]struct{}, len(action.ReasonCodes))
	reasons := make([]*personalFinanceLoanReasonResponse, 0, len(action.ReasonCodes))
	for _, code := range action.ReasonCodes {
		if !isPersonalFinanceLoanServiceCode(code) {
			return nil, errors.New("loan action reason is not stable")
		}
		if _, duplicate := seen[code]; duplicate {
			return nil, errors.New("loan action reason is duplicated")
		}
		seen[code] = struct{}{}
		reasons = append(reasons, &personalFinanceLoanReasonResponse{Code: string(code)})
	}
	if action.ErrorCode != "" && !isPersonalFinanceLoanServiceCode(action.ErrorCode) {
		return nil, errors.New("loan action error is not stable")
	}
	switch action.Status {
	case loans.ACTION_STATUS_APPLIED:
		if action.AppliedContractVersion != action.ExpectedContractVersion+1 || len(reasons) != 0 || action.ErrorCode != "" || action.FailedUnixTime != nil {
			return nil, errors.New("applied loan action contains an error")
		}
	case loans.ACTION_STATUS_ACTION_REQUIRED:
		if action.AppliedContractVersion != 0 || len(reasons) == 0 || action.ErrorCode == "" || action.FailedUnixTime != nil {
			return nil, errors.New("action-required loan action is incomplete")
		}
	case loans.ACTION_STATUS_FAILED:
		if action.AppliedContractVersion != 0 || len(reasons) == 0 || action.ErrorCode == "" || action.FailedUnixTime == nil || action.CompletedUnixTime != nil {
			return nil, errors.New("failed loan action is incomplete")
		}
	}
	return &personalFinanceLoanActionResponse{ActionId: action.ActionId, Status: action.Status, Allocations: []any{}, Replayed: value.Replayed,
		ReasonCodes: reasons}, nil
}

func isPersonalFinanceLoanProgress(value loans.PlanProgress) bool {
	counts := []int64{value.InstallmentCount, value.UnpaidInstallmentCount, value.PartialInstallmentCount, value.PaidInstallmentCount, value.OverdueInstallmentCount}
	for _, count := range counts {
		if !isPersonalFinanceLoanSafeNumber(count) {
			return false
		}
	}
	for _, amount := range []int64{value.AllocatedPaymentAmount, value.OutstandingPayment, value.OutstandingPrincipal, value.OutstandingInterest, value.OutstandingFee} {
		if !isPersonalFinanceLoanAmount(amount, false) {
			return false
		}
	}
	if value.UnpaidInstallmentCount+value.PartialInstallmentCount+value.PaidInstallmentCount != value.InstallmentCount || value.OverdueInstallmentCount > value.InstallmentCount {
		return false
	}
	if (value.OutstandingPayment == 0) != (value.NextDueDate == nil) {
		return false
	}
	return value.NextDueDate == nil || func() bool { _, err := calculation.ParseCivilDate(*value.NextDueDate); return err == nil }()
}

func isPersonalFinanceLoanInstallmentProgress(value *loans.InstallmentProgress) bool {
	if value == nil || value.InstallmentNumber < 1 || !isPersonalFinanceLoanSafeNumber(value.InstallmentNumber) || value.AllocationCount < 0 ||
		!isPersonalFinanceLoanSafeNumber(value.AllocationCount) || !isPersonalFinanceLoanInstallmentStatus(value.Status) {
		return false
	}
	if _, err := calculation.ParseCivilDate(value.DueDate); err != nil {
		return false
	}
	amounts := []int64{value.Components.PlannedPrincipalAmount, value.Components.PlannedInterestAmount, value.Components.PlannedFeeAmount,
		value.Components.AllocatedPrincipalAmount, value.Components.AllocatedInterestAmount, value.Components.AllocatedFeeAmount,
		value.Components.OutstandingPrincipal, value.Components.OutstandingInterest, value.Components.OutstandingFee, value.OutstandingPayment}
	for _, amount := range amounts {
		if !isPersonalFinanceLoanAmount(amount, false) {
			return false
		}
	}
	return value.Components.OutstandingPrincipal+value.Components.OutstandingInterest+value.Components.OutstandingFee == value.OutstandingPayment
}

func isPersonalFinanceLoanOptionalTime(value *int64) bool {
	return value == nil || (*value > 0 && isPersonalFinanceLoanSafeNumber(*value))
}

func isPersonalFinanceLoanContractType(value loans.ContractType) bool {
	return value == loans.CONTRACT_TYPE_CREDIT_CARD_INSTALLMENT || value == loans.CONTRACT_TYPE_BANK_LOAN ||
		value == loans.CONTRACT_TYPE_CONSUMER_LOAN || value == loans.CONTRACT_TYPE_PERSONAL_LOAN
}

func isPersonalFinanceLoanFundingType(value loans.FundingType) bool {
	return value == loans.FUNDING_TYPE_CASH_DISBURSEMENT || value == loans.FUNDING_TYPE_PURCHASE_INSTALLMENT
}

func isPersonalFinanceLoanInputMode(value loans.InputMode) bool {
	return value == loans.INPUT_MODE_RATE || value == loans.INPUT_MODE_REPAYMENT
}

func isPersonalFinanceLoanRepaymentMethod(value loans.RepaymentMethod) bool {
	return value == loans.REPAYMENT_METHOD_FLAT || value == loans.REPAYMENT_METHOD_EQUAL_PAYMENT ||
		value == loans.REPAYMENT_METHOD_EQUAL_PRINCIPAL || value == loans.REPAYMENT_METHOD_INTEREST_ONLY
}

func isPersonalFinanceLoanRateQuoteType(value loans.RateQuoteType) bool {
	return value == loans.RATE_QUOTE_TYPE_ANNUAL || value == loans.RATE_QUOTE_TYPE_MONTHLY ||
		value == loans.RATE_QUOTE_TYPE_DAILY || value == loans.RATE_QUOTE_TYPE_INSTALLMENT || value == ""
}

func isPersonalFinanceLoanDiscountType(value loans.DiscountType) bool {
	return value == loans.DISCOUNT_TYPE_NONE || value == loans.DISCOUNT_TYPE_INTEREST_RATE ||
		value == loans.DISCOUNT_TYPE_PER_PERIOD || value == loans.DISCOUNT_TYPE_TOTAL
}

func isPersonalFinanceLoanContractStatus(value loans.ContractStatus) bool {
	return value == loans.CONTRACT_STATUS_ACTIVE || value == loans.CONTRACT_STATUS_CLOSED || value == loans.CONTRACT_STATUS_CANCELLED
}

func isPersonalFinanceLoanCurrency(value string) bool {
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

func isPersonalFinanceLoanCloseReason(value loans.CloseReasonCode) bool {
	return value == loans.CLOSE_REASON_PAID_OFF || value == loans.CLOSE_REASON_MANUAL_CLOSE || value == loans.CLOSE_REASON_WRITTEN_OFF
}

func isPersonalFinanceLoanIRRStatus(value loans.IRRStatus) bool {
	return value == loans.IRR_STATUS_SOLVED || value == loans.IRR_STATUS_SOLVED_ZERO || value == loans.IRR_STATUS_NO_NONNEGATIVE_ROOT ||
		value == loans.IRR_STATUS_INSUFFICIENT_CASHFLOWS || value == loans.IRR_STATUS_OUT_OF_RANGE
}

func isPersonalFinanceLoanInstallmentStatus(value loans.InstallmentProgressStatus) bool {
	return value == loans.INSTALLMENT_PROGRESS_UNPAID || value == loans.INSTALLMENT_PROGRESS_PARTIAL || value == loans.INSTALLMENT_PROGRESS_PAID
}

func isPersonalFinanceLoanActionType(value loans.ActionType) bool {
	return value == loans.ACTION_TYPE_CREATE_CONTRACT || value == loans.ACTION_TYPE_REVISE_CONTRACT || value == loans.ACTION_TYPE_CLOSE_CONTRACT ||
		value == loans.ACTION_TYPE_REOPEN_CONTRACT || value == loans.ACTION_TYPE_CANCEL_CONTRACT
}

func isPersonalFinanceLoanActionStatus(value loans.ActionStatus) bool {
	return value == loans.ACTION_STATUS_READY || value == loans.ACTION_STATUS_APPLYING || value == loans.ACTION_STATUS_APPLIED ||
		value == loans.ACTION_STATUS_ACTION_REQUIRED || value == loans.ACTION_STATUS_FAILED
}

func isPersonalFinanceLoanServiceCode(value loans.ServiceErrorCode) bool {
	switch value {
	case loans.SERVICE_ERROR_INVALID_REQUEST, loans.SERVICE_ERROR_ACCOUNT_NOT_FOUND, loans.SERVICE_ERROR_ACCOUNT_OWNER,
		loans.SERVICE_ERROR_ACCOUNT_DELETED, loans.SERVICE_ERROR_ACCOUNT_NOT_SINGLE, loans.SERVICE_ERROR_ACCOUNT_HIDDEN,
		loans.SERVICE_ERROR_LIABILITY_REQUIRED, loans.SERVICE_ERROR_ASSET_REQUIRED, loans.SERVICE_ERROR_ACCOUNT_CURRENCY,
		loans.SERVICE_ERROR_CONTRACT_NOT_FOUND, loans.SERVICE_ERROR_IDEMPOTENCY_CONFLICT, loans.SERVICE_ERROR_VERSION_CONFLICT,
		loans.SERVICE_ERROR_STATE_CONFLICT, loans.SERVICE_ERROR_ACTIVE_ALLOCATION, loans.SERVICE_ERROR_ALLOCATION_HISTORY,
		loans.SERVICE_ERROR_PLAN_NOT_PAID_OFF, loans.SERVICE_ERROR_COMMAND_UNAVAILABLE, loans.SERVICE_ERROR_PERSISTENCE,
		loans.SERVICE_ERROR_INVARIANT:
		return true
	default:
		return false
	}
}

func personalFinanceLoanServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, loans.ErrServiceInvalidRequest), errors.Is(err, loans.ErrServiceAccountRejected), errors.Is(err, loans.ErrServiceContractNotFound):
		return errs.ErrParameterInvalid
	case errors.Is(err, loans.ErrServiceIdempotencyConflict), errors.Is(err, loans.ErrServiceVersionConflict),
		errors.Is(err, loans.ErrServiceStateConflict), errors.Is(err, loans.ErrServiceActiveAllocation),
		errors.Is(err, loans.ErrServiceAllocationHistory), errors.Is(err, loans.ErrServicePlanNotPaidOff),
		errors.Is(err, loans.ErrServiceCommandUnavailable):
		return errs.ErrRepeatedRequest
	default:
		return errs.ErrOperationFailed
	}
}
