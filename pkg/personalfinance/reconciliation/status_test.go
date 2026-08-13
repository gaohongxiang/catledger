package reconciliation

import "testing"

func TestFrozenStatusAndDecisionValues(t *testing.T) {
	assertStringValues(t, "case status", []string{
		string(CASE_STATUS_OPEN),
		string(CASE_STATUS_RESOLVED),
		string(CASE_STATUS_ACTION_REQUIRED),
		string(CASE_STATUS_DEFERRED),
	}, []string{"open", "resolved", "action_required", "deferred"})
	assertStringValues(t, "decision type", []string{
		string(DECISION_TYPE_SAME_EVENT),
		string(DECISION_TYPE_INTERNAL_TRANSFER),
		string(DECISION_TYPE_REFUND_REVERSAL),
		string(DECISION_TYPE_INDEPENDENT),
		string(DECISION_TYPE_DEFER),
		string(DECISION_TYPE_REOPEN),
	}, []string{"same_event", "internal_transfer", "refund_reversal", "independent", "defer", "reopen"})
	assertStringValues(t, "decision status", []string{
		string(DECISION_STATUS_READY),
		string(DECISION_STATUS_APPLYING),
		string(DECISION_STATUS_APPLIED),
		string(DECISION_STATUS_ACTION_REQUIRED),
		string(DECISION_STATUS_DEFERRED),
		string(DECISION_STATUS_FAILED),
	}, []string{"ready", "applying", "applied", "action_required", "deferred", "failed"})
}

func TestFrozenEvidenceAndLedgerValues(t *testing.T) {
	assertStringValues(t, "member kind", []string{
		string(MEMBER_KIND_SOURCE_IDENTITY),
		string(MEMBER_KIND_RAW_ROW),
	}, []string{"source_identity", "raw_row"})
	assertStringValues(t, "transaction role", []string{
		string(TRANSACTION_RELATION_ROLE_PRIMARY),
		string(TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART),
		string(TRANSACTION_RELATION_ROLE_REFUND_ORIGINAL),
		string(TRANSACTION_RELATION_ROLE_REFUND_TRANSACTION),
	}, []string{"primary", "transfer_counterpart", "refund_original", "refund_transaction"})
	assertStringValues(t, "creation method", []string{
		string(TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING),
		string(TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED),
	}, []string{"attached_existing", "reconciliation_created"})
	assertStringValues(t, "ledger effect", []string{
		string(LEDGER_EFFECT_TYPE_CREATED),
		string(LEDGER_EFFECT_TYPE_SOFT_DELETED),
		string(LEDGER_EFFECT_TYPE_RESTORED),
	}, []string{"created", "soft_deleted", "restored"})
}

func assertStringValues(t *testing.T, name string, actual []string, expected []string) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("%s value count is %d, expected %d", name, len(actual), len(expected))
	}

	seen := make(map[string]struct{}, len(actual))

	for index := range actual {
		if actual[index] != expected[index] {
			t.Fatalf("%s value %d is %q, expected %q", name, index, actual[index], expected[index])
		}

		if _, exists := seen[actual[index]]; exists {
			t.Fatalf("%s contains duplicate value %q", name, actual[index])
		}

		seen[actual[index]] = struct{}{}
	}
}
