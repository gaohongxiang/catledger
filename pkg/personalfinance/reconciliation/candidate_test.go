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
	bank.RawCounterparty = "支付宝 持卡人"
	detail.RawCounterparty = "拼多多平台商户"
	if !CrossSourceComparisonMatch(bank, detail, 48*3600) {
		t.Fatal("date-only card gateway row should not require the generic holder text to equal the detailed merchant")
	}

	detail.NormalizedUnixTime = &nextMorning
	if CrossSourceTimeMatch(bank, detail, 48*3600) {
		t.Fatal("the next calendar day should not match a date-only credit-card row")
	}
	detail.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	if !CrossSourceTimeMatch(bank, detail, 48*3600) {
		t.Fatal("a refund may appear on the next credit-card posting day inside the explicit window")
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

func TestDateOnlyStatementOccurrencesUseRawRowMembers(t *testing.T) {
	location := time.FixedZone("cst", 8*3600)
	midnight := time.Date(2026, 7, 6, 0, 0, 0, 0, location).Unix()
	afternoon := time.Date(2026, 7, 6, 10, 50, 0, 0, location).Unix()
	sharedBankIdentity := int64(801)
	detailIdentity := int64(901)
	bankA := candidateTestRow(1, 81, 811, &sharedBankIdentity, importing.IDENTITY_STATE_NEW, 4350, "CNY", midnight)
	bankB := candidateTestRow(1, 82, 811, &sharedBankIdentity, importing.IDENTITY_STATE_EXACT_DUPLICATE, 4350, "CNY", midnight)
	detail := candidateTestRow(1, 91, 911, &detailIdentity, importing.IDENTITY_STATE_NEW, 4350, "CNY", afternoon)
	for _, bank := range []*importing.RawImportRow{bankA, bankB} {
		bank.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_OTHER
		bank.RawCounterparty = "支付宝 持卡人"
		bank.RawPaymentMethod = "末四位2690"
	}
	detail.RawCounterparty = "详细商户"
	detail.RawPaymentMethod = "光大银行信用卡(2690)"

	first, err := evaluateCandidatePair(bankA, detail)
	if err != nil {
		t.Fatalf("evaluate first statement occurrence: %v", err)
	}
	second, err := evaluateCandidatePair(bankB, detail)
	if err != nil {
		t.Fatalf("evaluate second statement occurrence: %v", err)
	}
	if first.caseKey == second.caseKey || first.members[0] == second.members[0] && first.members[1] == second.members[1] {
		t.Fatalf("two physical statement rows sharing a fingerprint collapsed into one candidate: first=%+v second=%+v", first.members, second.members)
	}
	for _, evaluation := range []*candidateEvaluation{first, second} {
		foundRawStatement := false
		for _, member := range evaluation.members {
			if member.kind == MEMBER_KIND_RAW_ROW && (member.refId == bankA.RowId || member.refId == bankB.RowId) {
				foundRawStatement = true
			}
		}
		if !foundRawStatement {
			t.Fatalf("date-only statement occurrence did not use a raw-row member: %+v", evaluation.members)
		}
	}
}

func TestExplicitPartialRefundMatchesStatusAmountMerchantAndOrder(t *testing.T) {
	baseTime := int64(1_720_000_000)
	originalIdentity := int64(1001)
	refundIdentity := int64(1002)
	original := candidateTestRow(1, 101, 10001, &originalIdentity, importing.IDENTITY_STATE_NEW, 5927, "CNY", baseTime)
	refund := candidateTestRow(1, 102, 10001, &refundIdentity, importing.IDENTITY_STATE_NEW, 15, "CNY", baseTime+1105)
	original.NormalizedDirection = importing.NORMALIZED_DIRECTION_EXPENSE
	refund.NormalizedDirection = importing.NORMALIZED_DIRECTION_INCOME
	original.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	refund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	original.RawCounterparty = "美团平台商户"
	refund.RawCounterparty = "美团平台商户"
	original.RawStatus = "已退款(¥0.15)"
	refund.RawStatus = "已退款¥0.15"

	if !ExplicitSourceRefundMatch(original, refund) {
		t.Fatal("explicit partial refund did not match its original transaction")
	}
	evaluation, err := evaluateSourceRefundPair(original, refund)
	if err != nil || evaluation.suggestedRelationType != DECISION_TYPE_REFUND_REVERSAL {
		t.Fatalf("explicit refund candidate: %+v err=%v", evaluation, err)
	}
	wrongAmount := *refund
	amount := int64(20)
	wrongAmount.NormalizedAmount = &amount
	if ExplicitSourceRefundMatch(original, &wrongAmount) {
		t.Fatal("refund amount different from the explicit source status was accepted")
	}
	wrongMerchant := *refund
	wrongMerchant.RawCounterparty = "另一商户"
	if ExplicitSourceRefundMatch(original, &wrongMerchant) {
		t.Fatal("refund from another merchant was accepted")
	}
}

func TestCrossSourceComparisonMatchAcceptsMappedLedgerAccount(t *testing.T) {
	baseTime := int64(1_720_000_000)
	firstIdentity := int64(701)
	secondIdentity := int64(702)
	accountId := int64(61)
	bank := candidateTestRow(1, 71, 711, &firstIdentity, importing.IDENTITY_STATE_NEW, 11970, "CNY", baseTime)
	bank.RawPaymentMethod = "末四位2690"
	bank.RawCounterparty = "支付宝 拼多多平台商户"
	detail := candidateTestRow(1, 72, 722, &secondIdentity, importing.IDENTITY_STATE_NEW, 11970, "CNY", baseTime)
	detail.RawPaymentMethod = "中国光大银行信用卡(2690)"
	detail.RawCounterparty = "拼多多平台商户"

	if CrossSourceSameCard(bank, detail) {
		t.Fatal("unmapped 中国光大 vs 末四位 should not compare as the same card by name alone")
	}
	if CrossSourceComparisonMatch(bank, detail, candidateTimeWindowSeconds) {
		t.Fatal("unmapped different payment strings should not auto-compare")
	}

	bank.LedgerAccountId = &accountId
	detail.LedgerAccountId = &accountId
	if !CrossSourceSameCard(bank, detail) || !CrossSourceComparisonMatch(bank, detail, candidateTimeWindowSeconds) {
		t.Fatal("rows already mapped to the same ledger account should count as the same card")
	}

	otherAccount := int64(62)
	detail.LedgerAccountId = &otherAccount
	if CrossSourceSameCard(bank, detail) {
		t.Fatal("mapped to different ledger accounts should not count as the same card")
	}
}

func TestEvidenceTextSimilarStripsPaymentChannelAndIgnoresOrderItem(t *testing.T) {
	baseTime := int64(1_720_000_000)
	firstIdentity := int64(601)
	secondIdentity := int64(602)
	bank := candidateTestRow(1, 61, 611, &firstIdentity, importing.IDENTITY_STATE_NEW, 11970, "CNY", baseTime)
	bank.RawPaymentMethod = "末四位2690"
	bank.RawCounterparty = "支付宝 拼多多平台商户"
	bank.RawItem = ""
	detail := candidateTestRow(1, 62, 622, &secondIdentity, importing.IDENTITY_STATE_NEW, 11970, "CNY", baseTime)
	detail.RawPaymentMethod = "光大银行信用卡(2690)"
	detail.RawCounterparty = "拼多多平台商户"
	detail.RawItem = "商户单号XP2426071515101977652240001287"
	detail.SourceMerchantOrderId = "XP2426071515101977652240001287"

	if !evidenceTextSimilar(bank, detail) {
		t.Fatal("bank channel prefix and merchant should still match alipay counterparty")
	}
	if !CrossSourceComparisonMatch(bank, detail, candidateTimeWindowSeconds) {
		t.Fatal("pinduoduo bank/alipay pair should auto-compare")
	}

	detail.RawItem = "收纳盒套装"
	if !evidenceTextSimilar(bank, detail) {
		t.Fatalf("distinct item should not block counterparty containment: bank=%q alipay=%q", comparableEvidenceText(bank), comparableEvidenceText(detail))
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
