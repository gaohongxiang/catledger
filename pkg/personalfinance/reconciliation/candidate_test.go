package reconciliation

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestCandidateCaseKeyUsesSortedStableMemberTokens(t *testing.T) {
	first := []candidateMemberToken{
		{kind: MEMBER_KIND_SOURCE_IDENTITY, refId: 91},
		{kind: MEMBER_KIND_RAW_ROW, refId: 42},
	}
	second := []candidateMemberToken{first[1], first[0]}
	sortCandidateMemberTokens(first)
	sortCandidateMemberTokens(second)

	firstKey := computeCandidateCaseKey(first)
	secondKey := computeCandidateCaseKey(second)

	if len(firstKey) != 64 || firstKey != secondKey {
		t.Fatalf("stable candidate case key changed with member order: %q %q", firstKey, secondKey)
	}

	changed := []candidateMemberToken{
		{kind: MEMBER_KIND_SOURCE_IDENTITY, refId: 91},
		{kind: MEMBER_KIND_SOURCE_IDENTITY, refId: 42},
	}
	sortCandidateMemberTokens(changed)

	if computeCandidateCaseKey(changed) == firstKey {
		t.Fatalf("member kind was not included in candidate case key")
	}
}

func TestCandidateRelationshipSuggestionsAndSafeReasons(t *testing.T) {
	baseTime := int64(1_720_000_000)
	baseAmount := int64(12_345)
	firstIdentity := int64(101)
	secondIdentity := int64(202)
	base := candidateTestRow(1, 11, 111, &firstIdentity, importing.IDENTITY_STATE_NEW, baseAmount, "CNY", baseTime)
	base.SourceOrderId = "synthetic-order-a"
	base.RawCounterparty = "synthetic merchant"
	base.RawPaymentMethod = "synthetic channel"
	peer := candidateTestRow(1, 22, 222, &secondIdentity, importing.IDENTITY_STATE_NEW, baseAmount, "CNY", baseTime+60)
	peer.SourceMerchantOrderId = "synthetic-order-a"
	peer.RawCounterparty = "synthetic merchant"
	peer.RawPaymentMethod = "synthetic channel"

	sameEvent, err := evaluateCandidatePair(base, peer)

	if err != nil || sameEvent.suggestedRelationType != DECISION_TYPE_SAME_EVENT {
		t.Fatalf("same-direction evidence did not suggest same_event: %+v %v", sameEvent, err)
	}

	assertCandidateReasonJSONSafe(t, sameEvent.reasonCodesJSON, "synthetic", "order")

	refund := *peer
	refund.NormalizedDirection = importing.NORMALIZED_DIRECTION_INCOME
	refund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	refundPair, err := evaluateCandidatePair(base, &refund)

	if err != nil || refundPair.suggestedRelationType != DECISION_TYPE_REFUND_REVERSAL {
		t.Fatalf("explicit refund evidence did not suggest refund_reversal: %+v %v", refundPair, err)
	}

	transfer := *peer
	transfer.NormalizedDirection = importing.NORMALIZED_DIRECTION_INCOME
	transfer.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_TOP_UP
	transferPair, err := evaluateCandidatePair(base, &transfer)

	if err != nil || transferPair.suggestedRelationType != DECISION_TYPE_INTERNAL_TRANSFER {
		t.Fatalf("opposite transfer evidence did not suggest internal_transfer: %+v %v", transferPair, err)
	}

	wrongAmount := *peer
	otherAmount := baseAmount + 1
	wrongAmount.NormalizedAmount = &otherAmount

	if hardCandidateMatch(base, &wrongAmount) {
		t.Fatalf("different amounts passed the hard candidate filter")
	}

	wrongCurrency := *peer
	wrongCurrency.Currency = "USD"

	if hardCandidateMatch(base, &wrongCurrency) {
		t.Fatalf("different currencies passed the hard candidate filter")
	}

	outsideWindow := *peer
	outsideTime := baseTime + candidateTimeWindowSeconds + 1
	outsideWindow.NormalizedUnixTime = &outsideTime

	if hardCandidateMatch(base, &outsideWindow) {
		t.Fatalf("out-of-window evidence passed the hard candidate filter")
	}
}

func sortCandidateMemberTokens(tokens []candidateMemberToken) {
	sort.Slice(tokens, func(i, j int) bool {
		return candidateMemberTokenLess(tokens[i], tokens[j])
	})
}

func assertCandidateReasonJSONSafe(t *testing.T, encoded string, forbidden ...string) {
	t.Helper()
	reasons := make([]candidateReason, 0)

	if err := json.Unmarshal([]byte(encoded), &reasons); err != nil || len(reasons) < 1 {
		t.Fatalf("candidate reasons were not stable code/numeric JSON: %q %v", encoded, err)
	}

	for _, value := range forbidden {
		if strings.Contains(strings.ToLower(encoded), strings.ToLower(value)) {
			t.Fatalf("candidate reasons leaked evidence text %q: %s", value, encoded)
		}
	}

	for _, reason := range reasons {
		if reason.Code == "" {
			t.Fatalf("candidate reason had an empty stable code: %s", encoded)
		}
	}
}
