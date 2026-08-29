package genericbank

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/gaohongxiang/catledger/pkg/converters/datatable"
	"github.com/gaohongxiang/catledger/pkg/converters/excel"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

const (
	csvParserName        = "generic_bank_csv"
	xlsParserName        = "generic_bank_xls"
	xlsxParserName       = "generic_bank_xlsx"
	csvParserVersion     = importing.RuleVersion("generic-bank-csv-parser-v2")
	xlsParserVersion     = importing.RuleVersion("generic-bank-xls-parser-v2")
	xlsxParserVersion    = importing.RuleVersion("generic-bank-xlsx-parser-v2")
	normalizationVersion = importing.RuleVersion("generic-bank-normalization-v2")
)

type tableContainer uint8

const (
	tableContainerCSV tableContainer = iota
	tableContainerXLS
	tableContainerXLSX
)

// 三种 parser 只区分文件容器，列映射、自动推断和标准化逻辑完全共用。
var (
	ImportEvidenceCSVParser importing.ImportEvidenceParser = &genericBankTableParser{
		name: csvParserName, version: csvParserVersion, format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV, container: tableContainerCSV,
	}
	ImportEvidenceXLSParser importing.ImportEvidenceParser = &genericBankTableParser{
		name: xlsParserName, version: xlsParserVersion, format: importing.EVIDENCE_FORMAT_BANK_GENERIC_XLS, container: tableContainerXLS,
	}
	ImportEvidenceXLSXParser importing.ImportEvidenceParser = &genericBankTableParser{
		name: xlsxParserName, version: xlsxParserVersion, format: importing.EVIDENCE_FORMAT_BANK_GENERIC_XLSX, container: tableContainerXLSX,
	}
)

type genericBankTableParser struct {
	name      string
	version   importing.RuleVersion
	format    importing.EvidenceFormat
	container tableContainer
}

type physicalRecord struct {
	values  []string
	locator importing.SourceLocator
}

type csvEncodingError struct {
	err error
}

func (e *csvEncodingError) Error() string { return e.err.Error() }
func (e *csvEncodingError) Unwrap() error { return e.err }

func (p *genericBankTableParser) Descriptor() importing.ParserDescriptor {
	return importing.ParserDescriptor{
		Name:                  p.name,
		SourceType:            importing.SOURCE_TYPE_BANK,
		Format:                p.format,
		ParserVersion:         p.version,
		NormalizationVersion:  normalizationVersion,
		ExplicitSelectionOnly: false,
	}
}

// Probe 只确认文件容器可由原项目成熟读取器打开；列布局由后续安全推断或用户映射确定。
func (p *genericBankTableParser) Probe(ctx context.Context, file importing.EvidenceFile) importing.ProbeResult {
	if ctx.Err() != nil || len(file.Content) == 0 {
		return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
	}
	if p.container != tableContainerCSV {
		if (p.container == tableContainerXLS && !hasMSCFBHeader(file.Content)) ||
			(p.container == tableContainerXLSX && !hasOOXMLHeader(file.Content)) {
			return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
		}
		tables, err := readSpreadsheetTables(file.Content, p.container)
		if err != nil || len(tables) == 0 {
			return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
		}
		return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_POSSIBLE, SourceType: importing.SOURCE_TYPE_BANK, Format: p.format}
	}
	if bytes.HasPrefix(file.Content, []byte{'P', 'K', 0x03, 0x04}) {
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
					Format:     p.format,
				}
			}
		}
	}

	return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
}

func hasMSCFBHeader(content []byte) bool {
	return len(content) >= 8 && bytes.Equal(content[:8], []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
}

func hasOOXMLHeader(content []byte) bool {
	return len(content) >= 4 && bytes.Equal(content[:4], []byte{'P', 'K', 0x03, 0x04})
}

func (p *genericBankTableParser) Parse(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	descriptor := p.Descriptor()
	if err := opts.ValidateForDescriptor(descriptor); err != nil || opts.GenericBankMapping == nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	mapping, err := importing.NormalizeGenericBankMapping(*opts.GenericBankMapping)
	if err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	records, err := p.readPhysicalRecords(ctx, file.Content, mapping)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if p.container == tableContainerCSV && errorsIsEncoding(err) {
			return nil, parseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
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

	dataEnd := len(records)
	if mapping.DataEndRow > 0 {
		if mapping.DataEndRow > len(records) {
			return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
		}
		dataEnd = mapping.DataEndRow
	}
	if mapping.DataStartRow > dataEnd {
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
		Rows: make([]importing.EvidenceRow, 0, dataEnd-mapping.DataStartRow+1),
	}
	for index := mapping.DataStartRow - 1; index < dataEnd; index++ {
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

func (p *genericBankTableParser) readPhysicalRecords(ctx context.Context, content []byte, mapping importing.GenericBankMapping) ([]physicalRecord, error) {
	if p.container == tableContainerCSV {
		decoded, err := decodeContent(content, mapping.Encoding)
		if err != nil {
			return nil, &csvEncodingError{err: err}
		}
		delimiter := ','
		if mapping.Delimiter == importing.GENERIC_CSV_DELIMITER_TAB {
			delimiter = '\t'
		}
		return readPhysicalRecords(ctx, decoded, delimiter)
	}

	tables, err := readSpreadsheetTables(content, p.container)
	if err != nil {
		return nil, err
	}
	var selected excel.WorksheetDataTable
	for _, table := range tables {
		worksheet, ok := table.(excel.WorksheetDataTable)
		if ok && worksheet.WorksheetIndex() == mapping.SheetIndex {
			selected = worksheet
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("worksheet %d does not exist", mapping.SheetIndex)
	}

	sheetName := selected.WorksheetName()
	if sheetName == "" {
		sheetName = fmt.Sprintf("Sheet%d", selected.WorksheetIndex()+1)
	}
	rows := selected.PhysicalRows()
	records := make([]physicalRecord, len(rows))
	for rowIndex, values := range rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		records[rowIndex] = physicalRecord{
			values: append([]string(nil), values...),
			locator: importing.SourceLocator{
				Kind:       importing.LOCATOR_KIND_SPREADSHEET,
				SheetIndex: selected.WorksheetIndex(),
				SheetName:  sheetName,
				XLSXRow:    int64(rowIndex + 1),
			},
		}
	}
	return records, nil
}

func readSpreadsheetTables(content []byte, container tableContainer) ([]datatable.BasicDataTable, error) {
	switch container {
	case tableContainerXLS:
		return excel.CreateNewExcelMSCFBFileBasicDataTables(content, false)
	case tableContainerXLSX:
		return excel.CreateNewExcelOOXMLFileBasicDataTables(content, false)
	default:
		return nil, fmt.Errorf("unsupported spreadsheet container")
	}
}

func errorsIsEncoding(err error) bool {
	var encodingErr *csvEncodingError
	return errors.As(err, &encodingErr)
}

func buildRow(rowNumber int64, record physicalRecord, header []string, mapping importing.GenericBankMapping, opts importing.ResolvedParseOptions) importing.EvidenceRow {
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
	if mapping.PaymentMethodPrefix != "" && strings.TrimSpace(raw.PaymentMethod) != "" {
		raw.PaymentMethod = mapping.PaymentMethodPrefix + "(" + strings.TrimSpace(raw.PaymentMethod) + ")"
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
		Locator:              record.locator,
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

func parseAmountAndDirection(values []string, mapping importing.GenericBankMapping, normalized *importing.NormalizedEvidence, issues *[]importing.EvidenceIssue) {
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
		var negative bool
		var valid bool
		amountText, negative, valid = normalizeSignedAmount(get(mapping.AmountColumn))
		if !valid {
			amountText = ""
		}
		direction = mapping.SignedPositiveDirection
		if negative {
			direction = oppositeDirection(direction)
		}
	case importing.GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION:
		amountText, _, _ = normalizeSignedAmount(get(mapping.AmountColumn))
		rawDirection := strings.ToLower(normalizeText(get(mapping.DirectionColumn)))
		if contains(mapping.IncomeValues, rawDirection) {
			direction = importing.NORMALIZED_DIRECTION_INCOME
		}
		if contains(mapping.ExpenseValues, rawDirection) {
			direction = importing.NORMALIZED_DIRECTION_EXPENSE
		}
	case importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE:
		income, _, incomeValid := normalizeSignedAmount(get(mapping.IncomeColumn))
		expense, _, expenseValid := normalizeSignedAmount(get(mapping.ExpenseColumn))
		if !incomeValid {
			income = ""
		}
		if !expenseValid {
			expense = ""
		}
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

func normalizeSignedAmount(value string) (unsigned string, negative bool, ok bool) {
	value = strings.ReplaceAll(normalizeText(value), " ", "")
	if value == "" {
		return "", false, false
	}
	if strings.HasPrefix(value, "(") && strings.HasSuffix(value, ")") {
		negative = true
		value = value[1 : len(value)-1]
	}
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		negative = negative || strings.HasPrefix(value, "-")
		value = value[1:]
	}
	value = strings.ToUpper(value)
	for _, prefix := range []string{"CNY", "RMB", "¥", "￥"} {
		value = strings.TrimPrefix(value, prefix)
	}
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		negative = negative || strings.HasPrefix(value, "-")
		value = value[1:]
	}
	for _, suffix := range []string{"CNY", "RMB", "元"} {
		value = strings.TrimSuffix(value, suffix)
	}
	if value == "" {
		return "", false, false
	}
	return value, negative, true
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

func mappingColumnsFit(mapping importing.GenericBankMapping, width int) bool {
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
	return physicalRecord{
		values:  values,
		locator: importing.SourceLocator{Kind: importing.LOCATOR_KIND_CSV, CSVStartRow: startLine, CSVEndRow: endLine},
	}, nil
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
