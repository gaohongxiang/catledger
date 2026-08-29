package api

import (
	"testing"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestReviewIssueAccountMappingPersistsReusablePaymentAccount(t *testing.T) {
	coordinator, payments, sources := reviewAccountMappingTestCoordinator("招商银行信用卡(1234)")
	plan, err := coordinator.prepare(nil, reviewAccountMappingTestRequest())
	if err != nil {
		t.Fatalf("prepare payment account mapping: %v", err)
	}
	if plan == nil || len(plan.paymentAccounts) != 1 || len(plan.sourceAccounts) != 0 {
		t.Fatalf("unexpected payment mapping plan: %+v", plan)
	}
	if err = coordinator.apply(nil, plan); err != nil {
		t.Fatalf("apply payment account mapping: %v", err)
	}
	if len(payments.requests) != 1 || payments.requests[0].Uid != 101 || payments.requests[0].BatchId != 501 ||
		payments.requests[0].RowId != 401 || payments.requests[0].LedgerAccountId != 601 ||
		payments.requests[0].LedgerAccountCurrency != "CNY" || len(sources.saved) != 0 {
		t.Fatalf("payment account mapping was not persisted: payments=%+v sources=%+v", payments.requests, sources.saved)
	}
}

func TestReviewIssueAccountMappingFallsBackToStableSourceAccount(t *testing.T) {
	coordinator, payments, sources := reviewAccountMappingTestCoordinator("")
	plan, err := coordinator.prepare(nil, reviewAccountMappingTestRequest())
	if err != nil {
		t.Fatalf("prepare source account mapping: %v", err)
	}
	if plan == nil || len(plan.paymentAccounts) != 0 || len(plan.sourceAccounts) != 1 {
		t.Fatalf("unexpected source mapping plan: %+v", plan)
	}
	if err = coordinator.apply(nil, plan); err != nil {
		t.Fatalf("apply source account mapping: %v", err)
	}
	if len(payments.requests) != 0 || len(sources.saved) != 1 || sources.saved[0].Uid != 101 ||
		sources.saved[0].SourceAccountId != 701 || sources.saved[0].LedgerAccountId != 601 ||
		sources.saved[0].DisplayName != "支付宝账户" || sources.saved[0].Status != importing.SOURCE_ACCOUNT_STATUS_ACTIVE {
		t.Fatalf("source account mapping was not persisted: payments=%+v sources=%+v", payments.requests, sources.saved)
	}
}

func TestReviewIssueAccountMappingDoesNotPersistAmbiguousPaymentText(t *testing.T) {
	coordinator, payments, sources := reviewAccountMappingTestCoordinator("银行卡")
	plan, err := coordinator.prepare(nil, reviewAccountMappingTestRequest())
	if err != nil {
		t.Fatalf("prepare ambiguous payment account mapping: %v", err)
	}
	if plan == nil || len(plan.paymentAccounts) != 0 || len(plan.sourceAccounts) != 0 {
		t.Fatalf("ambiguous payment text created a persistent mapping: %+v", plan)
	}
	if err = coordinator.apply(nil, plan); err != nil {
		t.Fatalf("apply empty mapping plan: %v", err)
	}
	if len(payments.requests) != 0 || len(sources.saved) != 0 {
		t.Fatalf("ambiguous payment text was persisted: payments=%+v sources=%+v", payments.requests, sources.saved)
	}
}

func TestReviewIssueAccountMappingRejectsCurrencyMismatch(t *testing.T) {
	coordinator, _, _ := reviewAccountMappingTestCoordinator("支付宝余额")
	coordinator.accounts = &reviewAccountReaderStub{account: &models.Account{
		Uid: 101, AccountId: 601, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Currency: "USD",
	}}
	if plan, err := coordinator.prepare(nil, reviewAccountMappingTestRequest()); err != organizer.ErrReviewIssueDecisionInvalid || plan != nil {
		t.Fatalf("currency mismatch was accepted: plan=%+v err=%v", plan, err)
	}
}

func reviewAccountMappingTestRequest() organizer.ResolveReviewIssueRequest {
	ledgerAccountId := int64(601)
	return organizer.ResolveReviewIssueRequest{
		Uid: 101, UpdateId: 201, IssueId: 301,
		Decision: organizer.REVIEW_ISSUE_DECISION_APPLY_FIELDS,
		Correction: organizer.EventCorrection{
			FieldMask:       organizer.MANUAL_FIELD_LEDGER_ACCOUNT,
			LedgerAccountId: &ledgerAccountId,
		},
	}
}

func reviewAccountMappingTestCoordinator(rawPaymentMethod string) (*personalFinanceReviewAccountMappingCoordinator, *reviewPaymentAccountMapperStub, *reviewSourceAccountMapperStub) {
	repository := &reviewIssueMappingRepositoryStub{
		issue: &organizer.ReviewIssue{Uid: 101, UpdateId: 201, IssueId: 301, IssueType: organizer.REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING},
		members: []*organizer.ReviewIssueMember{{
			Uid: 101, UpdateId: 201, IssueId: 301, Role: organizer.REVIEW_ISSUE_MEMBER_ROLE_SUBJECT,
			ObjectType: organizer.REVIEW_OBJECT_TYPE_EVENT, ObjectId: 311,
		}},
		evidence: []*organizer.EconomicEventEvidence{{
			Uid: 101, UpdateId: 201, EventId: 311, RowId: 401, EvidenceRole: organizer.EVIDENCE_ROLE_PRIMARY,
		}},
	}
	evidence := &reviewEvidenceReaderStub{
		batch: &importing.ImportBatch{
			Uid: 101, BatchId: 501, SourceAccountId: reviewInt64(701), SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY,
		},
		rows: []*importing.RawImportRow{{
			Uid: 101, BatchId: 501, RowId: 401, ParseState: importing.PARSE_STATE_VALID,
			ProcessingState: importing.PROCESSING_STATE_PENDING, Currency: "CNY", RawPaymentMethod: rawPaymentMethod,
		}},
	}
	payments := &reviewPaymentAccountMapperStub{}
	sources := &reviewSourceAccountMapperStub{account: &importing.SourceAccount{
		Uid: 101, SourceAccountId: 701, SourceType: importing.SOURCE_TYPE_ALIPAY,
		MaskedDisplayName: "支付宝账户", Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
	}}
	return &personalFinanceReviewAccountMappingCoordinator{
		repository: repository, evidence: evidence,
		accounts: &reviewAccountReaderStub{account: &models.Account{
			Uid: 101, AccountId: 601, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Currency: "CNY",
		}},
		sourceAccounts: sources, paymentAccounts: payments,
	}, payments, sources
}

type reviewIssueMappingRepositoryStub struct {
	issue    *organizer.ReviewIssue
	members  []*organizer.ReviewIssueMember
	evidence []*organizer.EconomicEventEvidence
}

func (s *reviewIssueMappingRepositoryStub) FindReviewIssueById(core.Context, int64, int64) (*organizer.ReviewIssue, error) {
	return s.issue, nil
}

func (s *reviewIssueMappingRepositoryStub) ListReviewIssueMembers(core.Context, int64, int64) ([]*organizer.ReviewIssueMember, error) {
	return s.members, nil
}

func (s *reviewIssueMappingRepositoryStub) ListEvidenceForEvents(core.Context, int64, []int64) ([]*organizer.EconomicEventEvidence, error) {
	return s.evidence, nil
}

type reviewEvidenceReaderStub struct {
	batch *importing.ImportBatch
	rows  []*importing.RawImportRow
}

func (s *reviewEvidenceReaderStub) FindImportBatchById(core.Context, int64, int64) (*importing.ImportBatch, error) {
	return s.batch, nil
}

func (s *reviewEvidenceReaderStub) FindRawImportRowsByIds(core.Context, int64, []int64) ([]*importing.RawImportRow, error) {
	return s.rows, nil
}

type reviewAccountReaderStub struct{ account *models.Account }

func (s *reviewAccountReaderStub) GetAccountByAccountId(core.Context, int64, int64) (*models.Account, error) {
	return s.account, nil
}

type reviewSourceAccountMapperStub struct {
	account *importing.SourceAccount
	saved   []importing.SourceAccountSaveRequest
}

func (s *reviewSourceAccountMapperStub) FindSourceAccount(core.Context, int64, int64) (*importing.SourceAccount, error) {
	return s.account, nil
}

func (s *reviewSourceAccountMapperStub) SaveSourceAccount(_ core.Context, request importing.SourceAccountSaveRequest) (*importing.SourceAccount, error) {
	s.saved = append(s.saved, request)
	return s.account, nil
}

type reviewPaymentAccountMapperStub struct {
	requests []importing.PaymentAccountConfirmRequest
}

func (s *reviewPaymentAccountMapperStub) ConfirmBatchPaymentAccount(_ core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error) {
	s.requests = append(s.requests, request)
	return &importing.PaymentAccountGroup{Mapped: true}, nil
}

func reviewInt64(value int64) *int64 { return &value }
