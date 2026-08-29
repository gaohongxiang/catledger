package installments_test

import (
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

type fakeEvidence struct {
	rows map[int64][]*importing.RawImportRow
}

func (f *fakeEvidence) ListRawImportRows(_ core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error) {
	rows := make([]*importing.RawImportRow, 0)
	for _, row := range f.rows[batchId] {
		if row != nil && row.Uid == uid {
			rows = append(rows, row)
		}
	}
	return rows, nil
}

type fakeContracts struct {
	created    *loans.CommandResult
	detail     *loans.ContractDetail
	err        error
	lastCreate loans.CreateContractRequest
}

func (f *fakeContracts) Calculate(_ loans.CalculateRequest) (*loans.CalculationResult, error) {
	return &loans.CalculationResult{}, f.err
}

func (f *fakeContracts) CreateContract(_ core.Context, request loans.CreateContractRequest) (*loans.CommandResult, error) {
	f.lastCreate = request
	return f.created, f.err
}

func (f *fakeContracts) GetContract(_ core.Context, _ int64, contractId int64, _ string) (*loans.ContractDetail, error) {
	if f.detail != nil && f.detail.Contract != nil && f.detail.Contract.ContractId == contractId {
		return f.detail, f.err
	}
	return nil, f.err
}

func TestServiceIngestGroupsPeriodsRejectsUnknownZeroAndConfirmsThreeWays(t *testing.T) {
	repository, _ := newSQLiteInstallmentRepository(t)
	var nextId int64 = 5000
	liability := int64(11)
	identity1, identity2 := int64(201), int64(202)
	evidence := &fakeEvidence{rows: map[int64][]*importing.RawImportRow{
		31: {
			testEvidenceRow(1001, 31, 401, &identity1, "20260815001", "花呗月月付 第1/12期", &liability),
			testEvidenceRow(1001, 31, 402, &identity2, "20260815001", "花呗月月付 第2/12期", &liability),
			testEvidenceRow(1001, 31, 403, nil, "", "买菜", &liability),
		},
	}}
	contracts := &fakeContracts{
		created: &loans.CommandResult{Action: &loans.CommandAction{ContractId: 88}},
		detail:  &loans.ContractDetail{Contract: &loans.ContractResult{ContractId: 77, LiabilityAccountId: 11}},
	}
	service, err := installments.NewService(repository, evidence, contracts, nil, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create installment service: %v", err)
	}
	serviceNow := time.Unix(1_700_000_000, 0)
	// now is unexported; ingest uses time.Now which is fine for sqlite tests

	ingested, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{31}})
	if err != nil || ingested.CandidateCount != 1 || ingested.MemberCount < 2 {
		t.Fatalf("ingest did not group installment rows: %+v err=%v", ingested, err)
	}

	page, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(page.Items) != 1 || page.Items[0].TermCount == nil || *page.Items[0].TermCount != 12 {
		t.Fatalf("pending candidate missing agreed term: %+v err=%v", page, err)
	}
	if page.Items[0].PrincipalAmount != nil || page.Items[0].PaymentAmount != nil {
		t.Fatalf("ingest wrote guessed amounts: %+v", page.Items[0])
	}
	candidateId := page.Items[0].CandidateId

	if _, err := service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: candidateId, ExpectedVersion: page.Items[0].Version, TermCount: int64Ptr(0), TreatAsInstallment: true,
	}); err == nil {
		t.Fatal("term count 0 was accepted")
	}

	needs, err := service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: candidateId, ExpectedVersion: page.Items[0].Version,
		TreatAsInstallment: true, LiabilityAccountId: &liability, TermCount: int64Ptr(12),
		PurchaseRelation: installments.PURCHASE_RELATION_UNRESOLVED,
	})
	if err != nil || needs.Status != installments.CANDIDATE_STATUS_NEEDS_DETAILS {
		t.Fatalf("needs_details confirm failed: %+v err=%v", needs, err)
	}

	linked, err := service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: candidateId, ExpectedVersion: needs.Version,
		TreatAsInstallment: true, LinkedContractId: int64Ptr(77),
	})
	if err != nil || linked.Status != installments.CANDIDATE_STATUS_LINKED || linked.LinkedContractId == nil || *linked.LinkedContractId != 77 {
		t.Fatalf("link_existing confirm failed: %+v err=%v", linked, err)
	}

	// second candidate for dismiss + convert
	evidence.rows[32] = []*importing.RawImportRow{
		testEvidenceRow(1001, 32, 501, int64Ptr(301), "ORDER-B", "信用卡分期 第3/6期", &liability),
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{32}}); err != nil {
		t.Fatalf("ingest second candidate: %v", err)
	}
	secondPage, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(secondPage.Items) != 1 {
		t.Fatalf("second pending candidate: %+v err=%v", secondPage, err)
	}
	dismissed, err := service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: secondPage.Items[0].CandidateId, ExpectedVersion: secondPage.Items[0].Version, TreatAsInstallment: false,
	})
	if err != nil || dismissed.Status != installments.CANDIDATE_STATUS_DISMISSED {
		t.Fatalf("dismiss confirm failed: %+v err=%v", dismissed, err)
	}

	evidence.rows[33] = []*importing.RawImportRow{
		testEvidenceRow(1001, 33, 601, int64Ptr(401), "ORDER-C", "花呗分期 第1/3期", &liability),
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{33}}); err != nil {
		t.Fatalf("ingest third candidate: %v", err)
	}
	thirdPage, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(thirdPage.Items) != 1 {
		t.Fatalf("third pending candidate: %+v err=%v", thirdPage, err)
	}
	staged, err := service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: thirdPage.Items[0].CandidateId, ExpectedVersion: thirdPage.Items[0].Version,
		TreatAsInstallment: true,
		Contract: &loans.ContractSpec{
			Name: "fixture", LenderName: "fixture", ContractType: loans.CONTRACT_TYPE_CREDIT_CARD_INSTALLMENT,
			LiabilityAccountId: 11, Currency: "CNY",
			Terms: loans.CalculationTerms{PrincipalAmount: 1200, TermCount: 3, ActualDisbursementAmount: 1200},
		},
	})
	if err != nil || staged.Status != installments.CANDIDATE_STATUS_PENDING || staged.LinkedContractId != nil {
		t.Fatalf("contract draft was not staged behind posting: %+v err=%v", staged, err)
	}
	if contracts.lastCreate.IdempotencyKey != "" {
		t.Fatalf("formal contract was created before batch posting: %+v", contracts.lastCreate)
	}
	draft, err := repository.FindContractDraft(nil, 1001, thirdPage.Items[0].CandidateId)
	if err != nil || draft == nil {
		t.Fatalf("staged contract draft missing: %+v err=%v", draft, err)
	}
	if err := service.PromoteAfterPosting(nil, installments.PromoteRequest{Uid: 1001, CandidateIds: []int64{thirdPage.Items[0].CandidateId}}); err != nil {
		t.Fatalf("create staged contract after posting: %v", err)
	}
	converted, err := service.GetCandidate(nil, 1001, thirdPage.Items[0].CandidateId)
	if err != nil || converted.Status != installments.CANDIDATE_STATUS_CONVERTED || converted.LinkedContractId == nil || *converted.LinkedContractId != 88 {
		t.Fatalf("staged contract was not created after posting: %+v err=%v", converted, err)
	}
	if contracts.lastCreate.IdempotencyKey != "installment-candidate-"+strconv.FormatInt(thirdPage.Items[0].CandidateId, 10) {
		t.Fatalf("create_contract used unstable idempotency key: %q", contracts.lastCreate.IdempotencyKey)
	}
	if draft, err = repository.FindContractDraft(nil, 1001, thirdPage.Items[0].CandidateId); err != nil || draft != nil {
		t.Fatalf("staged contract draft was not removed after creation: %+v err=%v", draft, err)
	}

	got, err := service.GetCandidate(nil, 1001, converted.CandidateId)
	if err != nil || got.Status != installments.CANDIDATE_STATUS_CONVERTED {
		t.Fatalf("get converted candidate: %+v err=%v", got, err)
	}
	if _, err := service.GetCandidate(nil, 2002, converted.CandidateId); !errors.Is(err, installments.ErrServiceCandidateNotFound) {
		t.Fatalf("cross-user get was not isolated: %v", err)
	}

	evidence.rows[34] = []*importing.RawImportRow{
		testEvidenceRow(1001, 34, 701, int64Ptr(501), "ORDER-D", "电销现分按月收12期第7期共12期", &liability),
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{34}}); err != nil {
		t.Fatalf("ingest post-gated candidate: %v", err)
	}
	pending, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(pending.Items) != 1 {
		t.Fatalf("post-gated pending candidate: %+v err=%v", pending, err)
	}
	promote := installments.PromoteRequest{Uid: 1001, CandidateIds: []int64{pending.Items[0].CandidateId}}
	if err := service.PromoteAfterPosting(nil, promote); err != nil {
		t.Fatalf("promote after posting: %v", err)
	}
	if err := service.PromoteAfterPosting(nil, promote); err != nil {
		t.Fatalf("idempotent promotion failed: %v", err)
	}
	promoted, err := service.GetCandidate(nil, 1001, pending.Items[0].CandidateId)
	if err != nil || promoted.Status != installments.CANDIDATE_STATUS_NEEDS_DETAILS {
		t.Fatalf("candidate was not promoted after posting: %+v err=%v", promoted, err)
	}

	// 放弃整理轮次只清除暂存表单，不删除候选或创建正式合同。
	evidence.rows[35] = []*importing.RawImportRow{
		testEvidenceRow(1001, 35, 801, int64Ptr(601), "ORDER-E", "花呗分期 第1/6期", &liability),
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{35}}); err != nil {
		t.Fatalf("ingest discardable candidate: %v", err)
	}
	discardable, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(discardable.Items) != 1 {
		t.Fatalf("discardable candidate missing: %+v err=%v", discardable, err)
	}
	if _, err = service.ConfirmCandidate(nil, installments.ConfirmRequest{
		Uid: 1001, CandidateId: discardable.Items[0].CandidateId, ExpectedVersion: discardable.Items[0].Version,
		TreatAsInstallment: true,
		Contract: &loans.ContractSpec{
			Name: "discardable", LenderName: "fixture", ContractType: loans.CONTRACT_TYPE_CREDIT_CARD_INSTALLMENT,
			LiabilityAccountId: 11, Currency: "CNY",
			Terms: loans.CalculationTerms{PrincipalAmount: 600, TermCount: 6, ActualDisbursementAmount: 600},
		},
	}); err != nil {
		t.Fatalf("stage discardable contract: %v", err)
	}
	if err = service.DiscardContractDrafts(nil, 1001, []int64{discardable.Items[0].CandidateId}); err != nil {
		t.Fatalf("discard contract draft: %v", err)
	}
	if draft, err = repository.FindContractDraft(nil, 1001, discardable.Items[0].CandidateId); err != nil || draft != nil {
		t.Fatalf("discarded batch left a contract draft: %+v err=%v", draft, err)
	}
	if candidate, getErr := service.GetCandidate(nil, 1001, discardable.Items[0].CandidateId); getErr != nil || candidate.Status != installments.CANDIDATE_STATUS_PENDING {
		t.Fatalf("discard removed or changed candidate evidence: %+v err=%v", candidate, getErr)
	}
	_ = serviceNow
}

func TestServiceIngestConflictMarksActionRequired(t *testing.T) {
	repository, _ := newSQLiteInstallmentRepository(t)
	var nextId int64 = 8000
	liability := int64(11)
	evidence := &fakeEvidence{rows: map[int64][]*importing.RawImportRow{
		41: {
			testEvidenceRow(1001, 41, 701, int64Ptr(501), "ORDER-D", "第1/12期", &liability),
			testEvidenceRow(1001, 41, 702, int64Ptr(502), "ORDER-D", "第2/6期", &liability),
		},
	}}
	service, err := installments.NewService(repository, evidence, &fakeContracts{}, nil, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create installment service: %v", err)
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{41}}); err != nil {
		t.Fatalf("ingest conflict group: %v", err)
	}
	page, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_ACTION_REQUIRED, nil, 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("conflicting terms were not marked action_required: %+v err=%v", page, err)
	}
}

func TestServiceIngestLaterPeriodJoinsExistingCandidate(t *testing.T) {
	repository, _ := newSQLiteInstallmentRepository(t)
	var nextId int64 = 9000
	liability := int64(11)
	evidence := &fakeEvidence{rows: map[int64][]*importing.RawImportRow{
		51: {testEvidenceRow(1001, 51, 801, int64Ptr(601), "ORDER-E", "第1/12期", &liability)},
	}}
	service, err := installments.NewService(repository, evidence, &fakeContracts{}, nil, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create installment service: %v", err)
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{51}}); err != nil {
		t.Fatalf("ingest first period: %v", err)
	}
	first, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(first.Items) != 1 || first.Items[0].CurrentPeriod == nil || *first.Items[0].CurrentPeriod != 1 {
		t.Fatalf("first period candidate: %+v err=%v", first, err)
	}
	evidence.rows[52] = []*importing.RawImportRow{
		testEvidenceRow(1001, 52, 802, int64Ptr(602), "ORDER-E", "第2/12期", &liability),
	}
	if _, err := service.IngestBatches(nil, installments.IngestRequest{Uid: 1001, BatchIds: []int64{52}}); err != nil {
		t.Fatalf("ingest later period: %v", err)
	}
	second, err := service.ListCandidates(nil, 1001, installments.CANDIDATE_STATUS_PENDING, nil, 10)
	if err != nil || len(second.Items) != 1 || second.Items[0].CandidateId != first.Items[0].CandidateId {
		t.Fatalf("later period created a new candidate: %+v err=%v", second, err)
	}
	if second.Items[0].CurrentPeriod == nil || *second.Items[0].CurrentPeriod != 2 {
		t.Fatalf("later period did not advance current period: %+v", second.Items[0])
	}
	rawMembers := 0
	for _, member := range second.Items[0].Members {
		if member != nil && member.MemberKind == installments.MEMBER_KIND_RAW_ROW {
			rawMembers++
		}
	}
	if rawMembers != 2 {
		t.Fatalf("later period was not attached as a member: %+v", second.Items[0].Members)
	}
}

func testEvidenceRow(uid int64, batchId int64, rowId int64, identityId *int64, orderId string, item string, liability *int64) *importing.RawImportRow {
	return &importing.RawImportRow{
		Uid: uid, BatchId: batchId, RowId: rowId, IdentityId: identityId,
		SourceOrderId: orderId, RawItem: item, LedgerAccountId: liability,
	}
}

func int64Ptr(value int64) *int64 {
	return &value
}
