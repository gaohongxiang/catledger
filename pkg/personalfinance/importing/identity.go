package importing

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// IdentityBuildInput 是中心身份构造器的唯一输入。
type IdentityBuildInput struct {
	ParseState           ParseState
	SourceType           SourceType
	SourceAccountKey     string
	BatchId              int64
	RowNumber            int64
	Identifiers          SourceIdentifiers
	Normalized           NormalizedEvidence
	FingerprintMaterials StrongFingerprintMaterials
}

// IdentityCandidate 是可写入来源身份表并用于冲突比较的中心结果。
type IdentityCandidate struct {
	Kind               IdentityKind
	SourceIdentityKey  string
	SourceCoreDigest   string
	IdentityKeyVersion RuleVersion
	CoreDigestVersion  RuleVersion
	FingerprintVersion RuleVersion
}

// RowOutcome 是 parser 语义、身份结果和既有关系共同决定的持久状态。
type RowOutcome struct {
	Disposition     ImportDisposition
	ProcessingState ProcessingState
}

// BuildIdentityCandidate 统一选择身份优先级、编码 key 并计算核心摘要。
// invalid 行返回 nil；调用方应持久化 identity_state=not_evaluated。
func BuildIdentityCandidate(input IdentityBuildInput) (*IdentityCandidate, error) {
	if input.ParseState == PARSE_STATE_INVALID {
		return nil, nil
	}

	if input.ParseState != PARSE_STATE_VALID {
		return nil, fmt.Errorf("invalid parse state")
	}

	if err := validateNormalizedEvidence(input.Normalized); err != nil {
		return nil, err
	}

	if input.SourceType != SOURCE_TYPE_ALIPAY && input.SourceType != SOURCE_TYPE_WECHAT {
		return nil, fmt.Errorf("invalid source type")
	}

	if !isLowerHexSHA256(input.SourceAccountKey) {
		return nil, fmt.Errorf("invalid source account key")
	}

	transactionId := normalizeStableIdentityIdentifier(input.Identifiers.TransactionId)
	orderId := normalizeStableIdentityIdentifier(input.Identifiers.OrderId)
	merchantOrderId := normalizeStableIdentityIdentifier(input.Identifiers.MerchantOrderId)

	kind := IDENTITY_KIND_BATCH_LOCAL
	identityParts := []string(nil)

	if transactionId != "" {
		kind = IDENTITY_KIND_SOURCE_TRANSACTION_ID
		identityParts = []string{transactionId}
	} else if orderId != "" && merchantOrderId != "" {
		kind = IDENTITY_KIND_ORDER_COMBINATION
		identityParts = []string{orderId, merchantOrderId}
	} else if hasStrongFingerprint(input) {
		kind = IDENTITY_KIND_STRONG_FINGERPRINT
		identityParts = strongFingerprintParts(input)
	} else {
		if input.BatchId < 1 || input.RowNumber < 1 {
			return nil, fmt.Errorf("batch-local identity requires positive batch and row numbers")
		}

		identityParts = []string{strconv.FormatInt(input.BatchId, 10), strconv.FormatInt(input.RowNumber, 10)}
	}

	keyValues := []string{
		string(IDENTITY_KEY_VERSION_V1),
		string(input.SourceType),
		input.SourceAccountKey,
		string(kind),
	}
	keyValues = append(keyValues, identityParts...)
	keyDigest := sha256.Sum256(encodeLengthPrefixed(keyValues...))

	coreDigest, err := ComputeSourceCoreDigest(input.Normalized)

	if err != nil {
		return nil, err
	}

	return &IdentityCandidate{
		Kind:               kind,
		SourceIdentityKey:  hex.EncodeToString(keyDigest[:]),
		SourceCoreDigest:   coreDigest,
		IdentityKeyVersion: IDENTITY_KEY_VERSION_V1,
		CoreDigestVersion:  CORE_DIGEST_VERSION_V1,
		FingerprintVersion: FINGERPRINT_VERSION_V1,
	}, nil
}

// ComputeSourceCoreDigest 计算来源身份的 v1 经济语义摘要。
// v1 只包含非负金额、币种、来源方向和经济效果；来源交易分类不够跨格式稳定，不进入摘要。
func ComputeSourceCoreDigest(normalized NormalizedEvidence) (string, error) {
	if err := validateNormalizedEvidence(normalized); err != nil {
		return "", err
	}

	values := []string{
		string(CORE_DIGEST_VERSION_V1),
		strconv.FormatInt(*normalized.Amount, 10),
		normalized.Currency,
		string(normalized.Direction),
		string(normalized.EconomicEffect),
	}
	digest := sha256.Sum256(encodeLengthPrefixed(values...))
	return hex.EncodeToString(digest[:]), nil
}

// ResolveImportDisposition 计算最终处置与初始处理状态。
func ResolveImportDisposition(parseState ParseState, eligibility SemanticEligibility, identityState IdentityState, hasExistingLink bool) (RowOutcome, error) {
	if parseState == PARSE_STATE_INVALID {
		if eligibility != SEMANTIC_ELIGIBILITY_NON_POSTABLE || identityState != IDENTITY_STATE_NOT_EVALUATED || hasExistingLink {
			return RowOutcome{}, fmt.Errorf("invalid row state combination")
		}

		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_NON_POSTABLE,
			ProcessingState: PROCESSING_STATE_IGNORED,
		}, nil
	}

	if parseState != PARSE_STATE_VALID {
		return RowOutcome{}, fmt.Errorf("invalid parse state")
	}

	switch eligibility {
	case SEMANTIC_ELIGIBILITY_POSTABLE, SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, SEMANTIC_ELIGIBILITY_NON_POSTABLE:
	default:
		return RowOutcome{}, fmt.Errorf("invalid semantic eligibility")
	}

	if identityState == IDENTITY_STATE_NOT_EVALUATED {
		return RowOutcome{}, fmt.Errorf("valid row identity was not evaluated")
	}

	if identityState == IDENTITY_STATE_IDENTITY_CONFLICT || identityState == IDENTITY_STATE_BATCH_LOCAL {
		if hasExistingLink {
			return RowOutcome{}, fmt.Errorf("identity state cannot have an existing link")
		}

		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_REVIEW_REQUIRED,
			ProcessingState: PROCESSING_STATE_PENDING,
		}, nil
	}

	if identityState == IDENTITY_STATE_EXACT_DUPLICATE {
		if hasExistingLink {
			return RowOutcome{
				Disposition:     IMPORT_DISPOSITION_NON_POSTABLE,
				ProcessingState: PROCESSING_STATE_LINKED,
			}, nil
		}

		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_REVIEW_REQUIRED,
			ProcessingState: PROCESSING_STATE_PENDING,
		}, nil
	}

	if identityState != IDENTITY_STATE_NEW {
		return RowOutcome{}, fmt.Errorf("invalid identity state")
	}

	if hasExistingLink {
		return RowOutcome{}, fmt.Errorf("new identity cannot have an existing link")
	}

	switch eligibility {
	case SEMANTIC_ELIGIBILITY_POSTABLE:
		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_POSTABLE,
			ProcessingState: PROCESSING_STATE_PENDING,
		}, nil
	case SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED:
		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_REVIEW_REQUIRED,
			ProcessingState: PROCESSING_STATE_PENDING,
		}, nil
	case SEMANTIC_ELIGIBILITY_NON_POSTABLE:
		return RowOutcome{
			Disposition:     IMPORT_DISPOSITION_NON_POSTABLE,
			ProcessingState: PROCESSING_STATE_IGNORED,
		}, nil
	}

	return RowOutcome{}, fmt.Errorf("invalid semantic eligibility")
}

// ResolveSemanticEligibility 根据来源中性语义给出跨解析器一致的最低处置要求。
// parser 负责把来源状态映射为 NormalizedEvidence，不得绕过此函数自行放宽资格。
func ResolveSemanticEligibility(parseState ParseState, normalized NormalizedEvidence) (SemanticEligibility, error) {
	if parseState == PARSE_STATE_INVALID {
		return SEMANTIC_ELIGIBILITY_NON_POSTABLE, nil
	}

	if parseState != PARSE_STATE_VALID {
		return "", fmt.Errorf("invalid parse state")
	}

	if err := validateNormalizedEvidence(normalized); err != nil {
		return "", err
	}

	if normalized.EconomicEffect == ECONOMIC_EFFECT_CLOSED || normalized.EconomicEffect == ECONOMIC_EFFECT_FAILED {
		return SEMANTIC_ELIGIBILITY_NON_POSTABLE, nil
	}

	if normalized.EconomicEffect == ECONOMIC_EFFECT_UNKNOWN ||
		normalized.Direction == NORMALIZED_DIRECTION_UNKNOWN ||
		normalized.Direction == NORMALIZED_DIRECTION_NEUTRAL ||
		normalized.TransactionType == SOURCE_TRANSACTION_TYPE_UNKNOWN {
		return SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, nil
	}

	if (normalized.EconomicEffect == ECONOMIC_EFFECT_NORMAL || normalized.EconomicEffect == ECONOMIC_EFFECT_REFUND) &&
		(normalized.Direction == NORMALIZED_DIRECTION_INCOME || normalized.Direction == NORMALIZED_DIRECTION_EXPENSE) {
		return SEMANTIC_ELIGIBILITY_POSTABLE, nil
	}

	return SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, nil
}

func validateNormalizedEvidence(normalized NormalizedEvidence) error {
	if normalized.UnixTime == nil || *normalized.UnixTime < 1 {
		return fmt.Errorf("normalized Unix time is required")
	}

	if normalized.Amount == nil || *normalized.Amount < 0 {
		return fmt.Errorf("normalized amount must be non-negative")
	}

	options := ResolvedParseOptions{
		Currency:          normalized.Currency,
		TimezoneUtcOffset: normalized.TimezoneUtcOffset,
	}

	if err := options.Validate(); err != nil {
		return err
	}

	switch normalized.Direction {
	case NORMALIZED_DIRECTION_INCOME, NORMALIZED_DIRECTION_EXPENSE, NORMALIZED_DIRECTION_NEUTRAL, NORMALIZED_DIRECTION_UNKNOWN:
	default:
		return fmt.Errorf("invalid normalized direction")
	}

	switch normalized.EconomicEffect {
	case ECONOMIC_EFFECT_NORMAL, ECONOMIC_EFFECT_REFUND, ECONOMIC_EFFECT_CLOSED, ECONOMIC_EFFECT_FAILED, ECONOMIC_EFFECT_UNKNOWN:
	default:
		return fmt.Errorf("invalid economic effect")
	}

	switch normalized.TransactionType {
	case SOURCE_TRANSACTION_TYPE_PAYMENT,
		SOURCE_TRANSACTION_TYPE_TRANSFER,
		SOURCE_TRANSACTION_TYPE_TOP_UP,
		SOURCE_TRANSACTION_TYPE_WITHDRAWAL,
		SOURCE_TRANSACTION_TYPE_FEE,
		SOURCE_TRANSACTION_TYPE_OTHER,
		SOURCE_TRANSACTION_TYPE_UNKNOWN:
	default:
		return fmt.Errorf("invalid source transaction type")
	}

	return nil
}

func hasStrongFingerprint(input IdentityBuildInput) bool {
	return normalizeIdentifier(input.FingerprintMaterials.Counterparty) != "" &&
		(normalizeIdentifier(input.FingerprintMaterials.Item) != "" || normalizeIdentifier(input.FingerprintMaterials.PaymentMethod) != "")
}

func strongFingerprintParts(input IdentityBuildInput) []string {
	return []string{
		string(FINGERPRINT_VERSION_V1),
		strconv.FormatInt(*input.Normalized.UnixTime, 10),
		strconv.FormatInt(*input.Normalized.Amount, 10),
		input.Normalized.Currency,
		string(input.Normalized.Direction),
		string(input.Normalized.EconomicEffect),
		normalizeIdentifier(input.FingerprintMaterials.Counterparty),
		normalizeIdentifier(input.FingerprintMaterials.Item),
		normalizeIdentifier(input.FingerprintMaterials.PaymentMethod),
	}
}

func normalizeStableIdentityIdentifier(value string) string {
	value = normalizeIdentifier(value)

	if looksMasked(value) {
		return ""
	}

	return value
}

func isLowerHexSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}

	_, err := hex.DecodeString(value)
	return err == nil
}
