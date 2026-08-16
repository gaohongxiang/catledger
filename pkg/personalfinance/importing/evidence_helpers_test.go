package importing

import (
	"fmt"
	"strings"
	"testing"
)

func TestEvidenceSerializationAndLocator(t *testing.T) {
	locator, err := EncodeSourceLocator(SourceLocator{
		Kind:        LOCATOR_KIND_CSV,
		CSVStartRow: 12,
		CSVEndRow:   13,
	})

	if err != nil || locator != "v1:csv:12:13" {
		t.Fatalf("unexpected CSV locator %q: %v", locator, err)
	}

	locator, err = EncodeSourceLocator(SourceLocator{
		Kind:       LOCATOR_KIND_XLSX,
		SheetIndex: 1,
		SheetName:  "账单 1",
		XLSXRow:    8,
	})

	if err != nil || locator != "v1:xlsx:1:6LSm5Y2VIDE:8" {
		t.Fatalf("unexpected XLSX locator %q: %v", locator, err)
	}

	locator, err = EncodeSourceLocator(SourceLocator{
		Kind:    LOCATOR_KIND_PDF,
		PDFPage: 2,
		PDFLine: 17,
	})

	if err != nil || locator != "v1:pdf:2:17" {
		t.Fatalf("unexpected PDF locator %q: %v", locator, err)
	}

	rawJSON, err := MarshalRawFields([]RawField{
		{Name: "", Value: "  untrimmed  "},
		{Name: "duplicate", Value: "first"},
		{Name: "duplicate", Value: "second"},
	})

	if err != nil {
		t.Fatalf("marshal raw fields: %v", err)
	}

	const expectedRawJSON = `[{"name":"","value":"  untrimmed  "},{"name":"duplicate","value":"first"},{"name":"duplicate","value":"second"}]`

	if rawJSON != expectedRawJSON {
		t.Fatalf("raw field snapshot changed: %s", rawJSON)
	}
}

func TestPrimaryIssueSelection(t *testing.T) {
	issues := []EvidenceIssue{
		{Code: ISSUE_CODE_ROW_DIRECTION_UNKNOWN, Severity: ISSUE_SEVERITY_WARNING},
		{Code: ISSUE_CODE_ROW_TIME_INVALID, Severity: ISSUE_SEVERITY_ERROR},
		{Code: ISSUE_CODE_ROW_AMOUNT_INVALID, Severity: ISSUE_SEVERITY_ERROR},
	}

	if selected := SelectPrimaryIssue(issues); selected != ISSUE_CODE_ROW_TIME_INVALID {
		t.Fatalf("unexpected primary issue %s", selected)
	}

	issuesJSON, err := MarshalEvidenceIssues(issues)

	if err != nil || issuesJSON == "" {
		t.Fatalf("marshal issues: %q %v", issuesJSON, err)
	}
}

func TestIssueCodeNamespaces(t *testing.T) {
	valid := []IssueCode{
		ISSUE_CODE_ROW_STATUS_UNKNOWN,
		"alipay_unknown_export_status",
		"wechat_xlsx_formula_unsupported",
		"bank_row_column_mismatch",
	}

	for _, code := range valid {
		if _, err := MarshalEvidenceIssues([]EvidenceIssue{{Code: code, Severity: ISSUE_SEVERITY_WARNING}}); err != nil {
			t.Fatalf("valid issue code %q was rejected: %v", code, err)
		}
	}

	invalid := []IssueCode{"other_unknown_status", "alipay-unknown-status", "Alipay_unknown_status", "alipay_原始状态"}

	for _, code := range invalid {
		if _, err := MarshalEvidenceIssues([]EvidenceIssue{{Code: code, Severity: ISSUE_SEVERITY_WARNING}}); err == nil {
			t.Fatalf("invalid issue code %q was accepted", code)
		}
	}
}

func TestGenericCSVMappingValidationAndCanonicalization(t *testing.T) {
	mapping := validGenericCSVMapping()
	mapping.IncomeValues = []string{" Credit ", "IN"}
	mapping.ExpenseValues = []string{"debit", "OUT"}
	normalized, err := NormalizeGenericCSVMapping(mapping)
	if err != nil {
		t.Fatalf("valid mapping rejected: %v", err)
	}
	if strings.Join(normalized.IncomeValues, ",") != "credit,in" || strings.Join(normalized.ExpenseValues, ",") != "debit,out" {
		t.Fatalf("direction values were not canonicalized: %+v", normalized)
	}

	invalid := []GenericCSVMapping{mapping, mapping, mapping, mapping, mapping}
	invalid[0].TimeColumn = -2
	invalid[1].AmountColumn = invalid[1].TimeColumn
	invalid[2].IncomeValues = []string{"credit", " CREDIT "}
	invalid[3].ExpenseValues = []string{"credit"}
	invalid[4].IncomeColumn = 4
	for index, candidate := range invalid {
		if _, err := NormalizeGenericCSVMapping(candidate); err == nil {
			t.Fatalf("invalid mapping %d was accepted: %+v", index, candidate)
		}
	}
}

func validGenericCSVMapping() GenericCSVMapping {
	return GenericCSVMapping{
		Encoding: GENERIC_CSV_ENCODING_UTF8, Delimiter: GENERIC_CSV_DELIMITER_COMMA, HeaderRow: 1,
		TimeFormat: GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS, AmountMode: GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION,
		TimeColumn: 0, AmountColumn: 1, DirectionColumn: 2, IncomeColumn: -1, ExpenseColumn: -1,
		CurrencyColumn: -1, TransactionIdColumn: -1, OrderIdColumn: -1, MerchantOrderIdColumn: -1,
		CounterpartyColumn: -1, ItemColumn: -1, PaymentMethodColumn: -1, StatusColumn: -1,
		TransactionTypeColumn: -1, NoteColumn: -1, IncomeValues: []string{"credit"}, ExpenseValues: []string{"debit"},
	}
}

func TestResolvedParseOptionsValidation(t *testing.T) {
	valid := ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480}

	if err := valid.Validate(); err != nil {
		t.Fatalf("valid parse options were rejected: %v", err)
	}

	invalid := []ResolvedParseOptions{
		{Currency: "cny", TimezoneUtcOffset: 480},
		{Currency: "CN", TimezoneUtcOffset: 480},
		{Currency: "CNY", TimezoneUtcOffset: 841},
	}

	for _, options := range invalid {
		if err := options.Validate(); err == nil {
			t.Fatalf("invalid parse options were accepted: %+v", options)
		}
	}
}

func TestParserDescriptorAndCentralVersions(t *testing.T) {
	descriptor := ParserDescriptor{
		Name:                 "alipay-app-csv",
		SourceType:           SOURCE_TYPE_ALIPAY,
		Format:               EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		ParserVersion:        "alipay-parser-v1",
		NormalizationVersion: "alipay-normalization-v1",
	}

	if err := descriptor.Validate(); err != nil {
		t.Fatalf("valid parser descriptor was rejected: %v", err)
	}

	descriptor.SourceType = SOURCE_TYPE_WECHAT

	if err := descriptor.Validate(); err == nil {
		t.Fatal("mismatched parser source and format were accepted")
	}

	versions := CurrentCentralRuleVersions()

	if versions.SourceAccountKeyVersion != SOURCE_ACCOUNT_KEY_VERSION_V1 ||
		versions.IdentityKeyVersion != IDENTITY_KEY_VERSION_V1 ||
		versions.CoreDigestVersion != CORE_DIGEST_VERSION_V1 ||
		versions.FingerprintVersion != FINGERPRINT_VERSION_V1 ||
		versions.RawSnapshotVersion != RAW_SNAPSHOT_VERSION_V1 {
		t.Fatalf("unexpected central versions: %+v", versions)
	}
}

func TestProbeAndParseErrorsAreBoundToDescriptorAndSafe(t *testing.T) {
	descriptor := ParserDescriptor{
		Name:                 "alipay-app-csv",
		SourceType:           SOURCE_TYPE_ALIPAY,
		Format:               EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		ParserVersion:        "alipay-parser-v1",
		NormalizationVersion: "alipay-normalization-v1",
	}
	validProbe := ProbeResult{
		Confidence: PROBE_CONFIDENCE_EXACT,
		SourceType: SOURCE_TYPE_ALIPAY,
		Format:     EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		IssueCode:  "alipay_file_header_recognized",
	}

	if err := validProbe.Validate(descriptor); err != nil {
		t.Fatalf("valid probe result was rejected: %v", err)
	}

	invalidProbe := validProbe
	invalidProbe.SourceType = SOURCE_TYPE_WECHAT

	if err := invalidProbe.Validate(descriptor); err == nil {
		t.Fatal("cross-source probe result was accepted")
	}

	crossSourceIssueProbe := validProbe
	crossSourceIssueProbe.IssueCode = "wechat_file_header_invalid"

	if err := crossSourceIssueProbe.Validate(descriptor); err == nil {
		t.Fatal("cross-source probe issue code was accepted")
	}

	rowIssueProbe := validProbe
	rowIssueProbe.IssueCode = ISSUE_CODE_ROW_AMOUNT_INVALID

	if err := rowIssueProbe.Validate(descriptor); err == nil {
		t.Fatal("row-level issue code was accepted for a file probe")
	}

	if code := NormalizeEvidenceParseError(descriptor, &EvidenceParseError{Code: "alipay_file_encoding_unsupported"}); code != "alipay_file_encoding_unsupported" {
		t.Fatalf("safe source parse error was not preserved: %s", code)
	}

	var typedNilParseError *EvidenceParseError
	unsafeErrors := []error{
		&EvidenceParseError{Code: "wechat_file_encoding_unsupported"},
		&EvidenceParseError{Code: ISSUE_CODE_ROW_AMOUNT_INVALID},
		fmt.Errorf("raw account 13800138000 failed"),
		typedNilParseError,
	}

	for _, unsafeErr := range unsafeErrors {
		if code := NormalizeEvidenceParseError(descriptor, unsafeErr); code != ISSUE_CODE_FILE_FORMAT_INVALID {
			t.Fatalf("unsafe parse error was exposed as %s", code)
		}
	}

	invalidDescriptor := descriptor
	invalidDescriptor.SourceType = SOURCE_TYPE_WECHAT

	if code := NormalizeEvidenceParseError(invalidDescriptor, &EvidenceParseError{Code: "alipay_file_encoding_unsupported"}); code != ISSUE_CODE_FILE_FORMAT_INVALID {
		t.Fatalf("invalid descriptor preserved a source parse error as %s", code)
	}
}

func TestValidateEvidenceRowDerivesEligibility(t *testing.T) {
	unixTime := int64(1720000000)
	amount := int64(100)
	row := EvidenceRow{
		RowNumber: 1,
		Locator: SourceLocator{
			Kind:        LOCATOR_KIND_CSV,
			CSVStartRow: 2,
			CSVEndRow:   2,
		},
		RawFields: []RawField{{Name: "金额", Value: " 1.00 "}},
		Raw: CanonicalRawEvidence{
			TransactionTime: "2026-08-13 10:00:00",
			Amount:          " 1.00 ",
			Direction:       "支出",
			Status:          "支付成功",
			TransactionType: "商户消费",
		},
		Normalized: NormalizedEvidence{
			UnixTime:          &unixTime,
			TimezoneUtcOffset: 480,
			Amount:            &amount,
			Currency:          "CNY",
			Direction:         NORMALIZED_DIRECTION_EXPENSE,
			TransactionType:   SOURCE_TRANSACTION_TYPE_PAYMENT,
			EconomicEffect:    ECONOMIC_EFFECT_NORMAL,
		},
		ParseStatus: PARSE_STATE_VALID,
	}

	eligibility, err := ValidateEvidenceRow(SOURCE_TYPE_ALIPAY, row)

	if err != nil || eligibility != SEMANTIC_ELIGIBILITY_POSTABLE {
		t.Fatalf("unexpected evidence row result %s: %v", eligibility, err)
	}

	invalid := row
	invalid.ParseStatus = PARSE_STATE_INVALID
	invalid.Normalized = NormalizedEvidence{}
	invalid.Issues = []EvidenceIssue{{Code: ISSUE_CODE_ROW_AMOUNT_INVALID, Field: "amount", Severity: ISSUE_SEVERITY_ERROR}}
	eligibility, err = ValidateEvidenceRow(SOURCE_TYPE_ALIPAY, invalid)

	if err != nil || eligibility != SEMANTIC_ELIGIBILITY_NON_POSTABLE {
		t.Fatalf("invalid evidence row was not made non-postable: %s %v", eligibility, err)
	}

	tooLong := row
	tooLong.Raw.Direction = strings.Repeat("方", 33)

	if _, err = ValidateEvidenceRow(SOURCE_TYPE_ALIPAY, tooLong); err == nil {
		t.Fatal("oversized canonical raw projection was accepted")
	}
}

func TestValidateEvidenceDocumentBindsIssueNamespaceToSource(t *testing.T) {
	descriptor := ParserDescriptor{
		Name:                 "alipay-app-csv",
		SourceType:           SOURCE_TYPE_ALIPAY,
		Format:               EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		ParserVersion:        "alipay-parser-v1",
		NormalizationVersion: "alipay-normalization-v1",
	}
	document := &EvidenceDocument{
		Metadata: DocumentMetadata{
			SourceType: SOURCE_TYPE_ALIPAY,
			SourceAccount: SourceAccountCandidate{
				Kind:            SOURCE_ACCOUNT_EVIDENCE_MISSING,
				DiscoveryMethod: SOURCE_ACCOUNT_DISCOVERY_MISSING,
			},
		},
		Issues: []EvidenceIssue{{Code: "wechat_xlsx_formula_unsupported", Severity: ISSUE_SEVERITY_WARNING}},
	}

	if _, err := ValidateEvidenceDocument(descriptor, document); err == nil {
		t.Fatal("cross-source issue namespace was accepted")
	}

	document.Issues[0].Code = "alipay_unknown_export_status"

	if _, err := ValidateEvidenceDocument(descriptor, document); err != nil {
		t.Fatalf("same-source issue namespace was rejected: %v", err)
	}
}
