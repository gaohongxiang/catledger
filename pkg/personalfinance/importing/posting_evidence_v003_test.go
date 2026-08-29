package importing_test

import (
	"strings"
	"testing"
	"time"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/reconciliation"
)

func TestTransactionEvidenceIncludesOnlyActiveReconciliationRelations(t *testing.T) {
	repository, database := newSQLiteRepository(t)
	const (
		uid           = int64(8101)
		fileId        = int64(8102)
		batchId       = int64(8103)
		transactionId = int64(8104)
		caseId        = int64(8105)
		oldDecisionId = int64(8106)
		newDecisionId = int64(8107)
	)
	insertImportFile(t, repository, testImportFile(uid, fileId, "8", 10))
	insertPostingBatchRows(t, database, uid, fileId, batchId, []postingRowFixture{
		{rowId: 8111, identityId: 8121, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "1"},
		{rowId: 8112, identityId: 8122, identityState: importing.IDENTITY_STATE_NEW, digestCharacter: "2"},
	})
	now := time.Now().Unix()
	current := newDecisionId
	previous := oldDecisionId
	insertRepositoryBeans(t, database,
		&reconciliation.Case{
			Uid: uid, CaseKey: strings.Repeat("c", 64), CaseKeyVersion: reconciliation.CASE_KEY_VERSION_V1,
			Status: reconciliation.CASE_STATUS_RESOLVED, Version: 2, MemberCount: 2,
			SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT, CandidateScore: 1,
			CandidateRuleVersion: reconciliation.CANDIDATE_RULE_VERSION_V1, ExplanationVersion: reconciliation.EXPLANATION_VERSION_V1,
			ReasonCodesJson: "[]", CurrentDecisionId: &current, CreatedUnixTime: now, LastEvaluatedUnixTime: now, UpdatedUnixTime: now, CaseId: caseId,
		},
		v003EvidenceDecision(uid, caseId, oldDecisionId, nil, now),
		v003EvidenceDecision(uid, caseId, newDecisionId, &previous, now+1),
		&reconciliation.TransactionLink{
			Uid: uid, DecisionId: oldDecisionId, RowId: 8111, TransactionId: transactionId,
			RelationRole: reconciliation.TRANSACTION_RELATION_ROLE_PRIMARY, CreationMethod: reconciliation.TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING,
			RuleVersion: reconciliation.TRANSACTION_LINK_VERSION_V1, TransactionUpdatedUnixTime: now, CreatedUnixTime: now, LinkId: 8131,
		},
		&reconciliation.TransactionLink{
			Uid: uid, DecisionId: newDecisionId, RowId: 8112, TransactionId: transactionId,
			RelationRole: reconciliation.TRANSACTION_RELATION_ROLE_PRIMARY, CreationMethod: reconciliation.TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING,
			RuleVersion: reconciliation.TRANSACTION_LINK_VERSION_V1, TransactionUpdatedUnixTime: now, CreatedUnixTime: now + 1, LinkId: 8132,
		},
	)

	items, err := repository.ListTransactionEvidence(nil, uid, transactionId)
	if err != nil || len(items) != 1 || items[0].Row.RowId != 8112 {
		t.Fatalf("active reconciliation evidence mismatch: %+v %v", items, err)
	}
	if items[0].Link.PostingId != 0 || string(items[0].Link.CreationMethod) != "attached_existing" || string(items[0].Link.RuleVersion) != "reconciliation-link-v1" {
		t.Fatalf("active reconciliation projection corrupted posting semantics: %+v", items[0].Link)
	}
	foreign, err := repository.ListTransactionEvidence(nil, uid+1, transactionId)
	if err != nil || len(foreign) != 0 {
		t.Fatalf("cross-user reconciliation evidence was visible: %+v %v", foreign, err)
	}
}

func v003EvidenceDecision(uid int64, caseId int64, decisionId int64, previous *int64, now int64) *reconciliation.Decision {
	digestCharacter := "d"
	if previous != nil {
		digestCharacter = "f"
	}
	return &reconciliation.Decision{
		Uid: uid, CaseId: caseId, ExpectedCaseVersion: 1, AppliedCaseVersion: 2,
		DecisionType: reconciliation.DECISION_TYPE_SAME_EVENT, PreviousDecisionId: previous,
		IdempotencyKeyDigest: strings.Repeat(digestCharacter, 64), IdempotencyKeyVersion: reconciliation.IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest: strings.Repeat("e", 64), RequestDigestVersion: reconciliation.DECISION_REQUEST_VERSION_V1,
		Status: reconciliation.DECISION_STATUS_APPLIED, FieldSelectionJson: "{}", ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, DecisionId: decisionId,
	}
}
