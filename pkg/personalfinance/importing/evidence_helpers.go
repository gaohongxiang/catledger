package importing

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	MaxRawFieldsJSONBytes = 60 * 1024
	MaxIssuesJSONBytes    = 16 * 1024
	minimumPhoneDigits    = 8
	maximumPhoneDigits    = 15
)

var canonicalRawFieldCharacterLimits = []struct {
	name  string
	value func(raw CanonicalRawEvidence) string
	limit int
}{
	{"transaction_time", func(raw CanonicalRawEvidence) string { return raw.TransactionTime }, 64},
	{"amount", func(raw CanonicalRawEvidence) string { return raw.Amount }, 64},
	{"direction", func(raw CanonicalRawEvidence) string { return raw.Direction }, 32},
	{"status", func(raw CanonicalRawEvidence) string { return raw.Status }, 128},
	{"transaction_type", func(raw CanonicalRawEvidence) string { return raw.TransactionType }, 128},
	{"counterparty", func(raw CanonicalRawEvidence) string { return raw.Counterparty }, 255},
	{"item", func(raw CanonicalRawEvidence) string { return raw.Item }, 255},
	{"payment_method", func(raw CanonicalRawEvidence) string { return raw.PaymentMethod }, 255},
	{"note", func(raw CanonicalRawEvidence) string { return raw.Note }, 1024},
}

// EncodeSourceLocator 生成不含原始字段值的稳定物理定位字符串。
func EncodeSourceLocator(locator SourceLocator) (string, error) {
	switch locator.Kind {
	case LOCATOR_KIND_CSV:
		if locator.CSVStartRow < 1 || locator.CSVEndRow < locator.CSVStartRow {
			return "", fmt.Errorf("invalid CSV source locator")
		}

		return fmt.Sprintf("v1:csv:%d:%d", locator.CSVStartRow, locator.CSVEndRow), nil
	case LOCATOR_KIND_XLSX:
		if locator.SheetIndex < 0 || locator.SheetName == "" || locator.XLSXRow < 1 {
			return "", fmt.Errorf("invalid XLSX source locator")
		}

		sheetName := base64.RawURLEncoding.EncodeToString([]byte(locator.SheetName))
		return fmt.Sprintf("v1:xlsx:%d:%s:%d", locator.SheetIndex, sheetName, locator.XLSXRow), nil
	case LOCATOR_KIND_SPREADSHEET:
		if locator.SheetIndex < 0 || locator.SheetName == "" || locator.XLSXRow < 1 {
			return "", fmt.Errorf("invalid spreadsheet source locator")
		}

		sheetName := base64.RawURLEncoding.EncodeToString([]byte(locator.SheetName))
		return fmt.Sprintf("v1:spreadsheet:%d:%s:%d", locator.SheetIndex, sheetName, locator.XLSXRow), nil
	case LOCATOR_KIND_PDF:
		if locator.PDFPage < 1 || locator.PDFLine < 1 {
			return "", fmt.Errorf("invalid PDF source locator")
		}

		return fmt.Sprintf("v1:pdf:%d:%d", locator.PDFPage, locator.PDFLine), nil
	default:
		return "", fmt.Errorf("invalid source locator kind")
	}
}

// NormalizeSourceAccountIdentifier 规范化稳定来源账户标识，但不接收掩码或展示昵称。
func NormalizeSourceAccountIdentifier(sourceType SourceType, identifier string) (string, error) {
	if sourceType != SOURCE_TYPE_ALIPAY && sourceType != SOURCE_TYPE_WECHAT {
		return "", fmt.Errorf("invalid source type")
	}

	normalized := normalizeIdentifier(identifier)

	if normalized == "" || looksMasked(normalized) {
		return "", fmt.Errorf("source account identifier is not stable")
	}

	if strings.Contains(normalized, "@") {
		normalized = strings.ToLower(normalized)
	}

	if !isPlausibleFullAccountIdentifier(normalized) {
		return "", fmt.Errorf("source account identifier is not a full email or phone number")
	}

	return normalized, nil
}

const (
	maximumGenericCSVColumnIndex = 1023
	maximumGenericCSVHeaderRow   = 10000
	maximumGenericCSVValues      = 32
)

// NormalizeGenericBankMapping 完整校验并规范化通用银行表格映射，供解析与摘要共同消费。
func NormalizeGenericBankMapping(mapping GenericBankMapping) (GenericBankMapping, error) {
	if mapping.Encoding != GENERIC_CSV_ENCODING_UTF8 && mapping.Encoding != GENERIC_CSV_ENCODING_GB18030 && mapping.Encoding != GENERIC_CSV_ENCODING_GBK {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank CSV encoding")
	}
	if mapping.Delimiter != GENERIC_CSV_DELIMITER_COMMA && mapping.Delimiter != GENERIC_CSV_DELIMITER_TAB {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank CSV delimiter")
	}
	if mapping.SheetIndex < -1 || mapping.SheetIndex > 1023 {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank worksheet")
	}
	if mapping.HeaderRow < 1 || mapping.HeaderRow > maximumGenericCSVHeaderRow || !isValidGenericCSVTimeFormat(mapping.TimeFormat) {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank header row or time format")
	}
	if mapping.DataStartRow == 0 {
		mapping.DataStartRow = mapping.HeaderRow + 1
	}
	if mapping.DataStartRow <= mapping.HeaderRow || mapping.DataStartRow > maximumGenericCSVHeaderRow ||
		mapping.DataEndRow < 0 || mapping.DataEndRow > maximumGenericCSVHeaderRow ||
		(mapping.DataEndRow > 0 && mapping.DataEndRow < mapping.DataStartRow) {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank data row range")
	}
	mapping.PaymentMethodPrefix = strings.TrimSpace(norm.NFKC.String(mapping.PaymentMethodPrefix))
	if !utf8.ValidString(mapping.PaymentMethodPrefix) || utf8.RuneCountInString(mapping.PaymentMethodPrefix) > 64 {
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank payment method prefix")
	}

	columns := []*int{
		&mapping.TimeColumn, &mapping.AmountColumn, &mapping.DirectionColumn, &mapping.IncomeColumn, &mapping.ExpenseColumn,
		&mapping.CurrencyColumn, &mapping.TransactionIdColumn, &mapping.OrderIdColumn, &mapping.MerchantOrderIdColumn,
		&mapping.CounterpartyColumn, &mapping.ItemColumn, &mapping.PaymentMethodColumn, &mapping.StatusColumn,
		&mapping.TransactionTypeColumn, &mapping.NoteColumn,
	}
	seen := make(map[int]struct{}, len(columns))
	for _, column := range columns {
		if *column < -1 || *column > maximumGenericCSVColumnIndex {
			return GenericBankMapping{}, fmt.Errorf("generic bank column is out of range")
		}
		if *column >= 0 {
			if _, exists := seen[*column]; exists {
				return GenericBankMapping{}, fmt.Errorf("generic bank columns must be unique")
			}
			seen[*column] = struct{}{}
		}
	}
	if mapping.TimeColumn < 0 {
		return GenericBankMapping{}, fmt.Errorf("generic bank time column is required")
	}

	var err error
	mapping.IncomeValues, err = normalizeGenericCSVValues(mapping.IncomeValues)
	if err != nil {
		return GenericBankMapping{}, err
	}
	mapping.ExpenseValues, err = normalizeGenericCSVValues(mapping.ExpenseValues)
	if err != nil {
		return GenericBankMapping{}, err
	}

	switch mapping.AmountMode {
	case GENERIC_CSV_AMOUNT_MODE_SIGNED:
		if mapping.AmountColumn < 0 || mapping.DirectionColumn != -1 || mapping.IncomeColumn != -1 || mapping.ExpenseColumn != -1 ||
			(mapping.SignedPositiveDirection != NORMALIZED_DIRECTION_INCOME && mapping.SignedPositiveDirection != NORMALIZED_DIRECTION_EXPENSE) ||
			len(mapping.IncomeValues) != 0 || len(mapping.ExpenseValues) != 0 {
			return GenericBankMapping{}, fmt.Errorf("invalid signed amount mapping")
		}
	case GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION:
		if mapping.AmountColumn < 0 || mapping.DirectionColumn < 0 || mapping.IncomeColumn != -1 || mapping.ExpenseColumn != -1 ||
			mapping.SignedPositiveDirection != "" || len(mapping.IncomeValues) == 0 || len(mapping.ExpenseValues) == 0 {
			return GenericBankMapping{}, fmt.Errorf("invalid amount-direction mapping")
		}
		values := make(map[string]struct{}, len(mapping.IncomeValues))
		for _, value := range mapping.IncomeValues {
			values[value] = struct{}{}
		}
		for _, value := range mapping.ExpenseValues {
			if _, exists := values[value]; exists {
				return GenericBankMapping{}, fmt.Errorf("generic bank direction values overlap")
			}
		}
	case GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE:
		if mapping.AmountColumn != -1 || mapping.DirectionColumn != -1 || mapping.IncomeColumn < 0 || mapping.ExpenseColumn < 0 ||
			mapping.SignedPositiveDirection != "" || len(mapping.IncomeValues) != 0 || len(mapping.ExpenseValues) != 0 {
			return GenericBankMapping{}, fmt.Errorf("invalid income-expense mapping")
		}
	default:
		return GenericBankMapping{}, fmt.Errorf("invalid generic bank amount mode")
	}

	return mapping, nil
}

func isValidGenericCSVTimeFormat(value GenericCSVTimeFormat) bool {
	switch value {
	case GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS, GENERIC_CSV_TIME_FORMAT_DATE_TIME_MINUTES,
		GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_SECONDS, GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_MINUTES,
		GENERIC_CSV_TIME_FORMAT_COMPACT_DATE_TIME_MINUTES, GENERIC_CSV_TIME_FORMAT_COMPACT_DATE,
		GENERIC_CSV_TIME_FORMAT_DATE, GENERIC_CSV_TIME_FORMAT_SLASH_DATE:
		return true
	default:
		return false
	}
}

func normalizeGenericCSVValues(values []string) ([]string, error) {
	if len(values) > maximumGenericCSVValues {
		return nil, fmt.Errorf("too many generic CSV direction values")
	}
	normalized := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !utf8.ValidString(value) {
			return nil, fmt.Errorf("generic CSV direction value is invalid UTF-8")
		}
		value = strings.ToLower(normalizeIdentifier(value))
		if value == "" || utf8.RuneCountInString(value) > 64 {
			return nil, fmt.Errorf("generic CSV direction value is empty or too long")
		}
		for _, char := range value {
			if unicode.IsControl(char) {
				return nil, fmt.Errorf("generic CSV direction value contains control characters")
			}
		}
		if _, exists := seen[value]; exists {
			return nil, fmt.Errorf("generic CSV direction values contain duplicates")
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	sort.Strings(normalized)
	return normalized, nil
}

// ComputeSourceAccountKey 只为已经校验的稳定来源账户证据生成不含明文的 key。
func ComputeSourceAccountKey(sourceType SourceType, candidate SourceAccountCandidate) (string, error) {
	if err := candidate.Validate(sourceType); err != nil {
		return "", err
	}

	if candidate.Kind != SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER {
		return "", fmt.Errorf("source account evidence is not stable")
	}

	normalized, err := NormalizeSourceAccountIdentifier(sourceType, candidate.Identifier)

	if err != nil {
		return "", err
	}

	encoded := encodeLengthPrefixed(string(SOURCE_ACCOUNT_KEY_VERSION_V1), string(sourceType), normalized)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

const displaySourceAccountScopeMaterial = "display-scope-v1"
const fileSourceAccountScopeMaterial = "file-scope-v1"

// ComputeDisplaySourceAccountKey 为账单展示名生成不含明文的身份作用域，不把昵称当成稳定账号标识。
func ComputeDisplaySourceAccountKey(sourceType SourceType, displayName string) (string, error) {
	if !isValidSourceType(sourceType) || displayName == "" || !utf8.ValidString(displayName) {
		return "", fmt.Errorf("source account display evidence is invalid")
	}

	encoded := encodeLengthPrefixed(string(SOURCE_ACCOUNT_KEY_VERSION_V1), string(sourceType), displaySourceAccountScopeMaterial, displayName)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// SafeSourceAccountDisplayName 只返回可持久化的脱敏展示名。
// 稳定标识的 DisplayName 必须为空，由中心根据 Identifier 生成；展示型证据也统一二次脱敏。
func SafeSourceAccountDisplayName(sourceType SourceType, candidate SourceAccountCandidate) (string, error) {
	if err := candidate.Validate(sourceType); err != nil {
		return "", err
	}

	switch candidate.Kind {
	case SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER:
		normalized, err := NormalizeSourceAccountIdentifier(sourceType, candidate.Identifier)

		if err != nil {
			return "", err
		}

		return maskSourceAccountDisplay(normalized), nil
	case SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY:
		return maskAlreadyMaskedDisplay(candidate.DisplayName), nil
	case SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY:
		return maskSourceAccountDisplay(strings.TrimSpace(candidate.DisplayName)), nil
	case SOURCE_ACCOUNT_EVIDENCE_MISSING:
		return "", nil
	default:
		return "", fmt.Errorf("invalid source account evidence kind")
	}
}

// ValidateEvidenceRow 验证 parser 输出，并返回只能由中心规则推导的语义资格。
func ValidateEvidenceRow(sourceType SourceType, row EvidenceRow) (SemanticEligibility, error) {
	if !isValidSourceType(sourceType) {
		return "", fmt.Errorf("invalid evidence source type")
	}

	if row.RowNumber < 1 {
		return "", fmt.Errorf("evidence row number must be positive")
	}

	if _, err := EncodeSourceLocator(row.Locator); err != nil {
		return "", err
	}

	if err := validateCanonicalRawEvidence(row.Raw); err != nil {
		return "", err
	}

	identifiers := []struct {
		name  string
		value string
	}{
		{"transaction_id", row.Identifiers.TransactionId},
		{"order_id", row.Identifiers.OrderId},
		{"merchant_order_id", row.Identifiers.MerchantOrderId},
	}

	for _, identifier := range identifiers {
		if !utf8.ValidString(identifier.value) || utf8.RuneCountInString(identifier.value) > 255 {
			return "", fmt.Errorf("source identifier %s is invalid or too long", identifier.name)
		}
	}

	if _, err := MarshalRawFields(row.RawFields); err != nil {
		return "", err
	}

	if _, err := MarshalEvidenceIssues(row.Issues); err != nil {
		return "", err
	}

	if err := validateIssueCodesForSource(sourceType, row.Issues); err != nil {
		return "", err
	}

	hasErrorIssue := false

	for _, issue := range row.Issues {
		if issue.Severity == ISSUE_SEVERITY_ERROR {
			hasErrorIssue = true
			break
		}
	}

	if (row.ParseStatus == PARSE_STATE_INVALID) != hasErrorIssue {
		return "", fmt.Errorf("parse state and error issues are inconsistent")
	}

	return ResolveSemanticEligibility(row.ParseStatus, row.Normalized)
}

// ValidateEvidenceDocument 校验 descriptor、文档来源、来源账户、文档问题和连续逻辑行。
// 返回值与 Rows 一一对应，只能由中心语义规则推导。
func ValidateEvidenceDocument(descriptor ParserDescriptor, document *EvidenceDocument) ([]SemanticEligibility, error) {
	if err := descriptor.Validate(); err != nil {
		return nil, err
	}

	if document == nil || document.Metadata.SourceType != descriptor.SourceType {
		return nil, fmt.Errorf("evidence document source does not match parser descriptor")
	}

	if err := document.Metadata.SourceAccount.Validate(descriptor.SourceType); err != nil {
		return nil, err
	}

	if document.Metadata.StatementStartUnixTime != nil && document.Metadata.StatementEndUnixTime != nil &&
		*document.Metadata.StatementEndUnixTime < *document.Metadata.StatementStartUnixTime {
		return nil, fmt.Errorf("evidence statement period is invalid")
	}

	if (document.Metadata.StatementDateUnixTime != nil && *document.Metadata.StatementDateUnixTime < 1) ||
		(document.Metadata.DueUnixTime != nil && *document.Metadata.DueUnixTime < 1) ||
		(document.Metadata.CreditLimitAmount != nil && *document.Metadata.CreditLimitAmount < 0) {
		return nil, fmt.Errorf("evidence statement header is invalid")
	}

	if offset := document.Metadata.StatementTimezoneUtcOffset; offset != nil &&
		(*offset < minimumTimezoneUtcOffset || *offset > maximumTimezoneUtcOffset) {
		return nil, fmt.Errorf("evidence statement timezone is invalid")
	}

	if _, err := MarshalEvidenceIssues(document.Issues); err != nil {
		return nil, err
	}

	if err := validateIssueCodesForSource(descriptor.SourceType, document.Issues); err != nil {
		return nil, err
	}

	eligibilities := make([]SemanticEligibility, len(document.Rows))

	for index, row := range document.Rows {
		if row.RowNumber != int64(index+1) {
			return nil, fmt.Errorf("evidence row numbers must be contiguous from one")
		}

		eligibility, err := ValidateEvidenceRow(descriptor.SourceType, row)

		if err != nil {
			return nil, fmt.Errorf("validate evidence row %d: %w", row.RowNumber, err)
		}

		eligibilities[index] = eligibility
	}

	return eligibilities, nil
}

func validateCanonicalRawEvidence(raw CanonicalRawEvidence) error {
	for _, field := range canonicalRawFieldCharacterLimits {
		value := field.value(raw)

		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > field.limit {
			return fmt.Errorf("canonical raw field %s is invalid or too long", field.name)
		}
	}

	return nil
}

// MarshalRawFields 按数组顺序持久化原始字段，并执行统一字节上限。
func MarshalRawFields(fields []RawField) (string, error) {
	if fields == nil {
		fields = make([]RawField, 0)
	}

	for _, field := range fields {
		if !utf8.ValidString(field.Name) || !utf8.ValidString(field.Value) {
			return "", fmt.Errorf("raw field contains invalid UTF-8")
		}
	}

	encoded, err := json.Marshal(fields)

	if err != nil {
		return "", fmt.Errorf("marshal raw fields: %w", err)
	}

	if len(encoded) > MaxRawFieldsJSONBytes {
		return "", fmt.Errorf("raw fields exceed byte limit")
	}

	return string(encoded), nil
}

// MarshalEvidenceIssues 持久化不含原始值的问题数组。
func MarshalEvidenceIssues(issues []EvidenceIssue) (string, error) {
	if issues == nil {
		issues = make([]EvidenceIssue, 0)
	}

	for _, issue := range issues {
		if !isValidIssueCode(issue.Code) || !isValidIssueSeverity(issue.Severity) ||
			!utf8.ValidString(issue.Field) || utf8.RuneCountInString(issue.Field) > 64 {
			return "", fmt.Errorf("invalid evidence issue")
		}
	}

	encoded, err := json.Marshal(issues)

	if err != nil {
		return "", fmt.Errorf("marshal evidence issues: %w", err)
	}

	if len(encoded) > MaxIssuesJSONBytes {
		return "", fmt.Errorf("evidence issues exceed byte limit")
	}

	return string(encoded), nil
}

func isValidIssueCode(code IssueCode) bool {
	switch code {
	case ISSUE_CODE_FILE_FORMAT_INVALID,
		ISSUE_CODE_FILE_ENCODING_INVALID,
		ISSUE_CODE_FILE_STRUCTURE_INVALID,
		ISSUE_CODE_ROW_FIELD_MISSING,
		ISSUE_CODE_ROW_TIME_INVALID,
		ISSUE_CODE_ROW_AMOUNT_INVALID,
		ISSUE_CODE_ROW_CURRENCY_INVALID,
		ISSUE_CODE_ROW_DIRECTION_UNKNOWN,
		ISSUE_CODE_ROW_STATUS_UNKNOWN,
		ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN,
		ISSUE_CODE_ROW_IDENTIFIER_INVALID,
		ISSUE_CODE_ROW_UNSUPPORTED:
		return true
	default:
		return isSourceSpecificIssueCode(code)
	}
}

func isValidFileIssueCode(code IssueCode) bool {
	if !isValidIssueCode(code) {
		return false
	}

	value := string(code)
	return strings.HasPrefix(value, "file_") || strings.HasPrefix(value, "alipay_file_") || strings.HasPrefix(value, "wechat_file_") || strings.HasPrefix(value, "bank_file_")
}

// isSourceSpecificIssueCode 允许解析器在自己的命名空间扩展稳定问题码，
// 从而让支付宝和微信分支不必同时修改公共枚举。
func isSourceSpecificIssueCode(code IssueCode) bool {
	value := string(code)

	if len(value) > 64 || (!strings.HasPrefix(value, "alipay_") && !strings.HasPrefix(value, "wechat_") && !strings.HasPrefix(value, "bank_")) {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}

	return true
}

func validateIssueCodesForSource(sourceType SourceType, issues []EvidenceIssue) error {
	prefix := string(sourceType) + "_"

	for _, issue := range issues {
		value := string(issue.Code)

		if (strings.HasPrefix(value, "alipay_") || strings.HasPrefix(value, "wechat_") || strings.HasPrefix(value, "bank_")) && !strings.HasPrefix(value, prefix) {
			return fmt.Errorf("evidence issue code does not belong to source type")
		}
	}

	return nil
}

func isValidIssueSeverity(severity IssueSeverity) bool {
	return severity == ISSUE_SEVERITY_INFO || severity == ISSUE_SEVERITY_WARNING || severity == ISSUE_SEVERITY_ERROR
}

// SelectPrimaryIssue 按 error、warning、info 的优先级稳定选择第一个主问题。
func SelectPrimaryIssue(issues []EvidenceIssue) IssueCode {
	priorities := []IssueSeverity{
		ISSUE_SEVERITY_ERROR,
		ISSUE_SEVERITY_WARNING,
		ISSUE_SEVERITY_INFO,
	}

	for _, priority := range priorities {
		for _, issue := range issues {
			if issue.Severity == priority {
				return issue.Code
			}
		}
	}

	return ISSUE_CODE_NONE
}

func normalizeIdentifier(value string) string {
	value = strings.TrimPrefix(value, "\ufeff")
	value = norm.NFKC.String(value)
	value = strings.TrimSpace(value)

	switch strings.ToLower(value) {
	case "", "-", "--", "/", "n/a", "null", "none":
		return ""
	default:
		return value
	}
}

func looksMasked(value string) bool {
	lower := strings.ToLower(norm.NFKC.String(value))

	if strings.ContainsAny(lower, "*•●") ||
		strings.Contains(lower, "尾号") ||
		strings.Contains(lower, "末四位") ||
		strings.Contains(lower, "后四位") ||
		strings.Contains(lower, "末4位") ||
		strings.Contains(lower, "后4位") ||
		strings.Contains(lower, "xx") {
		return true
	}

	allDigits := true
	digitCount := 0

	for _, char := range lower {
		if unicode.IsDigit(char) {
			digitCount++
			continue
		}

		allDigits = false
		break
	}

	return allDigits && digitCount > 0 && (digitCount < minimumPhoneDigits || digitCount > maximumPhoneDigits)
}

func isPlausibleFullAccountIdentifier(value string) bool {
	if strings.Count(value, "@") == 1 {
		local, domain, _ := strings.Cut(value, "@")

		return local != "" && domain != "" && strings.Contains(domain, ".") &&
			!strings.ContainsAny(value, " \t\r\n")
	}

	digits := value

	if strings.HasPrefix(digits, "+") {
		digits = digits[1:]
	}

	for _, char := range digits {
		if char < '0' || char > '9' {
			return false
		}
	}

	return len(digits) >= minimumPhoneDigits && len(digits) <= maximumPhoneDigits
}

func maskAlreadyMaskedDisplay(value string) string {
	runes := []rune(strings.TrimSpace(value))
	trailingDigits := make([]rune, 0, 4)

	for index := len(runes) - 1; index >= 0 && len(trailingDigits) < 4; index-- {
		if unicode.IsSpace(runes[index]) {
			continue
		}

		if !unicode.IsDigit(runes[index]) {
			break
		}

		trailingDigits = append(trailingDigits, runes[index])
	}

	for left, right := 0, len(trailingDigits)-1; left < right; left, right = left+1, right-1 {
		trailingDigits[left], trailingDigits[right] = trailingDigits[right], trailingDigits[left]
	}

	if len(trailingDigits) == 0 {
		return "***"
	}

	return "***" + string(trailingDigits)
}

func maskSourceAccountDisplay(value string) string {
	if value == "" {
		return value
	}

	if at := strings.LastIndex(value, "@"); at > 0 && at < len(value)-1 {
		local := []rune(value[:at])
		domain := value[at+1:]
		return string(local[0]) + "***@" + maskEmailDomain(domain)
	}

	runes := []rune(value)
	digitOnly := true

	for _, char := range runes {
		if !unicode.IsDigit(char) {
			digitOnly = false
			break
		}
	}

	if digitOnly && len(runes) >= 8 {
		return string(runes[:3]) + "****" + string(runes[len(runes)-4:])
	}

	return maskTextEdges(runes)
}

func maskTextEdges(runes []rune) string {
	switch len(runes) {
	case 0:
		return ""
	case 1:
		return "*"
	case 2:
		return string(runes[0]) + "*"
	default:
		return string(runes[0]) + strings.Repeat("*", len(runes)-2) + string(runes[len(runes)-1])
	}
}

func maskEmailDomain(domain string) string {
	label := domain
	suffix := ""

	if dot := strings.LastIndex(domain, "."); dot > 0 {
		label = domain[:dot]
		suffix = domain[dot:]
	}

	runes := []rune(label)

	if len(runes) == 0 {
		return "***" + suffix
	}

	return string(runes[0]) + strings.Repeat("*", max(2, len(runes)-1)) + suffix
}

func encodeLengthPrefixed(values ...string) []byte {
	var builder strings.Builder

	for _, value := range values {
		fmt.Fprintf(&builder, "%d:%s", len([]byte(value)), value)
	}

	return []byte(builder.String())
}
