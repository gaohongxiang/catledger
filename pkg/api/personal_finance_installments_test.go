package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
)

func TestInstallmentCandidateHandlersUseStringIdsAndOmitSecrets(t *testing.T) {
	liability, contractId, purchaseId, period := int64(11), int64(88), int64(501), int64(2)
	stub := &installmentAPITestApplication{list: &installments.CandidateListResult{
		Items:      []*installments.CandidateView{validInstallmentCandidateView(liability, contractId, purchaseId, period)},
		NextCursor: &installments.CandidateCursor{UpdatedUnixTime: 1700000100, CandidateId: 9002},
	}}
	stub.item = stub.list.Items[0]
	api := newInstallmentTestAPI(t, stub)

	listResponse, apiErr := api.InstallmentCandidateListHandler(newInstallmentTestContext(t, http.MethodGet,
		"/list?status=pending&limit=20&cursor_updated_unix_time=1700000000&cursor_candidate_id=9000", ""))
	if apiErr != nil {
		t.Fatalf("list installment candidates: %v", apiErr)
	}
	if stub.listUid != 1001 || stub.listStatus != installments.CANDIDATE_STATUS_PENDING || stub.listLimit != 20 ||
		stub.listCursor == nil || stub.listCursor.CandidateId != 9000 {
		t.Fatalf("unexpected list request: uid=%d status=%s limit=%d cursor=%+v", stub.listUid, stub.listStatus, stub.listLimit, stub.listCursor)
	}
	listText := marshalInstallmentResponse(t, listResponse)
	for _, expected := range []string{`"id":"9001"`, `"liabilityAccountId":"11"`, `"linkedContractId":"88"`,
		`"linkedPurchaseTransactionId":"501"`, `"candidateId":"9002"`, `"refId":"401"`} {
		if !strings.Contains(listText, expected) {
			t.Fatalf("list response omitted %s: %s", expected, listText)
		}
	}
	assertInstallmentResponseOmits(t, listText, "candidateKey", "candidate_key", "RawItem", "rawNote", "alias")

	getResponse, apiErr := api.InstallmentCandidateGetHandler(newInstallmentTestContext(t, http.MethodGet, "/get?id=9001", ""))
	if apiErr != nil {
		t.Fatalf("get installment candidate: %v", apiErr)
	}
	if stub.getUid != 1001 || stub.getCandidateId != 9001 {
		t.Fatalf("unexpected get request: uid=%d id=%d", stub.getUid, stub.getCandidateId)
	}
	assertInstallmentResponseOmits(t, marshalInstallmentResponse(t, getResponse), "candidateKey", "uid", "RawItem")
}

func TestInstallmentCandidateConfirmHandlerMapsFirstPayloadAndLoanCreateDTO(t *testing.T) {
	stub := &installmentAPITestApplication{item: validInstallmentCandidateView(11, 0, 0, 1)}
	api := newInstallmentTestAPI(t, stub)

	firstBody := `{"candidateId":"9001","expectedVersion":3,"treatAsInstallment":true,"liabilityAccountId":"11","termCount":12,"purchaseRelation":"unresolved"}`
	if _, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm", firstBody)); apiErr != nil {
		t.Fatalf("first confirm payload: %v", apiErr)
	}
	if stub.confirm.Uid != 1001 || stub.confirm.CandidateId != 9001 || stub.confirm.ExpectedVersion != 3 ||
		!stub.confirm.TreatAsInstallment || stub.confirm.LiabilityAccountId == nil || *stub.confirm.LiabilityAccountId != 11 ||
		stub.confirm.TermCount == nil || *stub.confirm.TermCount != 12 || stub.confirm.Contract != nil {
		t.Fatalf("unexpected first confirm request: %+v", stub.confirm)
	}

	createBody := `{"candidateId":"9001","expectedVersion":4,"treatAsInstallment":true,"contract":{"name":"Card plan","lenderName":"Bank","contractType":"credit_card_installment","liabilityAccountId":"11","currency":"CNY","note":""},"calculation":` + validLoanCalculationJSON() + `}`
	if _, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm", createBody)); apiErr != nil {
		t.Fatalf("create_contract confirm payload: %v", apiErr)
	}
	if stub.confirm.Contract == nil || stub.confirm.Contract.LiabilityAccountId != 11 || stub.confirm.Contract.Terms.TermCount != 1 ||
		stub.confirm.Contract.Terms.PrincipalAmount != 1000 {
		t.Fatalf("create_contract confirm did not reuse loan DTO mapping: %+v", stub.confirm.Contract)
	}
}

func TestInstallmentCandidateHandlersMapErrorsAndRejectInvalidInput(t *testing.T) {
	stub := &installmentAPITestApplication{item: validInstallmentCandidateView(11, 0, 0, 1), list: &installments.CandidateListResult{}}
	api := newInstallmentTestAPI(t, stub)

	if response, apiErr := api.InstallmentCandidateListHandler(newInstallmentTestContext(t, http.MethodGet, "/list?status=pending&extra=1", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown list query was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.InstallmentCandidateGetHandler(newInstallmentTestContext(t, http.MethodGet, "/get?id=abc", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid get id was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm",
		`{"candidateId":"9001","expectedVersion":1,"treatAsInstallment":true,"uid":"999"}`)); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown confirm field was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm",
		`{"candidateId":"9001","expectedVersion":1,"treatAsInstallment":true,"contract":{"name":"x","lenderName":"y","contractType":"bank_loan","liabilityAccountId":"11","currency":"CNY","note":""}}`)); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("incomplete contract details were accepted: response=%v err=%v", response, apiErr)
	}

	stub.err = installments.ErrServiceInvalidRequest
	if response, apiErr := api.InstallmentCandidateListHandler(newInstallmentTestContext(t, http.MethodGet, "/list?status=not-a-status", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid status did not map to parameter error: response=%v err=%v", response, apiErr)
	}
	stub.err = installments.ErrServiceVersionConflict
	if response, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm",
		`{"candidateId":"9001","expectedVersion":1,"treatAsInstallment":true}`)); response != nil || apiErr != errs.ErrRepeatedRequest {
		t.Fatalf("version conflict did not map to repeated request: response=%v err=%v", response, apiErr)
	}
	stub.err = installments.ErrServiceStateConflict
	if response, apiErr := api.InstallmentCandidateConfirmHandler(newInstallmentTestContext(t, http.MethodPost, "/confirm",
		`{"candidateId":"9001","expectedVersion":1,"treatAsInstallment":false}`)); response != nil || apiErr != errs.ErrRepeatedRequest {
		t.Fatalf("state conflict did not map to repeated request: response=%v err=%v", response, apiErr)
	}
}

type installmentAPITestApplication struct {
	list           *installments.CandidateListResult
	item           *installments.CandidateView
	err            error
	listUid        int64
	listStatus     installments.CandidateStatus
	listCursor     *installments.CandidateCursor
	listLimit      int
	getUid         int64
	getCandidateId int64
	confirm        installments.ConfirmRequest
}

func (a *installmentAPITestApplication) ListCandidates(_ core.Context, uid int64, status installments.CandidateStatus, cursor *installments.CandidateCursor, limit int) (*installments.CandidateListResult, error) {
	a.listUid, a.listStatus, a.listCursor, a.listLimit = uid, status, cursor, limit
	return a.list, a.err
}

func (a *installmentAPITestApplication) GetCandidate(_ core.Context, uid int64, candidateId int64) (*installments.CandidateView, error) {
	a.getUid, a.getCandidateId = uid, candidateId
	return a.item, a.err
}

func (a *installmentAPITestApplication) ConfirmCandidate(_ core.Context, request installments.ConfirmRequest) (*installments.CandidateView, error) {
	a.confirm = request
	return a.item, a.err
}

func newInstallmentTestAPI(t *testing.T, application *installmentAPITestApplication) *PersonalFinanceInstallmentsApi {
	t.Helper()
	api, err := NewPersonalFinanceInstallmentsApi(application)
	if err != nil {
		t.Fatalf("create installment api: %v", err)
	}
	return api
}

func newInstallmentTestContext(t *testing.T, method, target, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func validInstallmentCandidateView(liability, contractId, purchaseId, period int64) *installments.CandidateView {
	view := &installments.CandidateView{
		CandidateId: 9001, Status: installments.CANDIDATE_STATUS_PENDING, Version: 3,
		PurchaseRelation: installments.PURCHASE_RELATION_UNRESOLVED, TermCount: int64PtrAPI(12),
		CreatedUnixTime: 1700000000, UpdatedUnixTime: 1700000000,
		Members: []*installments.MemberView{{
			MemberId: 7001, MemberKind: installments.MEMBER_KIND_RAW_ROW, MemberRefId: 401,
			MemberRole: installments.MEMBER_ROLE_INSTALLMENT_CHARGE, PeriodNumber: int64PtrAPI(period),
			CreatedUnixTime: 1700000000,
		}},
	}
	if liability > 0 {
		view.LiabilityAccountId = int64PtrAPI(liability)
	}
	if contractId > 0 {
		view.LinkedContractId = int64PtrAPI(contractId)
	}
	if purchaseId > 0 {
		view.LinkedPurchaseTransactionId = int64PtrAPI(purchaseId)
	}
	return view
}

func marshalInstallmentResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal installment response: %v", err)
	}
	return string(encoded)
}

func assertInstallmentResponseOmits(t *testing.T, text string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(text, value) {
			t.Fatalf("installment response leaked %q: %s", value, text)
		}
	}
}

func int64PtrAPI(value int64) *int64 {
	return &value
}
