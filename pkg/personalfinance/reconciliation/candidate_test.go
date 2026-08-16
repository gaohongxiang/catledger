package reconciliation

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"

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

func TestCandidatePaymentMethodComposesEverbrightLastFour(t *testing.T) {
	baseTime := int64(1_720_000_000)
	baseAmount := int64(10_463)
	firstIdentity := int64(301)
	secondIdentity := int64(302)
	bank := candidateTestRow(1, 31, 311, &firstIdentity, importing.IDENTITY_STATE_NEW, baseAmount, "CNY", baseTime)
	bank.RawPaymentMethod = "末四位2690"
	detail := candidateTestRow(1, 32, 322, &secondIdentity, importing.IDENTITY_STATE_NEW, baseAmount, "CNY", baseTime+13*3600)
	detail.RawPaymentMethod = "光大银行信用卡(2690)"

	matched, err := evaluateCandidatePair(bank, detail)
	if err != nil || !hasCandidateReason(matched.reasonCodesJSON, candidateReasonPaymentMethodMatch) {
		t.Fatalf("composed everbright last-four did not match payment method: %+v %v", matched, err)
	}

	otherBank := *detail
	otherBank.RawPaymentMethod = "兴业银行信用卡(2690)"
	mismatched, err := evaluateCandidatePair(bank, &otherBank)
	if err != nil || hasCandidateReason(mismatched.reasonCodesJSON, candidateReasonPaymentMethodMatch) {
		t.Fatalf("same last four on another bank still matched payment method: %+v %v", mismatched, err)
	}
}

func TestCrossSourceTimeMatchAcceptsDateOnlySameDay(t *testing.T) {
	location := time.FixedZone("cst", 8*3600)
	midnight := time.Date(2026, 6, 26, 0, 0, 0, 0, location).Unix()
	afternoon := time.Date(2026, 6, 26, 13, 9, 23, 0, location).Unix()
	nextMorning := time.Date(2026, 6, 27, 1, 0, 0, 0, location).Unix()
	offset := int16(480)
	firstIdentity := int64(401)
	secondIdentity := int64(402)
	bank := candidateTestRow(1, 41, 411, &firstIdentity, importing.IDENTITY_STATE_NEW, 10463, "CNY", midnight)
	bank.NormalizedTimezoneUtcOffset = &offset
	bank.RawPaymentMethod = "末四位2690"
	bank.RawCounterparty = "财付通 美团平台商户"
	detail := candidateTestRow(1, 42, 422, &secondIdentity, importing.IDENTITY_STATE_NEW, 10463, "CNY", afternoon)
	detail.NormalizedTimezoneUtcOffset = &offset
	detail.RawPaymentMethod = "光大银行信用卡(2690)"
	detail.RawCounterparty = "美团平台商户"

	if !CrossSourceTimeMatch(bank, detail, 48*3600) {
		t.Fatal("date-only credit-card row should match the same civil day")
	}
	if !CrossSourceComparisonMatch(bank, detail, 48*3600) {
		t.Fatal("same merchant, card, amount and civil day should compare")
	}

	detail.NormalizedUnixTime = &nextMorning
	if CrossSourceTimeMatch(bank, detail, 48*3600) {
		t.Fatal("the next calendar day should not match a date-only credit-card row")
	}
}

func TestCrossSourceComparisonMatchRequiresTextAndCard(t *testing.T) {
	baseTime := int64(1_720_000_000)
	firstIdentity := int64(501)
	secondIdentity := int64(502)
	bank := candidateTestRow(1, 51, 511, &firstIdentity, importing.IDENTITY_STATE_NEW, 10463, "CNY", baseTime)
	bank.RawPaymentMethod = "末四位2690"
	bank.RawCounterparty = "网上支付"
	detail := candidateTestRow(1, 52, 522, &secondIdentity, importing.IDENTITY_STATE_NEW, 10463, "CNY", baseTime)
	detail.RawPaymentMethod = "光大银行信用卡(2690)"
	detail.RawCounterparty = "拼多多平台商户"

	if CrossSourceComparisonMatch(bank, detail, candidateTimeWindowSeconds) {
		t.Fatal("different merchant text should not compare as the same purchase")
	}

	detail.RawCounterparty = "网上支付"
	detail.RawPaymentMethod = "兴业银行信用卡(2690)"
	if CrossSourceComparisonMatch(bank, detail, candidateTimeWindowSeconds) {
		t.Fatal("another bank with the same last four should not compare as the same card")
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

func hasCandidateReason(encoded string, code string) bool {
	reasons := make([]candidateReason, 0)
	if err := json.Unmarshal([]byte(encoded), &reasons); err != nil {
		return false
	}
	for _, reason := range reasons {
		if reason.Code == code {
			return true
		}
	}
	return false
}
