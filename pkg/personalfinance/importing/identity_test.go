package importing

import (
	"strings"
	"testing"
)

func TestSourceAccountKeyGolden(t *testing.T) {
	normalized, err := NormalizeSourceAccountIdentifier(SOURCE_TYPE_ALIPAY, "  Test@Example.COM  ")

	if err != nil {
		t.Fatalf("normalize source account identifier: %v", err)
	}

	if normalized != "test@example.com" {
		t.Fatalf("unexpected normalized identifier %q", normalized)
	}

	candidate := SourceAccountCandidate{
		Kind:            SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER,
		Identifier:      normalized,
		DiscoveryMethod: SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
	}
	key, err := ComputeSourceAccountKey(SOURCE_TYPE_ALIPAY, candidate)

	if err != nil {
		t.Fatalf("compute source account key: %v", err)
	}

	const expectedKey = "6a07cc2aba7214cbbbb53c03836c6c2829a0add48604a1f766ccd40328fc5b4a"

	if key != expectedKey {
		t.Fatalf("source account key changed: got %s, expected %s", key, expectedKey)
	}

	displayName, err := SafeSourceAccountDisplayName(SOURCE_TYPE_ALIPAY, candidate)

	if err != nil || displayName != "t***@e******.com" || strings.Contains(displayName, normalized) {
		t.Fatalf("unexpected safe source account display name %q: %v", displayName, err)
	}

	masked := SourceAccountCandidate{
		Kind:            SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY,
		DisplayName:     "138****0000",
		DiscoveryMethod: SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
	}

	if _, err = ComputeSourceAccountKey(SOURCE_TYPE_ALIPAY, masked); err == nil {
		t.Fatal("masked source account identifier was accepted")
	}

	unstableIdentifiers := []string{"尾号1234", "138xxxx0000", "13xx00", "xxxx", "xx", "1234", "1234567890123456"}

	for _, identifier := range unstableIdentifiers {
		unstable := candidate
		unstable.Identifier = identifier

		if _, err = ComputeSourceAccountKey(SOURCE_TYPE_ALIPAY, unstable); err == nil {
			t.Fatalf("unstable source account identifier %q was accepted", identifier)
		}
	}

	unsafeDisplay := candidate
	unsafeDisplay.DisplayName = normalized

	if err = unsafeDisplay.Validate(SOURCE_TYPE_ALIPAY); err == nil {
		t.Fatal("parser-provided stable account display name was accepted")
	}

	maskedWithPlaintext := masked
	maskedWithPlaintext.DisplayName = "alice@example.com 尾号1234"
	displayName, err = SafeSourceAccountDisplayName(SOURCE_TYPE_ALIPAY, maskedWithPlaintext)

	if err != nil || displayName != "***1234" || strings.Contains(displayName, "alice") {
		t.Fatalf("masked display leaked plaintext: %q %v", displayName, err)
	}

	fullPhone, err := NormalizeSourceAccountIdentifier(SOURCE_TYPE_ALIPAY, "12345678")

	if err != nil || fullPhone != "12345678" {
		t.Fatalf("frozen minimum-length phone was rejected: %q %v", fullPhone, err)
	}

	wechatNickname := SourceAccountCandidate{
		Kind:            SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY,
		DisplayName:     "微信昵称",
		DiscoveryMethod: SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME,
	}

	if _, err = ComputeSourceAccountKey(SOURCE_TYPE_WECHAT, wechatNickname); err == nil {
		t.Fatal("WeChat display name was accepted as a stable account identifier")
	}

	displayName, err = SafeSourceAccountDisplayName(SOURCE_TYPE_WECHAT, wechatNickname)

	if err != nil || displayName != "微**称" {
		t.Fatalf("unexpected safe WeChat display name %q: %v", displayName, err)
	}
}

func TestIdentityAndCoreDigestGolden(t *testing.T) {
	unixTime := int64(1720000000)
	amount := int64(1234)
	normalized := NormalizedEvidence{
		UnixTime:          &unixTime,
		TimezoneUtcOffset: 480,
		Amount:            &amount,
		Currency:          "CNY",
		Direction:         NORMALIZED_DIRECTION_EXPENSE,
		TransactionType:   SOURCE_TRANSACTION_TYPE_PAYMENT,
		EconomicEffect:    ECONOMIC_EFFECT_NORMAL,
	}
	input := IdentityBuildInput{
		ParseState:       PARSE_STATE_VALID,
		SourceType:       SOURCE_TYPE_ALIPAY,
		SourceAccountKey: "6a07cc2aba7214cbbbb53c03836c6c2829a0add48604a1f766ccd40328fc5b4a",
		BatchId:          10,
		RowNumber:        2,
		Identifiers: SourceIdentifiers{
			TransactionId: " tx-001 ",
			OrderId:       "ignored-order",
		},
		Normalized: normalized,
	}

	candidate, err := BuildIdentityCandidate(input)

	if err != nil {
		t.Fatalf("build identity candidate: %v", err)
	}

	if candidate.Kind != IDENTITY_KIND_SOURCE_TRANSACTION_ID {
		t.Fatalf("unexpected identity kind %s", candidate.Kind)
	}

	const expectedIdentityKey = "e95ec0828253ff2db2a17423bbc71b859189c61df8cacd38b42e9943c234b469"
	const expectedCoreDigest = "cafa2ce58846bc916f556933807838bc9b7ef94195d8823b9756ed345f71c7ed"

	if candidate.SourceIdentityKey != expectedIdentityKey {
		t.Fatalf("identity key changed: got %s, expected %s", candidate.SourceIdentityKey, expectedIdentityKey)
	}

	if candidate.SourceCoreDigest != expectedCoreDigest {
		t.Fatalf("core digest changed: got %s, expected %s", candidate.SourceCoreDigest, expectedCoreDigest)
	}

	changedCategory := normalized
	changedCategory.TransactionType = SOURCE_TRANSACTION_TYPE_OTHER
	categoryDigest, err := ComputeSourceCoreDigest(changedCategory)

	if err != nil {
		t.Fatalf("compute core digest with another source category: %v", err)
	}

	if categoryDigest != expectedCoreDigest {
		t.Fatal("unstable source transaction category entered core-digest-v1")
	}

	refund := normalized
	refund.EconomicEffect = ECONOMIC_EFFECT_REFUND
	refundDigest, err := ComputeSourceCoreDigest(refund)

	if err != nil {
		t.Fatalf("compute refund core digest: %v", err)
	}

	if refundDigest == expectedCoreDigest {
		t.Fatal("economic effect did not change core digest")
	}
}

func TestBankIdentityUsesFrozenV1Encoding(t *testing.T) {
	unixin, amount := int64(1720000000), int64(1234)
	candidate, err := BuildIdentityCandidate(IdentityBuildInput{
		ParseState: PARSE_STATE_VALID, SourceType: SOURCE_TYPE_BANK, SourceAccountKey: strings.Repeat("a", 64), BatchId: 1, RowNumber: 1,
		Identifiers: SourceIdentifiers{TransactionId: "bank-txn-1"},
		Normalized:  NormalizedEvidence{UnixTime: &unixin, TimezoneUtcOffset: 480, Amount: &amount, Currency: "CNY", Direction: NORMALIZED_DIRECTION_EXPENSE, TransactionType: SOURCE_TRANSACTION_TYPE_OTHER, EconomicEffect: ECONOMIC_EFFECT_NORMAL},
	})
	if err != nil || candidate == nil || candidate.IdentityKeyVersion != IDENTITY_KEY_VERSION_V1 || candidate.CoreDigestVersion != CORE_DIGEST_VERSION_V1 {
		t.Fatalf("bank identity did not reuse frozen v1 semantics: %+v %v", candidate, err)
	}
}

func TestIdentityPriorityAndInvalidRows(t *testing.T) {
	unixTime := int64(1720000000)
	amount := int64(1)
	base := IdentityBuildInput{
		ParseState:       PARSE_STATE_VALID,
		SourceType:       SOURCE_TYPE_WECHAT,
		SourceAccountKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		BatchId:          8,
		RowNumber:        3,
		Normalized: NormalizedEvidence{
			UnixTime:          &unixTime,
			TimezoneUtcOffset: 480,
			Amount:            &amount,
			Currency:          "CNY",
			Direction:         NORMALIZED_DIRECTION_EXPENSE,
			TransactionType:   SOURCE_TRANSACTION_TYPE_PAYMENT,
			EconomicEffect:    ECONOMIC_EFFECT_NORMAL,
		},
	}

	tests := []struct {
		name        string
		input       IdentityBuildInput
		kind        IdentityKind
		expectedKey string
	}{
		{
			name: "order combination",
			input: func() IdentityBuildInput {
				input := base
				input.Identifiers = SourceIdentifiers{OrderId: "order", MerchantOrderId: "merchant"}
				input.FingerprintMaterials = StrongFingerprintMaterials{Counterparty: "merchant", Item: "item"}
				return input
			}(),
			kind:        IDENTITY_KIND_ORDER_COMBINATION,
			expectedKey: "38701218cebb2d86fa7d842a2cb2d99ffcf0b98aa05b755d52b26a3e2aa00be1",
		},
		{
			name: "strong fingerprint",
			input: func() IdentityBuildInput {
				input := base
				input.FingerprintMaterials = StrongFingerprintMaterials{Counterparty: "merchant", Item: "item"}
				return input
			}(),
			kind:        IDENTITY_KIND_STRONG_FINGERPRINT,
			expectedKey: "196ab13ecb5bd8f4b0fd9a34b9ab0c9860b58e5b19f06f636624ada0b5c61659",
		},
		{
			name:        "batch local",
			input:       base,
			kind:        IDENTITY_KIND_BATCH_LOCAL,
			expectedKey: "8a821c6d689e2a75eb89eed10536b3a7342cf4aaff99b4bc2eba89b1a43609f4",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate, err := BuildIdentityCandidate(test.input)

			if err != nil {
				t.Fatalf("build identity candidate: %v", err)
			}

			if candidate.Kind != test.kind || candidate.SourceIdentityKey != test.expectedKey {
				t.Fatalf("identity golden changed: candidate=%+v expected kind=%s key=%s", candidate, test.kind, test.expectedKey)
			}
		})
	}

	oneOrderOnly := base
	oneOrderOnly.Identifiers = SourceIdentifiers{OrderId: "order"}
	assertIdentityKind(t, oneOrderOnly, IDENTITY_KIND_BATCH_LOCAL)

	maskedTransaction := base
	maskedTransaction.Identifiers = SourceIdentifiers{TransactionId: "tx****001"}
	assertIdentityKind(t, maskedTransaction, IDENTITY_KIND_BATCH_LOCAL)

	nextRow := base
	nextRow.RowNumber = 4
	nextCandidate, err := BuildIdentityCandidate(nextRow)

	if err != nil || nextCandidate.SourceIdentityKey != "8c8030d99ceb3f6e6757b9bf1b220ee1ac9072888184866d38395b43e32e08f5" ||
		nextCandidate.SourceIdentityKey == tests[2].expectedKey {
		t.Fatalf("same-amount batch-local rows were collapsed: candidate=%+v err=%v", nextCandidate, err)
	}

	invalid := IdentityBuildInput{ParseState: PARSE_STATE_INVALID}
	candidate, err := BuildIdentityCandidate(invalid)

	if err != nil || candidate != nil {
		t.Fatalf("invalid row should not get an identity: candidate=%+v err=%v", candidate, err)
	}
}

func TestResolveImportDispositionMatrix(t *testing.T) {
	tests := []struct {
		name            string
		parseState      ParseState
		eligibility     SemanticEligibility
		identityState   IdentityState
		hasExistingLink bool
		disposition     ImportDisposition
		processing      ProcessingState
	}{
		{"invalid", PARSE_STATE_INVALID, SEMANTIC_ELIGIBILITY_NON_POSTABLE, IDENTITY_STATE_NOT_EVALUATED, false, IMPORT_DISPOSITION_NON_POSTABLE, PROCESSING_STATE_IGNORED},
		{"new postable", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_NEW, false, IMPORT_DISPOSITION_POSTABLE, PROCESSING_STATE_PENDING},
		{"new non-postable", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_NON_POSTABLE, IDENTITY_STATE_NEW, false, IMPORT_DISPOSITION_NON_POSTABLE, PROCESSING_STATE_IGNORED},
		{"identity conflict", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_IDENTITY_CONFLICT, false, IMPORT_DISPOSITION_REVIEW_REQUIRED, PROCESSING_STATE_PENDING},
		{"batch local", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_BATCH_LOCAL, false, IMPORT_DISPOSITION_REVIEW_REQUIRED, PROCESSING_STATE_PENDING},
		{"duplicate linked", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_EXACT_DUPLICATE, true, IMPORT_DISPOSITION_NON_POSTABLE, PROCESSING_STATE_LINKED},
		{"duplicate unlinked", PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_EXACT_DUPLICATE, false, IMPORT_DISPOSITION_REVIEW_REQUIRED, PROCESSING_STATE_PENDING},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome, err := ResolveImportDisposition(test.parseState, test.eligibility, test.identityState, test.hasExistingLink)

			if err != nil {
				t.Fatalf("resolve disposition: %v", err)
			}

			if outcome.Disposition != test.disposition || outcome.ProcessingState != test.processing {
				t.Fatalf("unexpected outcome: %+v", outcome)
			}
		})
	}

	invalidCombinations := []struct {
		parseState      ParseState
		eligibility     SemanticEligibility
		identityState   IdentityState
		hasExistingLink bool
	}{
		{PARSE_STATE_INVALID, "", IDENTITY_STATE_NOT_EVALUATED, false},
		{PARSE_STATE_INVALID, SEMANTIC_ELIGIBILITY_NON_POSTABLE, IDENTITY_STATE_NEW, false},
		{PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_NOT_EVALUATED, false},
		{PARSE_STATE_VALID, SEMANTIC_ELIGIBILITY_POSTABLE, IDENTITY_STATE_NEW, true},
	}

	for _, combination := range invalidCombinations {
		if _, err := ResolveImportDisposition(combination.parseState, combination.eligibility, combination.identityState, combination.hasExistingLink); err == nil {
			t.Fatalf("invalid row state combination was accepted: %+v", combination)
		}
	}
}

func TestResolveSemanticEligibilityMatrix(t *testing.T) {
	unixTime := int64(1720000000)
	amount := int64(1)
	base := NormalizedEvidence{
		UnixTime:          &unixTime,
		TimezoneUtcOffset: 480,
		Amount:            &amount,
		Currency:          "CNY",
		Direction:         NORMALIZED_DIRECTION_EXPENSE,
		TransactionType:   SOURCE_TRANSACTION_TYPE_PAYMENT,
		EconomicEffect:    ECONOMIC_EFFECT_NORMAL,
	}
	tests := []struct {
		name        string
		parseState  ParseState
		normalized  NormalizedEvidence
		eligibility SemanticEligibility
	}{
		{"invalid", PARSE_STATE_INVALID, NormalizedEvidence{}, SEMANTIC_ELIGIBILITY_NON_POSTABLE},
		{"normal", PARSE_STATE_VALID, base, SEMANTIC_ELIGIBILITY_POSTABLE},
		{"refund", PARSE_STATE_VALID, withEconomicEffect(base, ECONOMIC_EFFECT_REFUND), SEMANTIC_ELIGIBILITY_POSTABLE},
		{"closed", PARSE_STATE_VALID, withEconomicEffect(base, ECONOMIC_EFFECT_CLOSED), SEMANTIC_ELIGIBILITY_NON_POSTABLE},
		{"failed", PARSE_STATE_VALID, withEconomicEffect(base, ECONOMIC_EFFECT_FAILED), SEMANTIC_ELIGIBILITY_NON_POSTABLE},
		{"unknown effect", PARSE_STATE_VALID, withEconomicEffect(base, ECONOMIC_EFFECT_UNKNOWN), SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED},
		{"unknown direction", PARSE_STATE_VALID, withDirection(base, NORMALIZED_DIRECTION_UNKNOWN), SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED},
		{"neutral direction", PARSE_STATE_VALID, withDirection(base, NORMALIZED_DIRECTION_NEUTRAL), SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED},
		{"unknown type", PARSE_STATE_VALID, withTransactionType(base, SOURCE_TRANSACTION_TYPE_UNKNOWN), SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			eligibility, err := ResolveSemanticEligibility(test.parseState, test.normalized)

			if err != nil || eligibility != test.eligibility {
				t.Fatalf("unexpected eligibility %s: %v", eligibility, err)
			}
		})
	}
}

func withEconomicEffect(value NormalizedEvidence, effect EconomicEffect) NormalizedEvidence {
	value.EconomicEffect = effect
	return value
}

func withDirection(value NormalizedEvidence, direction NormalizedDirection) NormalizedEvidence {
	value.Direction = direction
	return value
}

func withTransactionType(value NormalizedEvidence, transactionType SourceTransactionType) NormalizedEvidence {
	value.TransactionType = transactionType
	return value
}

func assertIdentityKind(t *testing.T, input IdentityBuildInput, expected IdentityKind) {
	t.Helper()
	candidate, err := BuildIdentityCandidate(input)

	if err != nil {
		t.Fatalf("build identity candidate: %v", err)
	}

	if candidate.Kind != expected {
		t.Fatalf("identity kind is %s, expected %s", candidate.Kind, expected)
	}
}
