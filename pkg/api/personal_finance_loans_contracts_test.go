package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans/calculation"
)

func TestLoanCalculateHandlerPreservesEffectiveDateAndPptrStrings(t *testing.T) {
	stub := &loanContractsAPITestApplication{calculation: validLoanCalculationResult()}
	api := newLoanContractsTestAPI(t, stub)
	response, apiErr := api.LoanCalculateHandler(newLoanContractsTestContext(t, http.MethodPost, "/calculate", validLoanCalculationJSON()))
	if apiErr != nil {
		t.Fatalf("calculate loan: %v", apiErr)
	}
	if stub.calculateRequest.Terms.EffectiveDate != "2026-01-03" || stub.calculateRequest.Terms.ContractDate != "2026-01-01" ||
		stub.calculateRequest.Terms.QuotedRatePptr == nil || *stub.calculateRequest.Terms.QuotedRatePptr != 120000000000 {
		t.Fatalf("unexpected calculation terms: %+v", stub.calculateRequest.Terms)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"costRatioPptr":"110000000000"`, `"monthlyIrrPptr":"10000000000"`, `"installments":[{`, `"effectiveAprPptr":"126825030132"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("calculation response omitted %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "scheduleDigest", "uid", "idempotency", "private-note")
}

func TestLoanCalculationHandlerKeepsNullableRatesAndRejectsAmbiguousPptr(t *testing.T) {
	stub := &loanContractsAPITestApplication{calculation: validLoanCalculationResult()}
	api := newLoanContractsTestAPI(t, stub)
	body := strings.ReplaceAll(validLoanCalculationJSON(), `"inputMode":"rate"`, `"inputMode":"repayment"`)
	body = strings.ReplaceAll(body, `"rateQuoteType":"annual"`, `"rateQuoteType":""`)
	body = strings.ReplaceAll(body, `"quotedRatePptr":"120000000000",`, `"quotedRatePptr":null,"paymentBasisAmount":1110,`)
	response, apiErr := api.LoanCalculateHandler(newLoanContractsTestContext(t, http.MethodPost, "/calculate", body))
	if apiErr != nil {
		t.Fatalf("nullable quoted rate was rejected: %v", apiErr)
	}
	if stub.calculateRequest.Terms.QuotedRatePptr != nil || stub.calculateRequest.Terms.PaymentBasisAmount == nil {
		t.Fatalf("nullable rate semantics were not preserved: %+v", stub.calculateRequest.Terms)
	}
	stub.calculation.IRR = calculation.IRRResult{Status: calculation.IRRStatusNoNonnegativeRoot}
	response, apiErr = api.LoanCalculateHandler(newLoanContractsTestContext(t, http.MethodPost, "/calculate", body))
	if apiErr != nil {
		t.Fatalf("nullable IRR result was rejected: %v", apiErr)
	}
	text := marshalLoanContractsResponse(t, response)
	assertLoanContractsResponseOmits(t, text, "monthlyIrrPptr", "simpleAprPptr", "effectiveAprPptr")

	for _, invalid := range []string{`+1`, `-1`, ` 1`, `1 `, `1e3`, `1.0`, `9223372036854775808`} {
		t.Run(invalid, func(t *testing.T) {
			invalidBody := strings.Replace(validLoanCalculationJSON(), `"120000000000"`, `"`+invalid+`"`, 1)
			response, apiErr := api.LoanCalculateHandler(newLoanContractsTestContext(t, http.MethodPost, "/calculate", invalidBody))
			if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() {
				t.Fatalf("ambiguous pptr was accepted: response=%v error=%v", response, apiErr)
			}
		})
	}
}

func TestLoanContractCreateHandlerInjectsUidAndReturnsSafeAction(t *testing.T) {
	stub := &loanContractsAPITestApplication{command: validLoanCommandResult(loans.ACTION_TYPE_CREATE_CONTRACT)}
	api := newLoanContractsTestAPI(t, stub)
	body := `{"contract":{"name":"Private loan","lenderName":"Private lender","contractType":"bank_loan","liabilityAccountId":"701","defaultPaymentAccountId":"702","currency":"CNY","note":"private-note"},"calculation":` + validLoanCalculationJSON() + `,"idempotencyKey":"create-key-001"}`
	response, apiErr := api.LoanContractCreateHandler(newLoanContractsTestContext(t, http.MethodPost, "/create", body))
	if apiErr != nil {
		t.Fatalf("create loan contract: %v", apiErr)
	}
	request := stub.createRequest
	if request.Uid != 1001 || request.Spec.LiabilityAccountId != 701 || request.Spec.DefaultPaymentAccountId == nil || *request.Spec.DefaultPaymentAccountId != 702 ||
		request.Spec.Terms.EffectiveDate != "2026-01-03" || request.IdempotencyKey != "create-key-001" {
		t.Fatalf("unexpected create request: %+v", request)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"actionId":"9001"`, `"status":"applied"`, `"allocations":[]`, `"reasonCodes":[]`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("action response omitted %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "errorCode", "create-key-001", "private-note", "Private lender", "uid", "digest")
}

func TestLoanContractHandlersRejectClientOwnedIdentityAndUidFields(t *testing.T) {
	stub := &loanContractsAPITestApplication{detail: validLoanContractDetail(), command: validLoanCommandResult(loans.ACTION_TYPE_CREATE_CONTRACT)}
	api := newLoanContractsTestAPI(t, stub)
	validCreate := `{"contract":{"name":"Private loan","lenderName":"Private lender","contractType":"bank_loan","liabilityAccountId":"701","currency":"CNY","note":""},"calculation":` + validLoanCalculationJSON() + `,"idempotencyKey":"create-key-001"}`
	invalidBodies := []struct {
		invoke func(*core.WebContext) (any, *errs.Error)
		body   string
	}{
		{invoke: api.LoanContractCreateHandler, body: strings.Replace(validCreate, `{`, `{"uid":"999",`, 1)},
		{invoke: api.LoanContractCreateHandler, body: strings.Replace(validCreate, `"701"`, `701`, 1)},
		{invoke: api.LoanContractReviseHandler, body: `{"contractId":"5001","expectedContractVersion":3,"name":"client override","calculation":` + validLoanCalculationJSON() + `,"idempotencyKey":"revise-key-001"}`},
	}
	for index, test := range invalidBodies {
		response, apiErr := test.invoke(newLoanContractsTestContext(t, http.MethodPost, "/invalid", test.body))
		if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() {
			t.Fatalf("invalid client-owned field %d accepted: response=%v error=%v", index, response, apiErr)
		}
	}
	if stub.createRequest.Uid != 0 || stub.reviseCalls != 0 {
		t.Fatalf("invalid identity request reached application: create=%+v reviseCalls=%d", stub.createRequest, stub.reviseCalls)
	}
}

func TestLoanContractReviseHandlerReusesServerIdentityAtExpectedVersion(t *testing.T) {
	stub := &loanContractsAPITestApplication{detail: validLoanContractDetail(), command: validLoanCommandResult(loans.ACTION_TYPE_REVISE_CONTRACT)}
	api := newLoanContractsTestAPI(t, stub)
	body := `{"contractId":"5001","expectedContractVersion":3,"calculation":` + validLoanCalculationJSON() + `,"idempotencyKey":"revise-key-001"}`
	response, apiErr := api.LoanContractReviseHandler(newLoanContractsTestContext(t, http.MethodPost, "/revise", body))
	if apiErr != nil || response == nil {
		t.Fatalf("revise loan contract: response=%v error=%v", response, apiErr)
	}
	request := stub.reviseRequest
	if stub.getUid != 1001 || stub.getContractId != 5001 || request.Uid != 1001 || request.ContractId != 5001 || request.ExpectedContractVersion != 3 ||
		request.Spec.Name != "Server contract" || request.Spec.LenderName != "Server lender" || request.Spec.LiabilityAccountId != 701 || request.Spec.Note != "server-note" ||
		request.Spec.Terms.EffectiveDate != "2026-01-03" {
		t.Fatalf("revision did not reuse server identity: get=%d/%d request=%+v", stub.getUid, stub.getContractId, request)
	}

	stub.detail.Contract.Version = 4
	stub.reviseCalls = 0
	response, apiErr = api.LoanContractReviseHandler(newLoanContractsTestContext(t, http.MethodPost, "/revise", body))
	if response != nil || apiErr != errs.ErrRepeatedRequest || stub.reviseCalls != 0 {
		t.Fatalf("stale revision reached domain command: response=%v error=%v calls=%d", response, apiErr, stub.reviseCalls)
	}
}

func TestLoanContractListHandlerUsesStableCursorAndClientCivilDate(t *testing.T) {
	stub := &loanContractsAPITestApplication{page: &loans.ContractListResult{Items: []*loans.ContractSummary{{
		Contract: validLoanContract(), CurrentRevision: validLoanRevision(), Progress: validLoanPlanProgress(),
	}}, NextCursor: &loans.ContractCursor{UpdatedUnixTime: 2000, ContractId: 5000}}}
	api := newLoanContractsTestAPI(t, stub)
	api.now = func() time.Time { return time.Date(2026, 1, 1, 17, 30, 0, 0, time.UTC) }
	response, apiErr := api.LoanContractListHandler(newLoanContractsTestContext(t, http.MethodGet,
		"/list?status=active&cursor_updated_unix_time=3000&cursor_contract_id=6000&limit=25", ""))
	if apiErr != nil {
		t.Fatalf("list loan contracts: %v", apiErr)
	}
	if stub.listUid != 1001 || stub.listStatus != loans.CONTRACT_STATUS_ACTIVE || stub.listLimit != 25 || stub.listAsOfDate != "2026-01-02" ||
		stub.listCursor == nil || stub.listCursor.UpdatedUnixTime != 3000 || stub.listCursor.ContractId != 6000 {
		t.Fatalf("unexpected list request: uid=%d status=%s cursor=%+v limit=%d asOf=%s", stub.listUid, stub.listStatus, stub.listCursor, stub.listLimit, stub.listAsOfDate)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"id":"5001"`, `"liabilityAccountId":"701"`, `"currentRevisionId":"6001"`, `"contractId":"5000"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("loan page omitted %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "closeReason", "scheduleDigest", "uid")

	contextWithoutTimezone := newLoanContractsTestContext(t, http.MethodGet, "/list?status=active", "")
	contextWithoutTimezone.Request.Header.Del(core.ClientTimezoneOffsetHeaderName)
	if response, apiErr = api.LoanContractListHandler(contextWithoutTimezone); response != nil || apiErr != errs.ErrClientTimezoneOffsetInvalid {
		t.Fatalf("list without timezone was accepted: response=%v error=%v", response, apiErr)
	}
}

func TestLoanContractGetHandlerReturnsDetailShapeAndStringIds(t *testing.T) {
	stub := &loanContractsAPITestApplication{detail: validLoanContractDetail()}
	api := newLoanContractsTestAPI(t, stub)
	api.now = func() time.Time { return time.Date(2026, 1, 2, 1, 0, 0, 0, time.UTC) }
	response, apiErr := api.LoanContractGetHandler(newLoanContractsTestContext(t, http.MethodGet, "/get?contract_id=5001", ""))
	if apiErr != nil {
		t.Fatalf("get loan contract: %v", apiErr)
	}
	if stub.getUid != 1001 || stub.getContractId != 5001 || stub.getAsOfDate != "2026-01-02" {
		t.Fatalf("unexpected get request: uid=%d contract=%d asOf=%s", stub.getUid, stub.getContractId, stub.getAsOfDate)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"id":"7001"`, `"revisionId":"6001"`, `"asOfDate":"2026-01-02"`, `"quotedRatePptr":"120000000000"`, `"discountRatePptr"`} {
		if strings.Contains(text, expected) != (expected != `"discountRatePptr"`) {
			t.Fatalf("unexpected nullable/detail field %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "scheduleDigest", "actionId", "uid", "transaction", "comment", "errorCode")
}

func TestLoanLifecycleHandlersInjectUidAndKeepEmptyAllocations(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		actionType loans.ActionType
		invoke     func(*PersonalFinanceLoansContractsApi, *core.WebContext) (any, *errs.Error)
	}{
		{name: "close", body: `{"contractId":"5001","expectedContractVersion":3,"closeReason":"manual_close","idempotencyKey":"close-key-001"}`,
			actionType: loans.ACTION_TYPE_CLOSE_CONTRACT, invoke: func(api *PersonalFinanceLoansContractsApi, c *core.WebContext) (any, *errs.Error) {
				return api.LoanContractCloseHandler(c)
			}},
		{name: "reopen", body: `{"contractId":"5001","expectedContractVersion":3,"idempotencyKey":"reopen-key-001"}`,
			actionType: loans.ACTION_TYPE_REOPEN_CONTRACT, invoke: func(api *PersonalFinanceLoansContractsApi, c *core.WebContext) (any, *errs.Error) {
				return api.LoanContractReopenHandler(c)
			}},
		{name: "cancel", body: `{"contractId":"5001","expectedContractVersion":3,"idempotencyKey":"cancel-key-001"}`,
			actionType: loans.ACTION_TYPE_CANCEL_CONTRACT, invoke: func(api *PersonalFinanceLoansContractsApi, c *core.WebContext) (any, *errs.Error) {
				return api.LoanContractCancelHandler(c)
			}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stub := &loanContractsAPITestApplication{command: validLoanCommandResult(test.actionType)}
			api := newLoanContractsTestAPI(t, stub)
			response, apiErr := test.invoke(api, newLoanContractsTestContext(t, http.MethodPost, "/"+test.name, test.body))
			if apiErr != nil {
				t.Fatalf("%s loan contract: %v", test.name, apiErr)
			}
			if stub.lastLifecycleUid != 1001 || stub.lastLifecycleContractId != 5001 || stub.lastLifecycleVersion != 3 {
				t.Fatalf("%s did not inject uid: uid=%d contract=%d version=%d", test.name, stub.lastLifecycleUid, stub.lastLifecycleContractId, stub.lastLifecycleVersion)
			}
			text := marshalLoanContractsResponse(t, response)
			if !strings.Contains(text, `"allocations":[]`) || strings.Contains(text, "errorCode") {
				t.Fatalf("unsafe lifecycle action response: %s", text)
			}
		})
	}
}

func TestLoanHandlersMapDomainErrorsAndRejectUnstableActionCodes(t *testing.T) {
	tests := []struct {
		err      error
		expected *errs.Error
	}{
		{err: loans.ErrServiceInvalidRequest, expected: errs.ErrParameterInvalid},
		{err: loans.ErrServiceAccountRejected, expected: errs.ErrParameterInvalid},
		{err: loans.ErrServiceContractNotFound, expected: errs.ErrParameterInvalid},
		{err: loans.ErrServiceIdempotencyConflict, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServiceVersionConflict, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServiceStateConflict, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServiceActiveAllocation, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServiceAllocationHistory, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServicePlanNotPaidOff, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServiceCommandUnavailable, expected: errs.ErrRepeatedRequest},
		{err: loans.ErrServicePersistenceFailed, expected: errs.ErrOperationFailed},
		{err: loans.ErrServiceInvariantViolation, expected: errs.ErrOperationFailed},
	}
	for _, test := range tests {
		if actual := personalFinanceLoanServiceError(test.err); actual != test.expected {
			t.Fatalf("error %v mapped to %v, want %v", test.err, actual, test.expected)
		}
	}

	result := validLoanCommandResult(loans.ACTION_TYPE_CLOSE_CONTRACT)
	result.Action.ReasonCodes = []loans.ServiceErrorCode{loans.SERVICE_ERROR_STATE_CONFLICT, loans.SERVICE_ERROR_STATE_CONFLICT}
	if response, err := newPersonalFinanceLoanActionResponse(result); err == nil || response != nil {
		t.Fatalf("duplicate action reason was accepted: response=%v error=%v", response, err)
	}
	result.Action.ReasonCodes = []loans.ServiceErrorCode{"private_internal_code"}
	if response, err := newPersonalFinanceLoanActionResponse(result); err == nil || response != nil {
		t.Fatalf("unknown action reason was accepted: response=%v error=%v", response, err)
	}
	result.Action.ReasonCodes = nil
	result.Action.ErrorCode = "private_internal_code"
	if response, err := newPersonalFinanceLoanActionResponse(result); err == nil || response != nil {
		t.Fatalf("unknown action error was accepted: response=%v error=%v", response, err)
	}
}

type loanContractsAPITestApplication struct {
	calculation *loans.CalculationResult
	page        *loans.ContractListResult
	detail      *loans.ContractDetail
	command     *loans.CommandResult
	serviceErr  error

	calculateRequest loans.CalculateRequest
	createRequest    loans.CreateContractRequest
	reviseRequest    loans.ReviseContractRequest
	listUid          int64
	listStatus       loans.ContractStatus
	listCursor       *loans.ContractCursor
	listLimit        int
	listAsOfDate     string
	getUid           int64
	getContractId    int64
	getAsOfDate      string
	reviseCalls      int

	lastLifecycleUid        int64
	lastLifecycleContractId int64
	lastLifecycleVersion    int64
}

func (s *loanContractsAPITestApplication) Calculate(request loans.CalculateRequest) (*loans.CalculationResult, error) {
	s.calculateRequest = request
	return s.calculation, s.serviceErr
}

func (s *loanContractsAPITestApplication) ListContracts(_ core.Context, uid int64, status loans.ContractStatus, cursor *loans.ContractCursor, limit int, asOfDate string) (*loans.ContractListResult, error) {
	s.listUid, s.listStatus, s.listCursor, s.listLimit, s.listAsOfDate = uid, status, cursor, limit, asOfDate
	return s.page, s.serviceErr
}

func (s *loanContractsAPITestApplication) GetContract(_ core.Context, uid int64, contractId int64, asOfDate string) (*loans.ContractDetail, error) {
	s.getUid, s.getContractId, s.getAsOfDate = uid, contractId, asOfDate
	return s.detail, s.serviceErr
}

func (s *loanContractsAPITestApplication) CreateContract(_ core.Context, request loans.CreateContractRequest) (*loans.CommandResult, error) {
	s.createRequest = request
	return s.command, s.serviceErr
}

func (s *loanContractsAPITestApplication) ReviseContract(_ core.Context, request loans.ReviseContractRequest) (*loans.CommandResult, error) {
	s.reviseCalls++
	s.reviseRequest = request
	return s.command, s.serviceErr
}

func (s *loanContractsAPITestApplication) CloseContract(_ core.Context, request loans.CloseContractRequest) (*loans.CommandResult, error) {
	s.lastLifecycleUid, s.lastLifecycleContractId, s.lastLifecycleVersion = request.Uid, request.ContractId, request.ExpectedContractVersion
	return s.command, s.serviceErr
}

func (s *loanContractsAPITestApplication) ReopenContract(_ core.Context, request loans.ContractCommandRequest) (*loans.CommandResult, error) {
	s.lastLifecycleUid, s.lastLifecycleContractId, s.lastLifecycleVersion = request.Uid, request.ContractId, request.ExpectedContractVersion
	return s.command, s.serviceErr
}

func (s *loanContractsAPITestApplication) CancelContract(_ core.Context, request loans.ContractCommandRequest) (*loans.CommandResult, error) {
	s.lastLifecycleUid, s.lastLifecycleContractId, s.lastLifecycleVersion = request.Uid, request.ContractId, request.ExpectedContractVersion
	return s.command, s.serviceErr
}

func newLoanContractsTestAPI(t *testing.T, application *loanContractsAPITestApplication) *PersonalFinanceLoansContractsApi {
	t.Helper()
	api, err := NewPersonalFinanceLoansContractsApi(application)
	if err != nil {
		t.Fatalf("create loan contracts api: %v", err)
	}
	api.now = func() time.Time { return time.Date(2026, 1, 2, 1, 0, 0, 0, time.UTC) }
	return api
}

func newLoanContractsTestContext(t *testing.T, method, target, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(core.ClientTimezoneOffsetHeaderName, "480")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func validLoanCalculationJSON() string {
	return `{"effectiveDate":"2026-01-03","contractDate":"2026-01-01","firstDueDate":"2026-02-01","fundingType":"cash_disbursement","inputMode":"rate","repaymentMethod":"equal_payment","rateQuoteType":"annual","principalAmount":1000,"actualDisbursementAmount":1000,"upfrontFeeAmount":0,"perPeriodFeeAmount":10,"termCount":1,"quotedRatePptr":"120000000000","discountType":"none","discountRatePptr":null,"discountAmount":0}`
}

func validLoanCalculationResult() *loans.CalculationResult {
	monthly, simple, effective := int64(10000000000), int64(120000000000), int64(126825030132)
	return &loans.CalculationResult{CalculationVersion: calculation.CalculationVersion, RoundingVersion: calculation.RoundingVersion,
		IrrVersion: calculation.IRRVersion, ActualDisbursementAmount: 1000, PeriodicRatePptr: 10000000000,
		Installments: []calculation.Installment{validLoanCalculationInstallment()}, PreDiscountTotalPaymentAmount: 1110,
		PreDiscountTotalCostAmount: 110, TotalPaymentAmount: 1110, TotalInterestAmount: 100, TotalFeeAmount: 10,
		TotalDiscountAmount: 0, TotalCostAmount: 110, CostRatioPptr: 110000000000,
		IRR: calculation.IRRResult{Status: calculation.IRRStatusSolved, MonthlyIRRPPTR: &monthly, SimpleAPRPPTR: &simple, EffectiveAPRPPTR: &effective}}
}

func validLoanCalculationInstallment() calculation.Installment {
	return calculation.Installment{InstallmentNumber: 1, DueDate: "2026-02-01", BeginningPrincipalAmount: 1000,
		PrincipalAmount: 1000, InterestAmount: 100, FeeAmount: 10, PaymentAmount: 1110, EndingPrincipalAmount: 0,
		PreDiscountInterestAmount: 100, PreDiscountFeeAmount: 10, PreDiscountPaymentAmount: 1110}
}

func validLoanContract() *loans.ContractResult {
	defaultAccount := int64(702)
	return &loans.ContractResult{ContractId: 5001, Name: "Server contract", LenderName: "Server lender", ContractType: loans.CONTRACT_TYPE_BANK_LOAN,
		LiabilityAccountId: 701, Status: loans.CONTRACT_STATUS_ACTIVE, DefaultPaymentAccountId: &defaultAccount, Currency: "CNY", Note: "server-note",
		Version: 3, CurrentRevisionId: 6001, CreatedUnixTime: 1000, UpdatedUnixTime: 2000}
}

func validLoanRevision() *loans.RevisionResult {
	quoted, monthly, simple, effective := int64(120000000000), int64(10000000000), int64(120000000000), int64(126825030132)
	return &loans.RevisionResult{RevisionId: 6001, ContractId: 5001, RevisionNumber: 1, EffectiveDate: "2026-01-03",
		ContractDate: "2026-01-01", FirstDueDate: "2026-02-01", FundingType: loans.FUNDING_TYPE_CASH_DISBURSEMENT,
		InputMode: loans.INPUT_MODE_RATE, RepaymentMethod: loans.REPAYMENT_METHOD_EQUAL_PAYMENT, RateQuoteType: loans.RATE_QUOTE_TYPE_ANNUAL,
		FrequencyType: loans.FREQUENCY_TYPE_MONTHLY, FrequencyInterval: 1, PrincipalAmount: 1000, ActualDisbursementAmount: 1000,
		PerPeriodFeeAmount: 10, TermCount: 1, QuotedRatePptr: &quoted, DiscountType: loans.DISCOUNT_TYPE_NONE,
		CalculationVersion: loans.CALCULATION_VERSION_V1, RoundingVersion: loans.ROUNDING_VERSION_V1, IrrVersion: loans.IRR_VERSION_V1,
		PreDiscountTotalPaymentAmount: 1110, PreDiscountTotalCostAmount: 110, TotalPaymentAmount: 1110,
		TotalInterestAmount: 100, TotalFeeAmount: 10, TotalCostAmount: 110, CostRatioPptr: 110000000000,
		IrrStatus: loans.IRR_STATUS_SOLVED, MonthlyIrrPptr: &monthly, SimpleAprPptr: &simple, EffectiveAprPptr: &effective, CreatedUnixTime: 1000}
}

func validLoanPlanProgress() loans.PlanProgress {
	next := "2026-02-01"
	return loans.PlanProgress{InstallmentCount: 1, UnpaidInstallmentCount: 1, OutstandingPayment: 1110,
		OutstandingPrincipal: 1000, OutstandingInterest: 100, OutstandingFee: 10, NextDueDate: &next}
}

func validLoanContractDetail() *loans.ContractDetail {
	ledger, difference := int64(900), int64(-100)
	return &loans.ContractDetail{Contract: validLoanContract(), CurrentRevision: validLoanRevision(),
		Installments: []*loans.InstallmentResult{{InstallmentId: 7001, InstallmentNumber: 1, DueDate: "2026-02-01",
			BeginningPrincipalAmount: 1000, PrincipalAmount: 1000, InterestAmount: 100, FeeAmount: 10, PaymentAmount: 1110,
			PreDiscountInterestAmount: 100, PreDiscountFeeAmount: 10, PreDiscountPaymentAmount: 1110}},
		ActiveAllocationAggregates: []*loans.AllocationAggregate{}, InstallmentProgress: []*loans.InstallmentProgress{{
			InstallmentId: 7001, InstallmentNumber: 1, DueDate: "2026-02-01", Status: loans.INSTALLMENT_PROGRESS_UNPAID,
			Components: loans.ComponentProgress{PlannedPrincipalAmount: 1000, PlannedInterestAmount: 100, PlannedFeeAmount: 10,
				OutstandingPrincipal: 1000, OutstandingInterest: 100, OutstandingFee: 10}, OutstandingPayment: 1110}},
		Progress: validLoanPlanProgress(), Remaining: loans.PlanRemaining{PaymentAmount: 1110, PrincipalAmount: 1000, InterestAmount: 100, FeeAmount: 10},
		LedgerOutstandingAmount: &ledger, LedgerPlanDifferenceAmount: &difference}
}

func validLoanCommandResult(actionType loans.ActionType) *loans.CommandResult {
	started, completed := int64(1000), int64(1001)
	expected := int64(3)
	if actionType == loans.ACTION_TYPE_CREATE_CONTRACT {
		expected = 0
	}
	return &loans.CommandResult{Action: &loans.CommandAction{ActionId: 9001, ContractId: 5001, ExpectedContractVersion: expected,
		AppliedContractVersion: expected + 1, ActionType: actionType, Status: loans.ACTION_STATUS_APPLIED,
		ReasonCodes: []loans.ServiceErrorCode{}, CreatedUnixTime: 1000, StartedUnixTime: &started, CompletedUnixTime: &completed, UpdatedUnixTime: 1001}}
}

func marshalLoanContractsResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal loan contracts response: %v", err)
	}
	return string(encoded)
}

func assertLoanContractsResponseOmits(t *testing.T, text string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(text, value) {
			t.Fatalf("loan response leaked %q: %s", value, text)
		}
	}
}
