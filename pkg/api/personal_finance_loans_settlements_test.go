package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

func TestLoanSettlementCandidatesHandlerProjectsMaskedCivilSnapshots(t *testing.T) {
	counterpartUpdated := int64(2101)
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{},
		candidates: &loans.SettlementCandidateResult{ContractId: 5001, InstallmentId: loanSettlementTestInt64(7001),
			Groups: []loans.SettlementCandidateGroup{{ComponentType: loans.COMPONENT_TYPE_PRINCIPAL, ExpectedAmount: 1000,
				OutstandingAmount: 500, LimitReached: true, Candidates: []loans.SettlementCandidate{{
					TransactionId: 8001, Kind: loans.LEDGER_EVENT_KIND_TRANSFER,
					TransactionUnixTime: time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC).Unix(), Amount: 300, Currency: "CNY",
					MaskedSourceAccount: "asset-**0702", MaskedDestinationAccount: "debt-**0701", Eligible: false,
					ReasonCodes: []loans.ServiceErrorCode{loans.SERVICE_ERROR_LEDGER_EVENT_MODIFIED}, UpdatedUnixTime: 2100,
					CounterpartUpdatedUnixTime: &counterpartUpdated}}}}}}
	api := newLoanSettlementsTestAPI(t, stub)
	response, apiErr := api.LoanSettlementCandidatesHandler(newLoanContractsTestContext(t, http.MethodGet,
		"/candidates?contract_id=5001&installment_id=7001&component_type=principal", ""))
	if apiErr != nil {
		t.Fatalf("list settlement candidates: %v", apiErr)
	}
	if stub.candidatesRequest.Uid != 1001 || stub.candidatesRequest.ContractId != 5001 ||
		stub.candidatesRequest.InstallmentId == nil || *stub.candidatesRequest.InstallmentId != 7001 ||
		stub.candidatesRequest.ComponentType != loans.COMPONENT_TYPE_PRINCIPAL {
		t.Fatalf("candidate request did not inject caller identity: %+v", stub.candidatesRequest)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"contractId":"5001"`, `"installmentId":"7001"`, `"transactionId":"8001"`,
		`"transactionType":"transfer"`, `"transactionDate":"2026-01-02"`, `"maskedSourceAccount":"asset-**0702"`,
		`"maskedDestinationAccount":"debt-**0701"`, `"counterpartUpdatedUnixTime":2101`, `"limitReached":true`,
		`"code":"ledger_event_modified"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("candidate response omitted %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "uid", "categoryId", "sourceAccountId", "destinationAccountId",
		"idempotency", "digest", "note", "tag", "evidence", "errorCode")

	invalidTimezone := newLoanContractsTestContext(t, http.MethodGet,
		"/candidates?contract_id=5001&installment_id=7001&component_type=principal", "")
	invalidTimezone.Request.Header.Set(core.ClientTimezoneOffsetHeaderName, "65536")
	if response, apiErr = api.LoanSettlementCandidatesHandler(invalidTimezone); response != nil || apiErr != errs.ErrClientTimezoneOffsetInvalid {
		t.Fatalf("out-of-range candidate timezone was accepted: response=%v error=%v", response, apiErr)
	}
}

func TestLoanSettlementApplyHandlerAcceptsTransferSnapshotsAndReturnsAllocations(t *testing.T) {
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{},
		settlement: validLoanSettlementResult(loans.ACTION_TYPE_APPLY_SETTLEMENT, loans.COMPONENT_TYPE_PRINCIPAL, loans.ALLOCATION_STATUS_ACTIVE)}
	api := newLoanSettlementsTestAPI(t, stub)
	body := `{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-key-001","components":[{"componentType":"principal","allocatedAmount":300,"existingTransactionId":"8001","expectedUpdatedUnixTime":2100,"expectedCounterpartUpdatedUnixTime":2101}]}`
	response, apiErr := api.LoanSettlementApplyHandler(newLoanContractsTestContext(t, http.MethodPost, "/apply", body))
	if apiErr != nil {
		t.Fatalf("apply settlement: %v", apiErr)
	}
	request := stub.applyRequest
	if request.Uid != 1001 || request.ContractId != 5001 || request.InstallmentId == nil || *request.InstallmentId != 7001 ||
		request.CreatedIp == "" || len(request.Components) != 1 || request.Components[0].Existing == nil ||
		request.Components[0].Existing.ExistingTransactionId != 8001 || request.Components[0].Existing.ExpectedCounterpartUpdatedUnixTime == nil ||
		*request.Components[0].Existing.ExpectedCounterpartUpdatedUnixTime != 2101 || stub.applyLocation == nil {
		t.Fatalf("unexpected settlement apply request: %+v location=%v", request, stub.applyLocation)
	}
	text := marshalLoanContractsResponse(t, response)
	for _, expected := range []string{`"actionId":"9001"`, `"id":"9101"`, `"transactionId":"8001"`,
		`"counterpartTransactionId":"8002"`, `"transactionUpdatedUnixTime":2100`, `"counterpartUpdatedUnixTime":2101`,
		`"creationMethod":"attached_existing"`, `"status":"active"`, `"reasonCodes":[]`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("apply response omitted %s: %s", expected, text)
		}
	}
	assertLoanContractsResponseOmits(t, text, "uid", "apply-key-001", "idempotency", "digest", "note", "tag", "evidence", "errorCode")
}

func TestLoanSettlementApplyHandlerConvertsCivilDraftWithClientTimezone(t *testing.T) {
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{},
		settlement: validLoanSettlementResult(loans.ACTION_TYPE_APPLY_SETTLEMENT, loans.COMPONENT_TYPE_INTEREST, loans.ALLOCATION_STATUS_ACTIVE)}
	api := newLoanSettlementsTestAPI(t, stub)
	context := newLoanContractsTestContext(t, http.MethodPost, "/apply",
		`{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-draft-001","components":[{"componentType":"interest","allocatedAmount":100,"ledgerDraft":{"transactionType":"expense","transactionDate":"2026-03-08","sourceAccountId":"702","categoryId":"801","amount":100,"currency":"CNY"}}]}`)
	context.Request.Header.Set(core.ClientTimezoneNameHeaderName, "America/New_York")
	response, apiErr := api.LoanSettlementApplyHandler(context)
	if apiErr != nil || response == nil {
		t.Fatalf("apply settlement draft: response=%v error=%v", response, apiErr)
	}
	draft := stub.applyRequest.Components[0].Draft
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	expected := time.Date(2026, 3, 8, 0, 0, 0, 0, location).Unix()
	if draft == nil || draft.Kind != loans.LEDGER_EVENT_KIND_EXPENSE || draft.TransactionUnixTime != expected ||
		draft.TimezoneUtcOffset != -300 || draft.SourceAccountId != 702 || draft.DestinationAccountId != 0 || draft.CategoryId != 801 ||
		stub.applyLocation == nil || stub.applyLocation.String() != "America/New_York" {
		t.Fatalf("civil draft was not converted in client timezone: draft=%+v location=%v", draft, stub.applyLocation)
	}
}

func TestLoanSettlementApplyHandlerRejectsAmbiguousOrSensitiveDTOFields(t *testing.T) {
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{},
		settlement: validLoanSettlementResult(loans.ACTION_TYPE_APPLY_SETTLEMENT, loans.COMPONENT_TYPE_PRINCIPAL, loans.ALLOCATION_STATUS_ACTIVE)}
	api := newLoanSettlementsTestAPI(t, stub)
	valid := `{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-key-001","components":[{"componentType":"principal","allocatedAmount":300,"existingTransactionId":"8001","expectedUpdatedUnixTime":2100,"expectedCounterpartUpdatedUnixTime":2101}]}`
	tests := map[string]string{
		"client uid":                   strings.Replace(valid, `{`, `{"uid":"999",`, 1),
		"numeric identifier":           strings.Replace(valid, `"5001"`, `5001`, 1),
		"nullable installment":         strings.Replace(valid, `"7001"`, `null`, 1),
		"transfer counterpart missing": strings.Replace(valid, `,"expectedCounterpartUpdatedUnixTime":2101`, ``, 1),
		"unexpected existing field":    strings.Replace(valid, `"expectedUpdatedUnixTime":2100`, `"expectedUpdatedUnixTime":2100,"memo":"private"`, 1),
		"draft tag":                    `{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-key-001","components":[{"componentType":"interest","allocatedAmount":100,"ledgerDraft":{"transactionType":"expense","transactionDate":"2026-03-08","sourceAccountId":"702","categoryId":"801","amount":100,"currency":"CNY","tag":"private"}}]}`,
		"expense destination null":     `{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-key-001","components":[{"componentType":"interest","allocatedAmount":100,"ledgerDraft":{"transactionType":"expense","transactionDate":"2026-03-08","sourceAccountId":"702","destinationAccountId":null,"categoryId":"801","amount":100,"currency":"CNY"}}]}`,
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			response, apiErr := api.LoanSettlementApplyHandler(newLoanContractsTestContext(t, http.MethodPost, "/apply", body))
			if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() {
				t.Fatalf("invalid settlement DTO was accepted: response=%v error=%v", response, apiErr)
			}
		})
	}
	if stub.applyCalls != 0 {
		t.Fatalf("invalid settlement DTO reached application %d times", stub.applyCalls)
	}
}

func TestLoanSettlementApplyHandlerRejectsCrossContractResult(t *testing.T) {
	result := validLoanSettlementResult(loans.ACTION_TYPE_APPLY_SETTLEMENT, loans.COMPONENT_TYPE_PRINCIPAL, loans.ALLOCATION_STATUS_ACTIVE)
	result.Action.ContractId = 5999
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{}, settlement: result}
	api := newLoanSettlementsTestAPI(t, stub)
	body := `{"contractId":"5001","expectedContractVersion":3,"installmentId":"7001","idempotencyKey":"apply-key-001","components":[{"componentType":"principal","allocatedAmount":300,"existingTransactionId":"8001","expectedUpdatedUnixTime":2100,"expectedCounterpartUpdatedUnixTime":2101}]}`
	response, apiErr := api.LoanSettlementApplyHandler(newLoanContractsTestContext(t, http.MethodPost, "/apply", body))
	if response != nil || apiErr != errs.ErrOperationFailed {
		t.Fatalf("cross-contract settlement result was exposed: response=%v error=%v", response, apiErr)
	}
}

func TestLoanSettlementUndoImpactAndUndoHandlers(t *testing.T) {
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{},
		impact: &loans.SettlementUndoImpact{ContractId: 5001, ApplyActionId: 9001, ActiveAllocationCount: 1,
			RelationshipCount: 2, AffectedTransactionCount: 2, LoanCreatedTransactionCount: 2, ModifiedTransactionCount: 1,
			CanUndoRelationships: true, ReasonCodes: []loans.ServiceErrorCode{loans.SERVICE_ERROR_LEDGER_EVENT_MODIFIED}},
		settlement: validLoanSettlementResult(loans.ACTION_TYPE_REVERSE_SETTLEMENT, loans.COMPONENT_TYPE_PRINCIPAL, loans.ALLOCATION_STATUS_REVERSED)}
	api := newLoanSettlementsTestAPI(t, stub)
	impactResponse, apiErr := api.LoanSettlementUndoImpactHandler(newLoanContractsTestContext(t, http.MethodGet,
		"/undo_impact?contract_id=5001&action_id=9001", ""))
	if apiErr != nil {
		t.Fatalf("get settlement undo impact: %v", apiErr)
	}
	if stub.impactRequest.Uid != 1001 || stub.impactRequest.ContractId != 5001 || stub.impactRequest.ApplyActionId != 9001 {
		t.Fatalf("undo impact request did not inject uid: %+v", stub.impactRequest)
	}
	impactText := marshalLoanContractsResponse(t, impactResponse)
	for _, expected := range []string{`"contractId":"5001"`, `"actionId":"9001"`, `"relationshipCount":2`,
		`"modifiedTransactionCount":1`, `"canUndoRelationships":true`, `"code":"ledger_event_modified"`} {
		if !strings.Contains(impactText, expected) {
			t.Fatalf("undo impact omitted %s: %s", expected, impactText)
		}
	}

	undoBody := `{"contractId":"5001","actionId":"9001","expectedContractVersion":4,"idempotencyKey":"undo-key-001"}`
	undoResponse, apiErr := api.LoanSettlementUndoHandler(newLoanContractsTestContext(t, http.MethodPost, "/undo", undoBody))
	if apiErr != nil {
		t.Fatalf("undo settlement: %v", apiErr)
	}
	if stub.reverseRequest.Uid != 1001 || stub.reverseRequest.ContractId != 5001 || stub.reverseRequest.ApplyActionId != 9001 ||
		stub.reverseRequest.ExpectedContractVersion != 4 || stub.reverseRequest.IdempotencyKey != "undo-key-001" {
		t.Fatalf("unexpected reverse request: %+v", stub.reverseRequest)
	}
	undoText := marshalLoanContractsResponse(t, undoResponse)
	for _, expected := range []string{`"actionId":"9001"`, `"status":"reversed"`, `"transactionUpdatedUnixTime":2100`,
		`"counterpartUpdatedUnixTime":2101`} {
		if !strings.Contains(undoText, expected) {
			t.Fatalf("undo response omitted %s: %s", expected, undoText)
		}
	}
	assertLoanContractsResponseOmits(t, impactText+undoText, "uid", "undo-key-001", "idempotency", "digest", "note", "tag", "evidence", "errorCode")
}

func TestLoanSettlementQueryAndUndoDTOsAreStrict(t *testing.T) {
	stub := &loanSettlementsAPITestApplication{loanContractsAPITestApplication: &loanContractsAPITestApplication{}}
	api := newLoanSettlementsTestAPI(t, stub)
	tests := []struct {
		name   string
		invoke func(*core.WebContext) (any, *errs.Error)
		method string
		target string
		body   string
	}{
		{name: "candidate unknown query", invoke: api.LoanSettlementCandidatesHandler, method: http.MethodGet,
			target: "/candidates?contract_id=5001&component_type=fee&private=true"},
		{name: "candidate repeated query", invoke: api.LoanSettlementCandidatesHandler, method: http.MethodGet,
			target: "/candidates?contract_id=5001&component_type=fee&component_type=interest"},
		{name: "impact unknown query", invoke: api.LoanSettlementUndoImpactHandler, method: http.MethodGet,
			target: "/undo_impact?contract_id=5001&action_id=9001&uid=1001"},
		{name: "undo numeric action id", invoke: api.LoanSettlementUndoHandler, method: http.MethodPost, target: "/undo",
			body: `{"contractId":"5001","actionId":9001,"expectedContractVersion":4,"idempotencyKey":"undo-key-001"}`},
		{name: "undo client uid", invoke: api.LoanSettlementUndoHandler, method: http.MethodPost, target: "/undo",
			body: `{"uid":"1001","contractId":"5001","actionId":"9001","expectedContractVersion":4,"idempotencyKey":"undo-key-001"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, apiErr := test.invoke(newLoanContractsTestContext(t, test.method, test.target, test.body))
			if response != nil || apiErr == nil || apiErr.Code() != errs.ErrIncompleteOrIncorrectSubmission.Code() {
				t.Fatalf("strict loan settlement request was accepted: response=%v error=%v", response, apiErr)
			}
		})
	}
}

func TestLoanSettlementReasonWhitelistRejectsInternalCodes(t *testing.T) {
	stable := []loans.ServiceErrorCode{loans.SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED, loans.SERVICE_ERROR_INSTALLMENT_NOT_FOUND,
		loans.SERVICE_ERROR_REVISION_MISMATCH, loans.SERVICE_ERROR_COMPONENT_MISMATCH, loans.SERVICE_ERROR_AMOUNT_EXCEEDED,
		loans.SERVICE_ERROR_LEDGER_EVENT_MISSING, loans.SERVICE_ERROR_LEDGER_EVENT_MODIFIED, loans.SERVICE_ERROR_LEDGER_EVENT_TYPE,
		loans.SERVICE_ERROR_LEDGER_EVENT_ACCOUNT, loans.SERVICE_ERROR_LEDGER_EVENT_CURRENCY, loans.SERVICE_ERROR_LEDGER_EVENT_AMOUNT,
		loans.SERVICE_ERROR_LEDGER_CATEGORY, loans.SERVICE_ERROR_TRANSFER_INCOMPLETE, loans.SERVICE_ERROR_BINDING_CONFLICT,
		loans.SERVICE_ERROR_SETTLEMENT_NOT_FOUND, loans.SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED, loans.SERVICE_ERROR_ALLOCATION_LIMIT}
	for _, code := range stable {
		if response, err := newPersonalFinanceLoanSettlementReasonResponses([]loans.ServiceErrorCode{code}); err != nil ||
			len(response) != 1 || response[0].Code != string(code) {
			t.Fatalf("stable settlement code %s was rejected: response=%v error=%v", code, response, err)
		}
	}
	for _, code := range []loans.ServiceErrorCode{loans.SERVICE_ERROR_PERSISTENCE, loans.SERVICE_ERROR_INVARIANT, "private_internal_code"} {
		if response, err := newPersonalFinanceLoanSettlementReasonResponses([]loans.ServiceErrorCode{code}); err == nil || response != nil {
			t.Fatalf("internal settlement code %s was exposed: response=%v error=%v", code, response, err)
		}
	}
}

type loanSettlementsAPITestApplication struct {
	*loanContractsAPITestApplication
	candidates *loans.SettlementCandidateResult
	settlement *loans.SettlementResult
	impact     *loans.SettlementUndoImpact
	serviceErr error

	candidatesRequest loans.SettlementCandidateRequest
	applyRequest      loans.ApplySettlementRequest
	applyLocation     *time.Location
	impactRequest     loans.SettlementUndoImpactRequest
	reverseRequest    loans.ReverseSettlementRequest
	applyCalls        int
}

func (s *loanSettlementsAPITestApplication) GetSettlementCandidates(_ core.Context, request loans.SettlementCandidateRequest) (*loans.SettlementCandidateResult, error) {
	s.candidatesRequest = request
	return s.candidates, s.serviceErr
}

func (s *loanSettlementsAPITestApplication) ApplySettlement(_ core.Context, request loans.ApplySettlementRequest, location *time.Location) (*loans.SettlementResult, error) {
	s.applyCalls++
	s.applyRequest, s.applyLocation = request, location
	return s.settlement, s.serviceErr
}

func (s *loanSettlementsAPITestApplication) GetSettlementUndoImpact(_ core.Context, request loans.SettlementUndoImpactRequest) (*loans.SettlementUndoImpact, error) {
	s.impactRequest = request
	return s.impact, s.serviceErr
}

func (s *loanSettlementsAPITestApplication) ReverseSettlement(_ core.Context, request loans.ReverseSettlementRequest) (*loans.SettlementResult, error) {
	s.reverseRequest = request
	return s.settlement, s.serviceErr
}

func newLoanSettlementsTestAPI(t *testing.T, application *loanSettlementsAPITestApplication) *PersonalFinanceLoansApi {
	t.Helper()
	api, err := NewPersonalFinanceLoansApi(application)
	if err != nil {
		t.Fatalf("create loan settlements API: %v", err)
	}
	return api
}

func validLoanSettlementResult(actionType loans.ActionType, component loans.ComponentType, status loans.AllocationStatus) *loans.SettlementResult {
	started, completed := int64(1000), int64(1001)
	installmentId, counterpartId, counterpartUpdated := int64(7001), int64(8002), int64(2101)
	expectedVersion := int64(3)
	if actionType == loans.ACTION_TYPE_REVERSE_SETTLEMENT {
		expectedVersion = 4
	}
	action := &loans.CommandAction{ActionId: 9001, ContractId: 5001, ExpectedContractVersion: expectedVersion,
		AppliedContractVersion: expectedVersion + 1, ActionType: actionType, Status: loans.ACTION_STATUS_APPLIED,
		ReasonCodes: []loans.ServiceErrorCode{}, CreatedUnixTime: 1000, StartedUnixTime: &started,
		CompletedUnixTime: &completed, UpdatedUnixTime: 1001}
	allocation := &loans.SettlementAllocationResult{AllocationId: 9101, InstallmentId: &installmentId,
		ComponentType: component, AllocatedAmount: 300, CreationMethod: loans.ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING,
		Status: status, TransactionId: 8001, CounterpartTransactionId: &counterpartId, TransactionUpdatedUnixTime: 2100,
		CounterpartUpdatedUnixTime: &counterpartUpdated, ReasonCodes: []loans.ServiceErrorCode{}, CreatedUnixTime: 1000, UpdatedUnixTime: 1001}
	if component == loans.COMPONENT_TYPE_INTEREST || component == loans.COMPONENT_TYPE_FEE {
		allocation.AllocatedAmount = 100
		allocation.CounterpartTransactionId = nil
		allocation.CounterpartUpdatedUnixTime = nil
	}
	result := &loans.SettlementResult{Action: action, Allocations: []*loans.SettlementAllocationResult{allocation},
		ReasonCodes: []loans.ServiceErrorCode{}}
	if actionType == loans.ACTION_TYPE_REVERSE_SETTLEMENT {
		result.ReversedAllocationCount = 1
	}
	return result
}

func loanSettlementTestInt64(value int64) *int64 {
	return &value
}
