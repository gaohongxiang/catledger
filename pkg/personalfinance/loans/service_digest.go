package loans

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"strings"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans/calculation"
)

func normalizeCalculationTerms(terms CalculationTerms) (CalculationTerms, calculation.Input, error) {
	if !isCivilDate(terms.EffectiveDate) || !isCivilDate(terms.ContractDate) || !isCivilDate(terms.FirstDueDate) ||
		!isFundingType(terms.FundingType) {
		return CalculationTerms{}, calculation.Input{}, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	input := calculationInput(terms)
	if err := calculation.ValidateInput(input); err != nil {
		return CalculationTerms{}, calculation.Input{}, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	terms.PaymentBasisAmount = cloneInt64(terms.PaymentBasisAmount)
	terms.QuotedRatePptr = cloneInt64(terms.QuotedRatePptr)
	terms.DiscountRatePptr = cloneInt64(terms.DiscountRatePptr)
	return terms, input, nil
}

func normalizeContractSpec(spec ContractSpec) (ContractSpec, calculation.Input, error) {
	if spec.LiabilityAccountId < 1 || !isNilOrPositive(spec.DefaultPaymentAccountId) ||
		!isContractType(spec.ContractType) || !validSensitiveText(spec.Name, maximumContractNameCharacters, true) ||
		!validSensitiveText(spec.LenderName, maximumLenderNameCharacters, false) || !validSensitiveText(spec.Note, maximumContractNoteCharacters, false) ||
		!isCurrencyCode(spec.Currency) {
		return ContractSpec{}, calculation.Input{}, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	terms, input, err := normalizeCalculationTerms(spec.Terms)
	if err != nil {
		return ContractSpec{}, calculation.Input{}, err
	}
	spec.DefaultPaymentAccountId = cloneInt64(spec.DefaultPaymentAccountId)
	spec.Terms = terms
	return spec, input, nil
}

func validateIdempotencyKey(value string) error {
	if len(value) < minimumServiceIdempotencyKeyBytes || len(value) > maximumServiceIdempotencyKeyBytes || !utf8.ValidString(value) {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	for _, char := range []byte(value) {
		if char < 0x21 || char > 0x7e {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
	}
	return nil
}

func validSensitiveText(value string, maximumCharacters int, required bool) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximumCharacters || strings.IndexByte(value, 0) >= 0 {
		return false
	}
	return !required || strings.TrimSpace(value) != ""
}

func isCurrencyCode(value string) bool {
	if len(value) != 3 {
		return false
	}
	for index := range value {
		if value[index] < 'A' || value[index] > 'Z' {
			return false
		}
	}
	return true
}

func idempotencyKeyDigest(value string) string {
	hasher := sha256.New()
	writeServiceDigestString(hasher, string(IDEMPOTENCY_KEY_VERSION_V1))
	writeServiceDigestString(hasher, value)
	return hex.EncodeToString(hasher.Sum(nil))
}

func createRequestDigest(spec ContractSpec) string {
	hasher := newActionDigest(ACTION_TYPE_CREATE_CONTRACT)
	writeContractSpecDigest(hasher, spec)
	return hex.EncodeToString(hasher.Sum(nil))
}

func reviseRequestDigest(contractId int64, expectedVersion int64, spec ContractSpec) string {
	hasher := newActionDigest(ACTION_TYPE_REVISE_CONTRACT)
	writeServiceDigestInt64(hasher, contractId)
	writeServiceDigestInt64(hasher, expectedVersion)
	writeContractSpecDigest(hasher, spec)
	return hex.EncodeToString(hasher.Sum(nil))
}

func lifecycleRequestDigest(actionType ActionType, contractId int64, expectedVersion int64, closeReason CloseReasonCode) string {
	hasher := newActionDigest(actionType)
	writeServiceDigestInt64(hasher, contractId)
	writeServiceDigestInt64(hasher, expectedVersion)
	writeServiceDigestString(hasher, string(closeReason))
	return hex.EncodeToString(hasher.Sum(nil))
}

func newActionDigest(actionType ActionType) hash.Hash {
	hasher := sha256.New()
	writeServiceDigestString(hasher, string(ACTION_REQUEST_DIGEST_VERSION_V1))
	writeServiceDigestString(hasher, string(actionType))
	return hasher
}

func writeContractSpecDigest(hasher hash.Hash, spec ContractSpec) {
	writeServiceDigestString(hasher, spec.Name)
	writeServiceDigestString(hasher, spec.LenderName)
	writeServiceDigestString(hasher, string(spec.ContractType))
	writeServiceDigestInt64(hasher, spec.LiabilityAccountId)
	writeServiceDigestOptionalInt64(hasher, spec.DefaultPaymentAccountId)
	writeServiceDigestString(hasher, spec.Currency)
	writeServiceDigestString(hasher, spec.Note)
	writeCalculationTermsDigest(hasher, spec.Terms)
}

func writeCalculationTermsDigest(hasher hash.Hash, terms CalculationTerms) {
	writeServiceDigestString(hasher, terms.EffectiveDate)
	writeServiceDigestString(hasher, terms.ContractDate)
	writeServiceDigestString(hasher, terms.FirstDueDate)
	writeServiceDigestString(hasher, string(terms.FundingType))
	writeServiceDigestString(hasher, string(terms.InputMode))
	writeServiceDigestString(hasher, string(terms.RepaymentMethod))
	writeServiceDigestString(hasher, string(terms.RateQuoteType))
	writeServiceDigestInt64(hasher, terms.PrincipalAmount)
	writeServiceDigestInt64(hasher, terms.ActualDisbursementAmount)
	writeServiceDigestInt64(hasher, terms.UpfrontFeeAmount)
	writeServiceDigestInt64(hasher, terms.PerPeriodFeeAmount)
	writeServiceDigestOptionalInt64(hasher, terms.PaymentBasisAmount)
	writeServiceDigestInt64(hasher, terms.TermCount)
	writeServiceDigestOptionalInt64(hasher, terms.QuotedRatePptr)
	writeServiceDigestString(hasher, string(terms.DiscountType))
	writeServiceDigestOptionalInt64(hasher, terms.DiscountRatePptr)
	writeServiceDigestInt64(hasher, terms.DiscountAmount)
}

func writeServiceDigestString(hasher hash.Hash, value string) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = hasher.Write(length[:])
	_, _ = hasher.Write([]byte(value))
}

func writeServiceDigestInt64(hasher hash.Hash, value int64) {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	_, _ = hasher.Write(encoded[:])
}

func writeServiceDigestOptionalInt64(hasher hash.Hash, value *int64) {
	if value == nil {
		writeServiceDigestInt64(hasher, 0)
		return
	}
	writeServiceDigestInt64(hasher, 1)
	writeServiceDigestInt64(hasher, *value)
}
