package alipay

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

const (
	alipayEvidenceParserVersion        importing.RuleVersion = "alipay-evidence-parser-v1"
	alipayEvidenceNormalizationVersion importing.RuleVersion = "alipay-normalization-v2"

	alipayIssueSourceAccountMissing   importing.IssueCode = "alipay_source_account_missing"
	alipayIssueSourceAccountUnusable  importing.IssueCode = "alipay_source_account_unusable"
	alipayIssueStatementPeriodInvalid importing.IssueCode = "alipay_statement_period_invalid"
	alipayIssueRowColumnCountMismatch importing.IssueCode = "alipay_row_column_count_mismatch"
)

var (
	alipayStatementStartPattern = regexp.MustCompile(`起始(?:日期|时间)[[:space:]]*:[[:space:]]*\[?[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+[0-9]{2}:[0-9]{2}:[0-9]{2})`)
	alipayStatementEndPattern   = regexp.MustCompile(`终止(?:日期|时间)[[:space:]]*:[[:space:]]*\[?[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+[0-9]{2}:[0-9]{2}:[0-9]{2})`)
)

// AlipayAppImportEvidenceParser 与 AlipayWebImportEvidenceParser 是新持久导入流程的
// 无状态证据解析器。旧 TransactionDataImporter 入口继续使用原有实现。
var (
	AlipayAppImportEvidenceParser = newAlipayImportEvidenceParser(
		"alipay-app-csv",
		importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		AlipayAppTransactionDataCsvFileImporter.alipayTransactionDataCsvFileImporter,
		[]string{"交易订单号", "支付宝交易号", "交易号"},
		[]string{"订单号"},
		[]string{"商家订单号", "商户订单号"},
	)
	AlipayWebImportEvidenceParser = newAlipayImportEvidenceParser(
		"alipay-web-csv",
		importing.EVIDENCE_FORMAT_ALIPAY_WEB_CSV,
		AlipayWebTransactionDataCsvFileImporter.alipayTransactionDataCsvFileImporter,
		[]string{"交易号", "支付宝交易号", "交易订单号"},
		[]string{"订单号"},
		[]string{"商户订单号", "商家订单号"},
	)
)

var _ importing.ImportEvidenceParser = (*alipayImportEvidenceParser)(nil)

type alipayImportEvidenceParser struct {
	descriptor importing.ParserDescriptor
	spec       alipayEvidenceFormatSpec
}

type alipayEvidenceFormatSpec struct {
	fileHeaderLine string
	sectionMarkers []string
	columns        alipayEvidenceColumnAliases
}

type alipayEvidenceColumnAliases struct {
	time            []string
	transactionType []string
	counterparty    []string
	item            []string
	amount          []string
	direction       []string
	paymentMethod   []string
	status          []string
	note            []string
	transactionID   []string
	orderID         []string
	merchantOrderID []string
}

type alipayEvidenceColumnIndexes struct {
	time            int
	transactionType int
	counterparty    int
	item            int
	amount          int
	direction       int
	paymentMethod   int
	status          int
	note            int
	transactionID   int
	orderID         int
	merchantOrderID int
}

type alipayPhysicalCSVRecord struct {
	fields   []string
	startRow int64
	endRow   int64
}

type alipayFormatInspection struct {
	fileHeaderSeen bool
	sectionSeen    bool
	headerIndex    int
	headerValid    bool
	columns        alipayEvidenceColumnIndexes
}

func newAlipayImportEvidenceParser(name string, format importing.EvidenceFormat, legacy alipayTransactionDataCsvFileImporter, transactionID, orderID, merchantOrderID []string) *alipayImportEvidenceParser {
	columns := legacy.originalColumnNames

	return &alipayImportEvidenceParser{
		descriptor: importing.ParserDescriptor{
			Name:                 name,
			SourceType:           importing.SOURCE_TYPE_ALIPAY,
			Format:               format,
			ParserVersion:        alipayEvidenceParserVersion,
			NormalizationVersion: alipayEvidenceNormalizationVersion,
		},
		spec: alipayEvidenceFormatSpec{
			fileHeaderLine: legacy.fileHeaderLine,
			sectionMarkers: append([]string(nil), legacy.dataHeaderStartContent...),
			columns: alipayEvidenceColumnAliases{
				time:            alipayAliases(columns.timeColumnName),
				transactionType: alipayAliases(columns.categoryColumnName, "类型", "交易类型"),
				counterparty:    alipayAliases(columns.targetNameColumnName),
				item:            alipayAliases(columns.productNameColumnName, "商品名称", "商品说明"),
				amount:          alipayAliases(columns.amountColumnName),
				direction:       alipayAliases(columns.typeColumnName),
				paymentMethod:   alipayAliases(columns.relatedAccountColumnName, "付款方式", "收/付款方式", "资金渠道"),
				status:          alipayAliases(columns.statusColumnName),
				note:            alipayAliases(columns.descriptionColumnName),
				transactionID:   alipayAliases(transactionID...),
				orderID:         alipayAliases(orderID...),
				merchantOrderID: alipayAliases(merchantOrderID...),
			},
		},
	}
}

func alipayAliases(values ...string) []string {
	aliases := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))

	for _, value := range values {
		value = normalizeAlipayText(value)

		if value == "" {
			continue
		}

		if _, exists := seen[value]; exists {
			continue
		}

		seen[value] = struct{}{}
		aliases = append(aliases, value)
	}

	return aliases
}

// Descriptor 返回影响持久证据的解析与标准化版本。
func (p *alipayImportEvidenceParser) Descriptor() importing.ParserDescriptor {
	return p.descriptor
}

// Probe 只依据内容签名和数据表头区分 App/Web，不依赖文件名。
func (p *alipayImportEvidenceParser) Probe(ctx context.Context, file importing.EvidenceFile) importing.ProbeResult {
	decoded, err := decodeAlipayCSV(file.Content)

	if err != nil {
		return alipayUnmatchedProbe(importing.NormalizeEvidenceParseError(p.descriptor, err))
	}

	records, readErr := readAlipayPhysicalCSV(ctx, decoded)

	if readErr != nil && (errors.Is(readErr, context.Canceled) || errors.Is(readErr, context.DeadlineExceeded)) {
		return alipayUnmatchedProbe(importing.ISSUE_CODE_NONE)
	}

	inspection := p.inspect(records)
	issueCode := importing.ISSUE_CODE_NONE

	if readErr != nil {
		issueCode = importing.NormalizeEvidenceParseError(p.descriptor, readErr)
	}

	if inspection.fileHeaderSeen && inspection.sectionSeen && inspection.headerValid {
		return importing.ProbeResult{
			Confidence: importing.PROBE_CONFIDENCE_EXACT,
			SourceType: importing.SOURCE_TYPE_ALIPAY,
			Format:     p.descriptor.Format,
			IssueCode:  issueCode,
		}
	}

	if inspection.fileHeaderSeen || inspection.sectionSeen || inspection.headerIndex >= 0 {
		if issueCode == importing.ISSUE_CODE_NONE {
			issueCode = importing.ISSUE_CODE_FILE_STRUCTURE_INVALID
		}

		return importing.ProbeResult{
			Confidence: importing.PROBE_CONFIDENCE_POSSIBLE,
			SourceType: importing.SOURCE_TYPE_ALIPAY,
			Format:     p.descriptor.Format,
			IssueCode:  issueCode,
		}
	}

	return alipayUnmatchedProbe(issueCode)
}

// Parse 返回数据区内每一条逻辑 CSV 记录，包括结构或语义无效的记录。
func (p *alipayImportEvidenceParser) Parse(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	if err := opts.Validate(); err != nil {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_FORMAT_INVALID}
	}

	decoded, err := decodeAlipayCSV(file.Content)

	if err != nil {
		return nil, err
	}

	records, err := readAlipayPhysicalCSV(ctx, decoded)

	if err != nil {
		return nil, err
	}

	inspection := p.inspect(records)

	if !inspection.fileHeaderSeen || !inspection.sectionSeen {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_FORMAT_INVALID}
	}

	if !inspection.headerValid || inspection.headerIndex < 0 {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID}
	}

	metadata, documentIssues := parseAlipayDocumentMetadata(records[:inspection.headerIndex], opts)
	document := &importing.EvidenceDocument{
		Metadata: metadata,
		Rows:     make([]importing.EvidenceRow, 0, len(records)-inspection.headerIndex-1),
		Issues:   documentIssues,
	}
	header := records[inspection.headerIndex].fields

	for index := inspection.headerIndex + 1; index < len(records); index++ {
		if err := alipayContextError(ctx); err != nil {
			return nil, err
		}

		record := records[index]

		if isAlipaySeparatorRecord(record.fields) {
			break
		}

		row := parseAlipayEvidenceRow(int64(len(document.Rows)+1), record, header, inspection.columns, opts)
		document.Rows = append(document.Rows, row)
	}

	if _, err := importing.ValidateEvidenceDocument(p.descriptor, document); err != nil {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID}
	}

	return document, nil
}

func alipayUnmatchedProbe(issueCode importing.IssueCode) importing.ProbeResult {
	return importing.ProbeResult{
		Confidence: importing.PROBE_CONFIDENCE_NONE,
		IssueCode:  issueCode,
	}
}

func decodeAlipayCSV(content []byte) ([]byte, error) {
	if len(content) >= 2 && ((content[0] == 0xff && content[1] == 0xfe) || (content[0] == 0xfe && content[1] == 0xff)) {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_ENCODING_INVALID}
	}

	if bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}) {
		content = content[3:]
	}

	if utf8.Valid(content) {
		return bytes.Clone(content), nil
	}

	decoded, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), content)

	if err != nil || !utf8.Valid(decoded) || strings.ContainsRune(string(decoded), utf8.RuneError) {
		return nil, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_ENCODING_INVALID}
	}

	return decoded, nil
}

func readAlipayPhysicalCSV(ctx context.Context, content []byte) ([]alipayPhysicalCSVRecord, error) {
	reader := csv.NewReader(bytes.NewReader(content))
	reader.FieldsPerRecord = -1
	records := make([]alipayPhysicalCSVRecord, 0)
	nextPhysicalRow := int64(1)

	for {
		if err := alipayContextError(ctx); err != nil {
			return records, err
		}

		fields, err := reader.Read()

		if errors.Is(err, io.EOF) {
			records, err = appendAlipayEmptyPhysicalRecords(ctx, records, nextPhysicalRow, alipayCSVPhysicalRowCount(content))

			if err != nil {
				return records, err
			}

			return records, nil
		}

		if err != nil {
			return records, &importing.EvidenceParseError{Code: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID}
		}

		startRow, _ := reader.FieldPos(0)
		startPhysicalRow := int64(startRow)
		records, err = appendAlipayEmptyPhysicalRecords(ctx, records, nextPhysicalRow, startPhysicalRow-1)

		if err != nil {
			return records, err
		}

		endPhysicalRow := alipayCSVRecordEndRow(content, reader.InputOffset())
		records = append(records, alipayPhysicalCSVRecord{
			fields:   fields,
			startRow: startPhysicalRow,
			endRow:   endPhysicalRow,
		})
		nextPhysicalRow = endPhysicalRow + 1
	}
}

// encoding/csv 会忽略真正的空物理行。这里按相邻返回记录的物理行号补回零字段记录，
// 让上层能在识别出数据区后决定保留，而不会丢失原始位置证据。
func appendAlipayEmptyPhysicalRecords(ctx context.Context, records []alipayPhysicalCSVRecord, startRow, endRow int64) ([]alipayPhysicalCSVRecord, error) {
	for row := startRow; row <= endRow; row++ {
		if err := alipayContextError(ctx); err != nil {
			return records, err
		}

		records = append(records, alipayPhysicalCSVRecord{
			fields:   []string{},
			startRow: row,
			endRow:   row,
		})
	}

	return records, nil
}

func alipayCSVPhysicalRowCount(content []byte) int64 {
	if len(content) == 0 {
		return 0
	}

	rows := int64(bytes.Count(content, []byte{'\n'}))

	if content[len(content)-1] != '\n' {
		rows++
	}

	return rows
}

func alipayCSVRecordEndRow(content []byte, endOffset int64) int64 {
	if endOffset < 1 {
		return 1
	}

	if endOffset > int64(len(content)) {
		endOffset = int64(len(content))
	}

	line := alipayCSVPhysicalRowCount(content[:endOffset])

	if line < 1 {
		return 1
	}

	return line
}

func (p *alipayImportEvidenceParser) inspect(records []alipayPhysicalCSVRecord) alipayFormatInspection {
	inspection := alipayFormatInspection{
		headerIndex: -1,
		columns:     emptyAlipayEvidenceColumnIndexes(),
	}
	firstMeaningfulRecordSeen := false

	for index, record := range records {
		if isAlipayIgnorableRecord(record.fields) {
			continue
		}

		if !firstMeaningfulRecordSeen {
			firstMeaningfulRecordSeen = true
			inspection.fileHeaderSeen = alipayRecordStartsWith(record.fields, p.spec.fileHeaderLine)
		}

		if inspection.fileHeaderSeen && !inspection.sectionSeen && alipayRecordContainsAny(record.fields, p.spec.sectionMarkers) {
			inspection.sectionSeen = true
			continue
		}

		if !inspection.sectionSeen || inspection.headerIndex >= 0 || !p.looksLikeHeader(record.fields) {
			continue
		}

		inspection.headerIndex = index
		inspection.columns = p.resolveColumns(record.fields)
		inspection.headerValid = inspection.columns.time >= 0 &&
			inspection.columns.amount >= 0 &&
			inspection.columns.direction >= 0 &&
			inspection.columns.status >= 0
	}

	return inspection
}

func (p *alipayImportEvidenceParser) looksLikeHeader(fields []string) bool {
	return alipayHeaderContainsAlias(fields, p.spec.columns.time) || alipayHeaderContainsAlias(fields, p.spec.columns.amount)
}

func (p *alipayImportEvidenceParser) resolveColumns(header []string) alipayEvidenceColumnIndexes {
	aliases := p.spec.columns

	return alipayEvidenceColumnIndexes{
		time:            alipayFindColumn(header, aliases.time),
		transactionType: alipayFindColumn(header, aliases.transactionType),
		counterparty:    alipayFindColumn(header, aliases.counterparty),
		item:            alipayFindColumn(header, aliases.item),
		amount:          alipayFindColumn(header, aliases.amount),
		direction:       alipayFindColumn(header, aliases.direction),
		paymentMethod:   alipayFindColumn(header, aliases.paymentMethod),
		status:          alipayFindColumn(header, aliases.status),
		note:            alipayFindColumn(header, aliases.note),
		transactionID:   alipayFindColumn(header, aliases.transactionID),
		orderID:         alipayFindColumn(header, aliases.orderID),
		merchantOrderID: alipayFindColumn(header, aliases.merchantOrderID),
	}
}

func emptyAlipayEvidenceColumnIndexes() alipayEvidenceColumnIndexes {
	return alipayEvidenceColumnIndexes{
		time:            -1,
		transactionType: -1,
		counterparty:    -1,
		item:            -1,
		amount:          -1,
		direction:       -1,
		paymentMethod:   -1,
		status:          -1,
		note:            -1,
		transactionID:   -1,
		orderID:         -1,
		merchantOrderID: -1,
	}
}

func alipayFindColumn(header, aliases []string) int {
	for index, value := range header {
		normalized := normalizeAlipayText(value)

		for _, alias := range aliases {
			if normalized == alias {
				return index
			}
		}
	}

	return -1
}

func alipayHeaderContainsAlias(header, aliases []string) bool {
	return alipayFindColumn(header, aliases) >= 0
}

func alipayRecordStartsWith(fields []string, prefix string) bool {
	if len(fields) == 0 {
		return false
	}

	return strings.HasPrefix(normalizeAlipayText(fields[0]), normalizeAlipayText(prefix))
}

func alipayRecordContainsAny(fields, candidates []string) bool {
	for _, field := range fields {
		normalized := normalizeAlipayText(field)

		for _, candidate := range candidates {
			if strings.Contains(normalized, normalizeAlipayText(candidate)) {
				return true
			}
		}
	}

	return false
}

func isAlipayIgnorableRecord(fields []string) bool {
	for _, field := range fields {
		if normalizeAlipayText(field) != "" {
			return false
		}
	}

	return true
}

func isAlipaySeparatorRecord(fields []string) bool {
	if len(fields) == 0 {
		return false
	}

	separator := normalizeAlipayText(fields[0])

	if len(separator) < 10 {
		return false
	}

	for _, char := range separator {
		if char != '-' {
			return false
		}
	}

	for _, field := range fields[1:] {
		if normalizeAlipayText(field) != "" {
			return false
		}
	}

	return true
}

func parseAlipayDocumentMetadata(records []alipayPhysicalCSVRecord, opts importing.ResolvedParseOptions) (importing.DocumentMetadata, []importing.EvidenceIssue) {
	metadata := importing.DocumentMetadata{
		SourceType: importing.SOURCE_TYPE_ALIPAY,
	}
	issues := make([]importing.EvidenceIssue, 0, 2)
	metadata.SourceAccount, issues = parseAlipaySourceAccount(records, issues)

	var startText string
	var endText string
	sawStatementPeriodEvidence := false

	for _, record := range records {
		line := normalizeAlipayText(strings.Join(record.fields, ","))

		if containsAnyAlipayText(line, "起始日期", "起始时间", "终止日期", "终止时间") {
			sawStatementPeriodEvidence = true
		}

		if startText == "" {
			startText = extractAlipayStatementTime(line, alipayStatementStartPattern)
		}

		if endText == "" {
			endText = extractAlipayStatementTime(line, alipayStatementEndPattern)
		}
	}

	if startText == "" && endText == "" {
		if sawStatementPeriodEvidence {
			issues = append(issues, importing.EvidenceIssue{
				Code:     alipayIssueStatementPeriodInvalid,
				Field:    "statement_period",
				Severity: importing.ISSUE_SEVERITY_WARNING,
			})
		}

		return metadata, issues
	}

	start, startErr := utils.ParseFromLongDateTimeInFixedUtcOffset(startText, opts.TimezoneUtcOffset)
	end, endErr := utils.ParseFromLongDateTimeInFixedUtcOffset(endText, opts.TimezoneUtcOffset)

	if startErr != nil || endErr != nil || start.Unix() < 1 || end.Unix() < start.Unix() {
		issues = append(issues, importing.EvidenceIssue{
			Code:     alipayIssueStatementPeriodInvalid,
			Field:    "statement_period",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
		return metadata, issues
	}

	startUnix := start.Unix()
	endUnix := end.Unix()
	offset := opts.TimezoneUtcOffset
	metadata.StatementStartUnixTime = &startUnix
	metadata.StatementEndUnixTime = &endUnix
	metadata.StatementTimezoneUtcOffset = &offset

	return metadata, issues
}

func parseAlipaySourceAccount(records []alipayPhysicalCSVRecord, issues []importing.EvidenceIssue) (importing.SourceAccountCandidate, []importing.EvidenceIssue) {
	sawAccountEvidence := false

	for _, record := range records {
		for _, field := range record.fields {
			identifier, found := extractAlipayAccountIdentifier(field)

			if !found {
				continue
			}

			sawAccountEvidence = true
			stableCandidate := importing.SourceAccountCandidate{
				Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER,
				Identifier:      identifier,
				DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
			}

			if stableCandidate.Validate(importing.SOURCE_TYPE_ALIPAY) == nil {
				return stableCandidate, issues
			}

			maskedCandidate := importing.SourceAccountCandidate{
				Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY,
				DisplayName:     identifier,
				DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT,
			}

			if maskedCandidate.Validate(importing.SOURCE_TYPE_ALIPAY) == nil {
				return maskedCandidate, issues
			}
		}
	}

	issueCode := alipayIssueSourceAccountMissing

	if sawAccountEvidence {
		issueCode = alipayIssueSourceAccountUnusable
	}

	issues = append(issues, importing.EvidenceIssue{
		Code:     issueCode,
		Field:    "source_account",
		Severity: importing.ISSUE_SEVERITY_WARNING,
	})

	return importing.SourceAccountCandidate{
		Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MISSING,
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
	}, issues
}

func extractAlipayAccountIdentifier(value string) (string, bool) {
	normalized := normalizeAlipayText(value)
	labels := []string{"支付宝账户", "支付宝账号", "账号"}

	for _, label := range labels {
		if !strings.HasPrefix(normalized, label) {
			continue
		}

		remainder := strings.TrimSpace(strings.TrimPrefix(normalized, label))

		if remainder == "" || remainder[0] != ':' {
			continue
		}

		remainder = strings.TrimSpace(remainder[1:])
		remainder = strings.TrimSpace(strings.Trim(remainder, "[]【】"))

		if remainder == "" {
			return "", true
		}

		return remainder, true
	}

	return "", false
}

func extractAlipayStatementTime(line string, pattern *regexp.Regexp) string {
	matches := pattern.FindStringSubmatch(line)

	if len(matches) != 2 {
		return ""
	}

	return matches[1]
}

func parseAlipayEvidenceRow(rowNumber int64, record alipayPhysicalCSVRecord, header []string, columns alipayEvidenceColumnIndexes, opts importing.ResolvedParseOptions) importing.EvidenceRow {
	raw := importing.CanonicalRawEvidence{
		TransactionTime: alipayField(record.fields, columns.time),
		Amount:          alipayField(record.fields, columns.amount),
		Direction:       alipayField(record.fields, columns.direction),
		Status:          alipayField(record.fields, columns.status),
		TransactionType: alipayField(record.fields, columns.transactionType),
		Counterparty:    alipayField(record.fields, columns.counterparty),
		Item:            alipayField(record.fields, columns.item),
		PaymentMethod:   alipayField(record.fields, columns.paymentMethod),
		Note:            alipayField(record.fields, columns.note),
	}
	issues := make([]importing.EvidenceIssue, 0, 6)

	if len(record.fields) != len(header) {
		issues = append(issues, importing.EvidenceIssue{
			Code:     alipayIssueRowColumnCountMismatch,
			Field:    "columns",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	identifiers := importing.SourceIdentifiers{
		TransactionId:   normalizeAlipayIdentifier(alipayField(record.fields, columns.transactionID), "transaction_id", &issues),
		OrderId:         normalizeAlipayIdentifier(alipayField(record.fields, columns.orderID), "order_id", &issues),
		MerchantOrderId: normalizeAlipayIdentifier(alipayField(record.fields, columns.merchantOrderID), "merchant_order_id", &issues),
	}
	normalized := importing.NormalizedEvidence{
		TimezoneUtcOffset: opts.TimezoneUtcOffset,
		Currency:          opts.Currency,
		Counterparty:      normalizeAlipayText(raw.Counterparty),
		Item:              normalizeAlipayText(raw.Item),
		PaymentMethod:     normalizeAlipayText(raw.PaymentMethod),
		Note:              normalizeAlipayText(raw.Note),
	}

	parseAlipayRowTime(raw.TransactionTime, &normalized, &issues)
	parseAlipayRowAmount(raw.Amount, &normalized, &issues)
	normalized.Direction, normalized.TransactionType = normalizeAlipayTransactionSemantics(
		raw.TransactionType,
		raw.Item,
		normalizeAlipayDirection(raw.Direction),
	)

	if normalized.Direction == importing.NORMALIZED_DIRECTION_UNKNOWN {
		issues = append(issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN,
			Field:    "direction",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	normalized.EconomicEffect = normalizeAlipayEconomicEffect(raw.Status)

	if normalized.EconomicEffect == importing.ECONOMIC_EFFECT_UNKNOWN {
		issues = append(issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_STATUS_UNKNOWN,
			Field:    "status",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if normalized.TransactionType == importing.SOURCE_TRANSACTION_TYPE_UNKNOWN {
		issues = append(issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN,
			Field:    "transaction_type",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	parseStatus := importing.PARSE_STATE_VALID

	for _, issue := range issues {
		if issue.Severity == importing.ISSUE_SEVERITY_ERROR {
			parseStatus = importing.PARSE_STATE_INVALID
			break
		}
	}

	return importing.EvidenceRow{
		RowNumber: rowNumber,
		Locator: importing.SourceLocator{
			Kind:        importing.LOCATOR_KIND_CSV,
			CSVStartRow: record.startRow,
			CSVEndRow:   record.endRow,
		},
		RawFields:   makeAlipayRawFields(header, record.fields),
		Raw:         raw,
		Identifiers: identifiers,
		Normalized:  normalized,
		FingerprintMaterials: importing.StrongFingerprintMaterials{
			Counterparty:  normalized.Counterparty,
			Item:          normalized.Item,
			PaymentMethod: normalized.PaymentMethod,
		},
		ParseStatus: parseStatus,
		Issues:      issues,
	}
}

func makeAlipayRawFields(header, values []string) []importing.RawField {
	fields := make([]importing.RawField, len(values))

	for index, value := range values {
		name := ""

		if index < len(header) {
			name = header[index]
		}

		fields[index] = importing.RawField{Name: name, Value: value}
	}

	return fields
}

func alipayField(fields []string, index int) string {
	if index < 0 || index >= len(fields) {
		return ""
	}

	return fields[index]
}

func normalizeAlipayIdentifier(value, field string, issues *[]importing.EvidenceIssue) string {
	normalized := normalizeAlipayText(value)

	if utf8.RuneCountInString(normalized) <= 255 {
		return normalized
	}

	*issues = append(*issues, importing.EvidenceIssue{
		Code:     importing.ISSUE_CODE_ROW_IDENTIFIER_INVALID,
		Field:    field,
		Severity: importing.ISSUE_SEVERITY_WARNING,
	})

	return ""
}

func parseAlipayRowTime(value string, normalized *importing.NormalizedEvidence, issues *[]importing.EvidenceIssue) {
	text := normalizeAlipayText(value)

	if text == "" {
		*issues = append(*issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_FIELD_MISSING,
			Field:    "transaction_time",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		return
	}

	parsed, err := utils.ParseFromLongDateTimeInFixedUtcOffset(text, normalized.TimezoneUtcOffset)

	if err != nil || parsed.Unix() < 1 {
		*issues = append(*issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_TIME_INVALID,
			Field:    "transaction_time",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		return
	}

	unixTime := parsed.Unix()
	normalized.UnixTime = &unixTime
}

func parseAlipayRowAmount(value string, normalized *importing.NormalizedEvidence, issues *[]importing.EvidenceIssue) {
	text := normalizeAlipayText(value)

	if text == "" {
		*issues = append(*issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_FIELD_MISSING,
			Field:    "amount",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		return
	}

	amount, err := utils.ParseAmount(text)

	if err != nil || amount < 0 {
		*issues = append(*issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_AMOUNT_INVALID,
			Field:    "amount",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		return
	}

	normalized.Amount = &amount
}

func normalizeAlipayDirection(value string) importing.NormalizedDirection {
	switch normalizeAlipayText(value) {
	case "收入":
		return importing.NORMALIZED_DIRECTION_INCOME
	case "支出":
		return importing.NORMALIZED_DIRECTION_EXPENSE
	case "不计收支":
		return importing.NORMALIZED_DIRECTION_NEUTRAL
	default:
		return importing.NORMALIZED_DIRECTION_UNKNOWN
	}
}

func normalizeAlipayEconomicEffect(value string) importing.EconomicEffect {
	switch normalizeAlipayText(value) {
	case alipayTransactionDataStatusSuccessName,
		alipayTransactionDataStatusPaymentSuccessName,
		alipayTransactionDataStatusPendingGoodsReceiptConfirmationName,
		alipayTransactionDataStatusRepaymentSuccessName,
		"交易完成", "已完成", "收款成功", "成功":
		return importing.ECONOMIC_EFFECT_NORMAL
	case alipayTransactionDataStatusRefundSuccessName,
		alipayTransactionDataStatusTaxRefundSuccessName,
		"已退款":
		return importing.ECONOMIC_EFFECT_REFUND
	case alipayTransactionDataStatusClosedName,
		"已关闭", "交易取消", "已取消", "交易撤销", "已撤销":
		return importing.ECONOMIC_EFFECT_CLOSED
	case "交易失败", "支付失败", "收款失败", "还款失败", "失败":
		return importing.ECONOMIC_EFFECT_FAILED
	default:
		return importing.ECONOMIC_EFFECT_UNKNOWN
	}
}

func normalizeAlipayTransactionSemantics(rawType, rawItem string, direction importing.NormalizedDirection) (importing.NormalizedDirection, importing.SourceTransactionType) {
	switch classifyAlipayProductAction(rawItem) {
	case alipayProductActionEarning:
		return importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER
	case alipayProductActionTransferToWallet:
		return direction, importing.SOURCE_TRANSACTION_TYPE_TOP_UP
	case alipayProductActionTransferFromWallet:
		return direction, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL
	case alipayProductActionPurchaseInvestment,
		alipayProductActionPurchaseInvestmentRefund,
		alipayProductActionSellInvestment,
		alipayProductActionTransferIn,
		alipayProductActionTransferOut,
		alipayProductActionTransfer,
		alipayProductActionRepayment:
		return direction, importing.SOURCE_TRANSACTION_TYPE_TRANSFER
	}

	return direction, normalizeAlipaySourceTransactionType(rawType, rawItem, direction)
}

func normalizeAlipaySourceTransactionType(rawType, rawItem string, direction importing.NormalizedDirection) importing.SourceTransactionType {
	typeText := normalizeAlipayText(rawType)
	itemText := normalizeAlipayText(rawItem)

	if typeText != "" {
		if transactionType := classifyAlipaySourceTransactionType(typeText); transactionType != importing.SOURCE_TRANSACTION_TYPE_UNKNOWN {
			return transactionType
		}
	}

	if transactionType := classifyAlipaySourceTransactionType(itemText); transactionType != importing.SOURCE_TRANSACTION_TYPE_UNKNOWN {
		return transactionType
	}

	if direction == importing.NORMALIZED_DIRECTION_INCOME || direction == importing.NORMALIZED_DIRECTION_EXPENSE {
		return importing.SOURCE_TRANSACTION_TYPE_PAYMENT
	}

	return importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
}

func classifyAlipaySourceTransactionType(value string) importing.SourceTransactionType {
	if value == "" {
		return importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
	}

	if containsAnyAlipayText(value, "手续费", "服务费") {
		return importing.SOURCE_TRANSACTION_TYPE_FEE
	}

	if strings.Contains(value, "充值") {
		return importing.SOURCE_TRANSACTION_TYPE_TOP_UP
	}

	if strings.Contains(value, "提现") {
		return importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL
	}

	if containsAnyAlipayText(value, "转账", "还款", "转入", "转出", "理财", "投资", "借款", "资金调拨", "余额宝", "买入", "卖出") {
		return importing.SOURCE_TRANSACTION_TYPE_TRANSFER
	}

	if containsAnyAlipayText(value, "消费", "购物", "餐饮", "出行", "缴费", "付款", "收款", "退款", "收入", "支出", "红包", "交易", "医疗", "教育", "娱乐") {
		return importing.SOURCE_TRANSACTION_TYPE_PAYMENT
	}

	return importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
}

func containsAnyAlipayText(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}

	return false
}

func normalizeAlipayText(value string) string {
	value = strings.TrimPrefix(value, "\ufeff")
	return strings.TrimSpace(norm.NFKC.String(value))
}

func alipayContextError(ctx context.Context) error {
	if ctx == nil {
		return nil
	}

	return ctx.Err()
}
