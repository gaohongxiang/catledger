package genericbank

import (
	"bytes"
	"context"
	"encoding/csv"
	"io"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	parserName           = "generic_bank_csv"
	parserVersion        = importing.RuleVersion("generic-bank-csv-parser-v1")
	normalizationVersion = importing.RuleVersion("generic-bank-normalization-v1")
)

// ImportEvidenceParser 仅能由调用方显式选择，不参与支付宝、微信或其他来源的自动探测。
var ImportEvidenceParser importing.ImportEvidenceParser = &genericBankCSVParser{}

type genericBankCSVParser struct{}

type physicalRecord struct {
	values   []string
	startRow int64
	endRow   int64
}

func (p *genericBankCSVParser) Descriptor() importing.ParserDescriptor {
	return importing.ParserDescriptor{
		Name:                  parserName,
		SourceType:            importing.SOURCE_TYPE_BANK,
		Format:                importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV,
		ParserVersion:         parserVersion,
		NormalizationVersion:  normalizationVersion,
		ExplicitSelectionOnly: true,
	}
}

// Probe 只确认内容至少能按一种受支持编码和分隔符读取为多列 CSV。
// 实际显式编码、分隔符和表头仍由 Parse 严格校验。
func (p *genericBankCSVParser) Probe(ctx context.Context, file importing.EvidenceFile) importing.ProbeResult {
	if ctx.Err() != nil || len(file.Content) == 0 || bytes.HasPrefix(file.Content, []byte{'P', 'K', 0x03, 0x04}) {
		return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
	}

	encodings := []importing.GenericCSVEncoding{
		importing.GENERIC_CSV_ENCODING_UTF8,
		importing.GENERIC_CSV_ENCODING_GB18030,
		importing.GENERIC_CSV_ENCODING_GBK,
	}
	for _, encodingName := range encodings {
		decoded, err := decodeContent(file.Content, encodingName)
		if err != nil || !looksLikeText(decoded) {
			continue
		}
		for _, delimiter := range []rune{',', '\t'} {
			records, readErr := readPhysicalRecords(ctx, decoded, delimiter)
			if readErr == nil && hasMultiColumnRecord(records) {
				return importing.ProbeResult{
					Confidence: importing.PROBE_CONFIDENCE_POSSIBLE,
					SourceType: importing.SOURCE_TYPE_BANK,
					Format:     importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV,
				}
			}
		}
	}

	return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
}

func (p *genericBankCSVParser) Parse(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	descriptor := p.Descriptor()
	if err := opts.ValidateForDescriptor(descriptor); err != nil || opts.GenericCSVMapping == nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	mapping, err := importing.NormalizeGenericCSVMapping(*opts.GenericCSVMapping)
	if err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	decoded, err := decodeContent(file.Content, mapping.Encoding)
	if err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
	}
	delimiter := ','
	if mapping.Delimiter == importing.GENERIC_CSV_DELIMITER_TAB {
		delimiter = '\t'
	}
	records, err := readPhysicalRecords(ctx, decoded, delimiter)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	if mapping.HeaderRow > len(records) {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	header := records[mapping.HeaderRow-1].values
	if !mappingColumnsFit(mapping, len(header)) {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	document := &importing.EvidenceDocument{
		Metadata: importing.DocumentMetadata{
			SourceType: importing.SOURCE_TYPE_BANK,
			SourceAccount: importing.SourceAccountCandidate{
				Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MISSING,
				DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
			},
		},
		Rows: make([]importing.EvidenceRow, 0, len(records)-mapping.HeaderRow),
	}
	for index := mapping.HeaderRow; index < len(records); index++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		document.Rows = append(document.Rows, buildRow(int64(len(document.Rows)+1), records[index], header, mapping, opts))
	}
	if _, err := importing.ValidateEvidenceDocument(descriptor, document); err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	return document, nil
}

func buildRow(rowNumber int64, record physicalRecord, header []string, mapping importing.GenericCSVMapping, opts importing.ResolvedParseOptions) importing.EvidenceRow {
	fields := make([]importing.RawField, len(record.values))
	for index, value := range record.values {
		name := ""
		if index < len(header) {
			name = header[index]
		}
		fields[index] = importing.RawField{Name: name, Value: value}
	}
	get := func(column int) string {
		if column < 0 || column >= len(record.values) {
			return ""
		}
		return record.values[column]
	}

	raw := importing.CanonicalRawEvidence{
		TransactionTime: get(mapping.TimeColumn),
		Amount:          get(mapping.AmountColumn),
		Direction:       get(mapping.DirectionColumn),
		Status:          get(mapping.StatusColumn),
		TransactionType: get(mapping.TransactionTypeColumn),
		Counterparty:    get(mapping.CounterpartyColumn),
		Item:            get(mapping.ItemColumn),
		PaymentMethod:   get(mapping.PaymentMethodColumn),
		Note:            get(mapping.NoteColumn),
	}
	if mapping.AmountMode == importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE {
		raw.Amount = get(mapping.IncomeColumn)
		if strings.TrimSpace(raw.Amount) == "" {
			raw.Amount = get(mapping.ExpenseColumn)
		}
	}

	issues := make([]importing.EvidenceIssue, 0, 4)
	normalized := importing.NormalizedEvidence{
		TimezoneUtcOffset: opts.TimezoneUtcOffset,
		Currency:          opts.Currency,
		Direction:         importing.NORMALIZED_DIRECTION_UNKNOWN,
		TransactionType:   importing.SOURCE_TRANSACTION_TYPE_OTHER,
		EconomicEffect:    importing.ECONOMIC_EFFECT_NORMAL,
		Counterparty:      normalizeText(raw.Counterparty),
		Item:              normalizeText(raw.Item),
		PaymentMethod:     normalizeText(raw.PaymentMethod),
		Note:              normalizeText(raw.Note),
	}
	parseTime(raw.TransactionTime, mapping.TimeFormat, opts.TimezoneUtcOffset, &normalized, &issues)
	parseAmountAndDirection(record.values, mapping, &normalized, &issues)
	if mapping.CurrencyColumn >= 0 {
		currency := strings.ToUpper(normalizeText(get(mapping.CurrencyColumn)))
		if currency == "" || currency != opts.Currency {
			issues = append(issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_CURRENCY_INVALID, Field: "currency", Severity: importing.ISSUE_SEVERITY_ERROR})
		}
	}

	identifiers := importing.SourceIdentifiers{
		TransactionId:   normalizeText(get(mapping.TransactionIdColumn)),
		OrderId:         normalizeText(get(mapping.OrderIdColumn)),
		MerchantOrderId: normalizeText(get(mapping.MerchantOrderIdColumn)),
	}
	clearOversizedCanonical(&raw, &normalized, &identifiers, &issues)
	parseState := importing.PARSE_STATE_VALID
	for _, issue := range issues {
		if issue.Severity == importing.ISSUE_SEVERITY_ERROR {
			parseState = importing.PARSE_STATE_INVALID
			break
		}
	}
	return importing.EvidenceRow{
		RowNumber:            rowNumber,
		Locator:              importing.SourceLocator{Kind: importing.LOCATOR_KIND_CSV, CSVStartRow: record.startRow, CSVEndRow: record.endRow},
		RawFields:            fields,
		Raw:                  raw,
		Identifiers:          identifiers,
		Normalized:           normalized,
		FingerprintMaterials: importing.StrongFingerprintMaterials{Counterparty: normalized.Counterparty, Item: normalized.Item, PaymentMethod: normalized.PaymentMethod},
		ParseStatus:          parseState,
		Issues:               issues,
	}
}

func parseTime(value string, format importing.GenericCSVTimeFormat, offset int16, normalized *importing.NormalizedEvidence, issues *[]importing.EvidenceIssue) {
	value = normalizeText(value)
	if value == "" {
		*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_FIELD_MISSING, Field: "transaction_time", Severity: importing.ISSUE_SEVERITY_ERROR})
		return
	}
	location := time.FixedZone("generic-bank", int(offset)*60)
	parsed, err := time.ParseInLocation(string(format), value, location)
	if err != nil || parsed.Unix() < 1 {
		*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_TIME_INVALID, Field: "transaction_time", Severity: importing.ISSUE_SEVERITY_ERROR})
		return
	}
	unixTime := parsed.Unix()
	normalized.UnixTime = &unixTime
}

func parseAmountAndDirection(values []string, mapping importing.GenericCSVMapping, normalized *importing.NormalizedEvidence, issues *[]importing.EvidenceIssue) {
	get := func(column int) string {
		if column < 0 || column >= len(values) {
			return ""
		}
		return values[column]
	}
	var amountText string
	var direction importing.NormalizedDirection
	switch mapping.AmountMode {
	case importing.GENERIC_CSV_AMOUNT_MODE_SIGNED:
		amountText = normalizeText(get(mapping.AmountColumn))
		negative := strings.HasPrefix(amountText, "-")
		if strings.HasPrefix(amountText, "+") || negative {
			amountText = amountText[1:]
		}
		direction = mapping.SignedPositiveDirection
		if negative {
			direction = oppositeDirection(direction)
		}
	case importing.GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION:
		amountText = normalizeText(get(mapping.AmountColumn))
		rawDirection := strings.ToLower(normalizeText(get(mapping.DirectionColumn)))
		if contains(mapping.IncomeValues, rawDirection) {
			direction = importing.NORMALIZED_DIRECTION_INCOME
		}
		if contains(mapping.ExpenseValues, rawDirection) {
			direction = importing.NORMALIZED_DIRECTION_EXPENSE
		}
	case importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE:
		income := normalizeText(get(mapping.IncomeColumn))
		expense := normalizeText(get(mapping.ExpenseColumn))
		if income != "" && expense == "" {
			amountText, direction = income, importing.NORMALIZED_DIRECTION_INCOME
		}
		if expense != "" && income == "" {
			amountText, direction = expense, importing.NORMALIZED_DIRECTION_EXPENSE
		}
	}

	if amountText == "" {
		*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_FIELD_MISSING, Field: "amount", Severity: importing.ISSUE_SEVERITY_ERROR})
	} else if amount, ok := parseUnsignedAmount(amountText); !ok {
		*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_AMOUNT_INVALID, Field: "amount", Severity: importing.ISSUE_SEVERITY_ERROR})
	} else {
		normalized.Amount = &amount
	}
	if direction == "" {
		direction = importing.NORMALIZED_DIRECTION_UNKNOWN
		*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN, Field: "direction", Severity: importing.ISSUE_SEVERITY_WARNING})
	}
	normalized.Direction = direction
}

func parseUnsignedAmount(value string) (int64, bool) {
	if value == "" || strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		return 0, false
	}
	if strings.Contains(value, ",") {
		parts := strings.SplitN(value, ".", 2)
		groups := strings.Split(parts[0], ",")
		if len(groups[0]) < 1 || len(groups[0]) > 3 {
			return 0, false
		}
		for index, group := range groups {
			if (index > 0 && len(group) != 3) || !asciiDigits(group) {
				return 0, false
			}
		}
		value = strings.ReplaceAll(value, ",", "")
	}
	parts := strings.Split(value, ".")
	if len(parts) > 2 || !asciiDigits(parts[0]) || (len(parts) == 2 && (len(parts[1]) < 1 || len(parts[1]) > 2 || !asciiDigits(parts[1]))) {
		return 0, false
	}
	integer := parts[0]
	decimals := "00"
	if len(parts) == 2 {
		decimals = parts[1]
		if len(decimals) == 1 {
			decimals += "0"
		}
	}
	minorUnits, ok := new(big.Int).SetString(integer+decimals, 10)
	if !ok || minorUnits.Sign() < 0 || !minorUnits.IsInt64() {
		return 0, false
	}
	return minorUnits.Int64(), true
}

func asciiDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func oppositeDirection(direction importing.NormalizedDirection) importing.NormalizedDirection {
	if direction == importing.NORMALIZED_DIRECTION_INCOME {
		return importing.NORMALIZED_DIRECTION_EXPENSE
	}
	return importing.NORMALIZED_DIRECTION_INCOME
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func normalizeText(value string) string {
	return strings.TrimSpace(norm.NFKC.String(strings.TrimPrefix(value, "\ufeff")))
}

func parseError(code importing.IssueCode) error { return &importing.EvidenceParseError{Code: code} }

func decodeContent(content []byte, name importing.GenericCSVEncoding) (string, error) {
	if name == importing.GENERIC_CSV_ENCODING_UTF8 {
		if bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}) {
			content = content[3:]
		}
		if !utf8.Valid(content) {
			return "", io.ErrUnexpectedEOF
		}
		return string(content), nil
	}
	var codec encoding.Encoding
	if name == importing.GENERIC_CSV_ENCODING_GB18030 {
		codec = simplifiedchinese.GB18030
	} else if name == importing.GENERIC_CSV_ENCODING_GBK {
		codec = simplifiedchinese.GBK
	} else {
		return "", io.ErrUnexpectedEOF
	}
	decoded, _, err := transform.Bytes(codec.NewDecoder(), content)
	if err != nil || !utf8.Valid(decoded) {
		return "", io.ErrUnexpectedEOF
	}
	roundTrip, _, err := transform.Bytes(codec.NewEncoder(), decoded)
	if err != nil || !bytes.Equal(roundTrip, content) {
		return "", io.ErrUnexpectedEOF
	}
	return string(decoded), nil
}

func looksLikeText(value string) bool {
	if value == "" || strings.ContainsRune(value, '\x00') {
		return false
	}
	controls := 0
	for _, char := range value {
		if char < 0x20 && char != '\r' && char != '\n' && char != '\t' {
			controls++
		}
	}
	return controls*100 <= utf8.RuneCountInString(value)
}

func hasMultiColumnRecord(records []physicalRecord) bool {
	for _, record := range records {
		if len(record.values) >= 2 {
			return true
		}
	}
	return false
}

func mappingColumnsFit(mapping importing.GenericCSVMapping, width int) bool {
	columns := []int{mapping.TimeColumn, mapping.AmountColumn, mapping.DirectionColumn, mapping.IncomeColumn, mapping.ExpenseColumn,
		mapping.CurrencyColumn, mapping.TransactionIdColumn, mapping.OrderIdColumn, mapping.MerchantOrderIdColumn,
		mapping.CounterpartyColumn, mapping.ItemColumn, mapping.PaymentMethodColumn, mapping.StatusColumn, mapping.TransactionTypeColumn, mapping.NoteColumn}
	for _, column := range columns {
		if column >= width {
			return false
		}
	}
	return width > 0
}

func readPhysicalRecords(ctx context.Context, content string, delimiter rune) ([]physicalRecord, error) {
	data := []byte(content)
	records := make([]physicalRecord, 0)
	start, startLine, currentLine := 0, int64(1), int64(1)
	inQuotes, atFieldStart := false, true
	for index := 0; index < len(data); index++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		char := data[index]
		if inQuotes {
			if char == '"' {
				if index+1 < len(data) && data[index+1] == '"' {
					index++
					continue
				}
				inQuotes, atFieldStart = false, false
			} else if char == '\r' || char == '\n' {
				if char == '\r' && index+1 < len(data) && data[index+1] == '\n' {
					index++
				}
				currentLine++
			}
			continue
		}
		switch rune(char) {
		case '"':
			if atFieldStart {
				inQuotes = true
			}
		case delimiter:
			atFieldStart = true
		case '\r', '\n':
			record, err := parseRecord(data[start:index], delimiter, startLine, currentLine)
			if err != nil {
				return nil, err
			}
			records = append(records, record)
			if char == '\r' && index+1 < len(data) && data[index+1] == '\n' {
				index++
			}
			currentLine++
			start = index + 1
			startLine = currentLine
			atFieldStart = true
		default:
			atFieldStart = false
		}
	}
	if inQuotes {
		return nil, io.ErrUnexpectedEOF
	}
	if start < len(data) {
		record, err := parseRecord(data[start:], delimiter, startLine, currentLine)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

func parseRecord(data []byte, delimiter rune, startLine, endLine int64) (physicalRecord, error) {
	values := make([]string, 0)
	if len(data) > 0 {
		reader := csv.NewReader(bytes.NewReader(data))
		reader.Comma = delimiter
		reader.FieldsPerRecord = -1
		parsed, err := reader.Read()
		if err != nil {
			return physicalRecord{}, err
		}
		if _, err := reader.Read(); err != io.EOF {
			return physicalRecord{}, io.ErrUnexpectedEOF
		}
		values = parsed
	}
	return physicalRecord{values: values, startRow: startLine, endRow: endLine}, nil
}

func clearOversizedCanonical(raw *importing.CanonicalRawEvidence, normalized *importing.NormalizedEvidence, identifiers *importing.SourceIdentifiers, issues *[]importing.EvidenceIssue) {
	// 中心模型各列的长度上限在这里提前转为行级错误；完整原值仍保留于 RawFields。
	canonical := []struct {
		value *string
		limit int
		field string
	}{
		{&raw.TransactionTime, 64, "transaction_time"}, {&raw.Amount, 64, "amount"}, {&raw.Direction, 32, "direction"},
		{&raw.Status, 128, "status"}, {&raw.TransactionType, 128, "transaction_type"}, {&raw.Counterparty, 255, "counterparty"},
		{&raw.Item, 255, "item"}, {&raw.PaymentMethod, 255, "payment_method"}, {&raw.Note, 1024, "note"},
	}
	for _, item := range canonical {
		if !utf8.ValidString(*item.value) || utf8.RuneCountInString(*item.value) > item.limit {
			*item.value = ""
			*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_UNSUPPORTED, Field: item.field, Severity: importing.ISSUE_SEVERITY_ERROR})
		}
	}
	ids := []*string{&identifiers.TransactionId, &identifiers.OrderId, &identifiers.MerchantOrderId}
	for _, id := range ids {
		if utf8.RuneCountInString(*id) > 255 {
			*id = ""
			*issues = append(*issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_IDENTIFIER_INVALID, Field: "identifier", Severity: importing.ISSUE_SEVERITY_ERROR})
		}
	}
	if utf8.RuneCountInString(normalized.Counterparty) > 255 {
		normalized.Counterparty = ""
	}
	if utf8.RuneCountInString(normalized.Item) > 255 {
		normalized.Item = ""
	}
	if utf8.RuneCountInString(normalized.PaymentMethod) > 255 {
		normalized.PaymentMethod = ""
	}
	if utf8.RuneCountInString(normalized.Note) > 1024 {
		normalized.Note = ""
	}
}
