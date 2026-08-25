package wechat

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

type wechatEvidenceField string

const (
	wechatEvidenceFieldTransactionTime wechatEvidenceField = "transaction_time"
	wechatEvidenceFieldTransactionType wechatEvidenceField = "transaction_type"
	wechatEvidenceFieldCounterparty    wechatEvidenceField = "counterparty"
	wechatEvidenceFieldItem            wechatEvidenceField = "item"
	wechatEvidenceFieldDirection       wechatEvidenceField = "direction"
	wechatEvidenceFieldAmount          wechatEvidenceField = "amount"
	wechatEvidenceFieldPaymentMethod   wechatEvidenceField = "payment_method"
	wechatEvidenceFieldStatus          wechatEvidenceField = "status"
	wechatEvidenceFieldTransactionId   wechatEvidenceField = "transaction_id"
	wechatEvidenceFieldOrderId         wechatEvidenceField = "order_id"
	wechatEvidenceFieldMerchantOrderId wechatEvidenceField = "merchant_order_id"
	wechatEvidenceFieldNote            wechatEvidenceField = "note"
)

var wechatStatementPeriodPattern = regexp.MustCompile(`(?:起始|开始)时间\s*:?\s*\[?\s*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*\]?\s*(?:终止|结束)时间\s*:?\s*\[?\s*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*\]?`)

type wechatEvidencePhysicalRow struct {
	values         []string
	csvStartRow    int64
	csvEndRow      int64
	xlsxRow        int64
	formulaColumns map[int]bool
}

type wechatEvidenceSheet struct {
	format     importing.EvidenceFormat
	sheetIndex int
	sheetName  string
	rows       []wechatEvidencePhysicalRow
}

type wechatEvidenceHeader struct {
	positions  map[wechatEvidenceField]int
	knownCount int
}

type wechatEvidenceSheetAnalysis struct {
	headerIndex int
	header      wechatEvidenceHeader
	hasMarker   bool
}

type wechatEvidenceSummary struct {
	headerCount int
	hasMarker   bool
}

type wechatEvidenceMetadataBuilder struct {
	nicknames    []string
	periodStarts []int64
	periodEnds   []int64
	issues       []importing.EvidenceIssue
}

func summarizeWechatEvidenceSheets(sheets []wechatEvidenceSheet) wechatEvidenceSummary {
	summary := wechatEvidenceSummary{}

	for _, sheet := range sheets {
		analysis := analyzeWechatEvidenceSheet(sheet)

		if analysis.headerIndex >= 0 {
			summary.headerCount++
		}

		if analysis.hasMarker {
			summary.hasMarker = true
		}
	}

	return summary
}

func buildWechatEvidenceDocument(ctx context.Context, descriptor importing.ParserDescriptor, sheets []wechatEvidenceSheet, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	document := &importing.EvidenceDocument{
		Metadata: importing.DocumentMetadata{
			SourceType: descriptor.SourceType,
			SourceAccount: importing.SourceAccountCandidate{
				Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MISSING,
				DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
			},
		},
		Rows:   make([]importing.EvidenceRow, 0),
		Issues: make([]importing.EvidenceIssue, 0),
	}

	metadata := &wechatEvidenceMetadataBuilder{}
	matchedSheets := 0
	hasMarker := false
	rowNumber := int64(0)

	for _, sheet := range sheets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		analysis := analyzeWechatEvidenceSheet(sheet)

		if analysis.hasMarker {
			hasMarker = true
		}

		if analysis.headerIndex < 0 {
			if analysis.hasMarker {
				metadata.observePreamble(sheet.rows, opts)
				document.Issues = appendUniqueWechatIssue(document.Issues, importing.EvidenceIssue{
					Code:     wechatPayIssueSheetStructure,
					Field:    "sheet",
					Severity: importing.ISSUE_SEVERITY_WARNING,
				})
			}

			continue
		}

		matchedSheets++
		metadata.observePreamble(sheet.rows[:analysis.headerIndex], opts)
		headers := sheet.rows[analysis.headerIndex].values

		for _, physicalRow := range sheet.rows[analysis.headerIndex+1:] {
			if err := ctx.Err(); err != nil {
				return nil, err
			}

			rowNumber++
			row, err := buildWechatEvidenceRow(descriptor.Format, sheet, headers, analysis.header, physicalRow, rowNumber, opts)

			if err != nil {
				return nil, err
			}

			document.Rows = append(document.Rows, row)
		}
	}

	if matchedSheets == 0 {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	if !hasMarker {
		document.Issues = appendUniqueWechatIssue(document.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueFilePreambleMissing,
			Field:    "preamble",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	document.Metadata = metadata.build(descriptor.SourceType, opts, document.Metadata)
	document.Issues = append(document.Issues, metadata.issues...)

	if len(document.Rows) == 0 {
		document.Issues = appendUniqueWechatIssue(document.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueDocumentNoRows,
			Field:    "rows",
			Severity: importing.ISSUE_SEVERITY_INFO,
		})
	}

	return document, nil
}

func analyzeWechatEvidenceSheet(sheet wechatEvidenceSheet) wechatEvidenceSheetAnalysis {
	analysis := wechatEvidenceSheetAnalysis{headerIndex: -1}

	for index, row := range sheet.rows {
		if rowContainsWechatEvidenceMarker(row.values) {
			analysis.hasMarker = true
		}

		header := inspectWechatEvidenceHeader(row.values)

		if !header.hasCoreFields() {
			continue
		}

		if analysis.hasMarker || header.knownCount >= 5 {
			analysis.headerIndex = index
			analysis.header = header
			break
		}
	}

	return analysis
}

func inspectWechatEvidenceHeader(values []string) wechatEvidenceHeader {
	header := wechatEvidenceHeader{positions: make(map[wechatEvidenceField]int)}

	for index, value := range values {
		field := canonicalWechatEvidenceHeader(value)

		if field == "" {
			continue
		}

		if _, exists := header.positions[field]; !exists {
			header.positions[field] = index
			header.knownCount++
		}
	}

	return header
}

func (h wechatEvidenceHeader) hasCoreFields() bool {
	_, hasTime := h.positions[wechatEvidenceFieldTransactionTime]
	_, hasAmount := h.positions[wechatEvidenceFieldAmount]
	return hasTime && hasAmount
}

func canonicalWechatEvidenceHeader(value string) wechatEvidenceField {
	value = strings.ReplaceAll(normalizeWechatEvidenceText(value, false), " ", "")

	switch value {
	case "交易时间", "交易日期":
		return wechatEvidenceFieldTransactionTime
	case "交易类型", "业务类型":
		return wechatEvidenceFieldTransactionType
	case "交易对方", "交易对象", "对方":
		return wechatEvidenceFieldCounterparty
	case "商品", "商品说明", "商品名称":
		return wechatEvidenceFieldItem
	case "收/支", "收支", "收支类型":
		return wechatEvidenceFieldDirection
	case "金额(元)", "交易金额(元)", "金额":
		return wechatEvidenceFieldAmount
	case "支付方式", "付款方式":
		return wechatEvidenceFieldPaymentMethod
	case "当前状态", "交易状态", "状态":
		return wechatEvidenceFieldStatus
	case "交易单号", "微信交易单号":
		return wechatEvidenceFieldTransactionId
	case "订单号":
		return wechatEvidenceFieldOrderId
	case "商户单号", "商家单号":
		return wechatEvidenceFieldMerchantOrderId
	case "备注", "交易备注":
		return wechatEvidenceFieldNote
	default:
		return ""
	}
}

func rowContainsWechatEvidenceMarker(values []string) bool {
	for _, value := range values {
		if strings.Contains(normalizeWechatEvidenceText(value, false), wechatPayTransactionDataCsvFileHeader) {
			return true
		}
	}

	return false
}

func buildWechatEvidenceRow(format importing.EvidenceFormat, sheet wechatEvidenceSheet, headers []string, header wechatEvidenceHeader, physicalRow wechatEvidencePhysicalRow, rowNumber int64, opts importing.ResolvedParseOptions) (importing.EvidenceRow, error) {
	rawFields := make([]importing.RawField, 0, len(physicalRow.values))

	for index, value := range physicalRow.values {
		name := ""

		if index < len(headers) {
			name = headers[index]
		}

		rawFields = append(rawFields, importing.RawField{Name: name, Value: value})
	}

	if _, err := importing.MarshalRawFields(rawFields); err != nil {
		return importing.EvidenceRow{}, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	row := importing.EvidenceRow{
		RowNumber:   rowNumber,
		Locator:     newWechatEvidenceLocator(format, sheet, physicalRow),
		RawFields:   rawFields,
		ParseStatus: importing.PARSE_STATE_VALID,
		Normalized: importing.NormalizedEvidence{
			TimezoneUtcOffset: opts.TimezoneUtcOffset,
			Currency:          opts.Currency,
			Direction:         importing.NORMALIZED_DIRECTION_UNKNOWN,
			TransactionType:   importing.SOURCE_TRANSACTION_TYPE_UNKNOWN,
			EconomicEffect:    importing.ECONOMIC_EFFECT_UNKNOWN,
		},
		Issues: make([]importing.EvidenceIssue, 0),
	}

	projected, oversizedFields := projectWechatCanonicalRaw(header, physicalRow.values, &row.Issues)
	row.Raw = projected

	if len(physicalRow.values) > len(headers) {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueRowExtraColumns,
			Field:    "row",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if allWechatEvidenceCellsEmpty(physicalRow.values) {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueRowEmpty,
			Field:    "row",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		row.ParseStatus = importing.PARSE_STATE_INVALID
		return row, nil
	}

	if repeatedHeader := inspectWechatEvidenceHeader(physicalRow.values); repeatedHeader.hasCoreFields() && repeatedHeader.knownCount >= 2 {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueRowRepeatedHeader,
			Field:    "row",
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
		row.ParseStatus = importing.PARSE_STATE_INVALID
		return row, nil
	}

	if len(physicalRow.formulaColumns) > 0 {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     wechatPayIssueXlsxFormula,
			Field:    firstWechatFormulaField(header, physicalRow.formulaColumns),
			Severity: importing.ISSUE_SEVERITY_ERROR,
		})
	}

	row.Identifiers = normalizeWechatSourceIdentifiers(header, physicalRow.values, &row.Issues)
	row.Normalized.Counterparty = normalizeWechatEvidenceText(row.Raw.Counterparty, true)
	row.Normalized.Item = normalizeWechatEvidenceText(row.Raw.Item, true)
	row.Normalized.PaymentMethod = normalizeWechatEvidenceText(row.Raw.PaymentMethod, true)
	row.Normalized.Note = normalizeWechatEvidenceText(row.Raw.Note, true)
	row.FingerprintMaterials = importing.StrongFingerprintMaterials{
		Counterparty:  row.Normalized.Counterparty,
		Item:          row.Normalized.Item,
		PaymentMethod: row.Normalized.PaymentMethod,
	}

	if !oversizedFields[wechatEvidenceFieldTransactionTime] {
		normalizedTime := normalizeWechatEvidenceText(row.Raw.TransactionTime, false)

		if normalizedTime == "" {
			row.Issues = append(row.Issues, missingWechatEvidenceFieldIssue("transaction_time"))
		} else if parsedTime, err := utils.ParseFromLongDateTimeInFixedUtcOffset(normalizedTime, opts.TimezoneUtcOffset); err != nil || parsedTime.Unix() < 1 {
			row.Issues = append(row.Issues, importing.EvidenceIssue{
				Code:     importing.ISSUE_CODE_ROW_TIME_INVALID,
				Field:    "transaction_time",
				Severity: importing.ISSUE_SEVERITY_ERROR,
			})
		} else {
			unixTime := parsedTime.Unix()
			row.Normalized.UnixTime = &unixTime
		}
	}

	if !oversizedFields[wechatEvidenceFieldAmount] {
		normalizedAmount := normalizeWechatEvidenceText(row.Raw.Amount, false)

		if normalizedAmount == "" {
			row.Issues = append(row.Issues, missingWechatEvidenceFieldIssue("amount"))
		} else if amount, ok := parseWechatEvidenceAmount(normalizedAmount); !ok {
			row.Issues = append(row.Issues, importing.EvidenceIssue{
				Code:     importing.ISSUE_CODE_ROW_AMOUNT_INVALID,
				Field:    "amount",
				Severity: importing.ISSUE_SEVERITY_ERROR,
			})
		} else {
			row.Normalized.Amount = &amount
		}
	}

	if !oversizedFields[wechatEvidenceFieldDirection] {
		row.Normalized.Direction = normalizeWechatEvidenceDirection(row.Raw.Direction)
	}

	if row.Normalized.Direction == importing.NORMALIZED_DIRECTION_UNKNOWN {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN,
			Field:    "direction",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if !oversizedFields[wechatEvidenceFieldTransactionType] {
		row.Normalized.TransactionType = normalizeWechatEvidenceTransactionType(row.Raw.TransactionType)
	}

	if row.Normalized.TransactionType == importing.SOURCE_TRANSACTION_TYPE_UNKNOWN {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN,
			Field:    "transaction_type",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if !oversizedFields[wechatEvidenceFieldStatus] && !oversizedFields[wechatEvidenceFieldTransactionType] {
		row.Normalized.EconomicEffect = normalizeWechatEvidenceEconomicEffect(row.Raw.TransactionType, row.Raw.Status)
	}

	if row.Normalized.EconomicEffect == importing.ECONOMIC_EFFECT_UNKNOWN {
		row.Issues = append(row.Issues, importing.EvidenceIssue{
			Code:     importing.ISSUE_CODE_ROW_STATUS_UNKNOWN,
			Field:    "status",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if hasWechatEvidenceErrorIssue(row.Issues) {
		row.ParseStatus = importing.PARSE_STATE_INVALID
	}

	return row, nil
}

func newWechatEvidenceLocator(format importing.EvidenceFormat, sheet wechatEvidenceSheet, row wechatEvidencePhysicalRow) importing.SourceLocator {
	if format == importing.EVIDENCE_FORMAT_WECHAT_XLSX {
		return importing.SourceLocator{
			Kind:       importing.LOCATOR_KIND_XLSX,
			SheetIndex: sheet.sheetIndex,
			SheetName:  sheet.sheetName,
			XLSXRow:    row.xlsxRow,
		}
	}

	return importing.SourceLocator{
		Kind:        importing.LOCATOR_KIND_CSV,
		CSVStartRow: row.csvStartRow,
		CSVEndRow:   row.csvEndRow,
	}
}

func projectWechatCanonicalRaw(header wechatEvidenceHeader, values []string, issues *[]importing.EvidenceIssue) (importing.CanonicalRawEvidence, map[wechatEvidenceField]bool) {
	oversized := make(map[wechatEvidenceField]bool)
	value := func(field wechatEvidenceField, limit int) string {
		raw := wechatEvidenceValue(header, values, field)

		if !utf8.ValidString(raw) || utf8.RuneCountInString(raw) > limit {
			oversized[field] = true
			*issues = append(*issues, importing.EvidenceIssue{
				Code:     wechatPayIssueRowFieldTooLong,
				Field:    string(field),
				Severity: importing.ISSUE_SEVERITY_ERROR,
			})
			return ""
		}

		return raw
	}

	return importing.CanonicalRawEvidence{
		TransactionTime: value(wechatEvidenceFieldTransactionTime, 64),
		Amount:          value(wechatEvidenceFieldAmount, 64),
		Direction:       value(wechatEvidenceFieldDirection, 32),
		Status:          value(wechatEvidenceFieldStatus, 128),
		TransactionType: value(wechatEvidenceFieldTransactionType, 128),
		Counterparty:    value(wechatEvidenceFieldCounterparty, 255),
		Item:            value(wechatEvidenceFieldItem, 255),
		PaymentMethod:   value(wechatEvidenceFieldPaymentMethod, 255),
		Note:            value(wechatEvidenceFieldNote, 1024),
	}, oversized
}

func normalizeWechatSourceIdentifiers(header wechatEvidenceHeader, values []string, issues *[]importing.EvidenceIssue) importing.SourceIdentifiers {
	normalize := func(field wechatEvidenceField) string {
		value := normalizeWechatEvidenceText(wechatEvidenceValue(header, values, field), true)
		value = strings.TrimPrefix(value, "'")

		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 255 {
			*issues = append(*issues, importing.EvidenceIssue{
				Code:     importing.ISSUE_CODE_ROW_IDENTIFIER_INVALID,
				Field:    string(field),
				Severity: importing.ISSUE_SEVERITY_WARNING,
			})
			return ""
		}

		return value
	}

	return importing.SourceIdentifiers{
		TransactionId:   normalize(wechatEvidenceFieldTransactionId),
		OrderId:         normalize(wechatEvidenceFieldOrderId),
		MerchantOrderId: normalize(wechatEvidenceFieldMerchantOrderId),
	}
}

func wechatEvidenceValue(header wechatEvidenceHeader, values []string, field wechatEvidenceField) string {
	index, exists := header.positions[field]

	if !exists || index < 0 || index >= len(values) {
		return ""
	}

	return values[index]
}

func missingWechatEvidenceFieldIssue(field string) importing.EvidenceIssue {
	return importing.EvidenceIssue{
		Code:     importing.ISSUE_CODE_ROW_FIELD_MISSING,
		Field:    field,
		Severity: importing.ISSUE_SEVERITY_ERROR,
	}
}

func normalizeWechatEvidenceText(value string, emptySentinels bool) string {
	value = strings.TrimPrefix(value, "\ufeff")
	value = strings.TrimSpace(norm.NFKC.String(value))

	if emptySentinels {
		switch strings.ToLower(value) {
		case "", "-", "--", "/", "n/a", "null", "none":
			return ""
		}
	}

	return value
}

func normalizeWechatEvidenceDirection(value string) importing.NormalizedDirection {
	switch normalizeWechatEvidenceText(value, false) {
	case "收入", "收":
		return importing.NORMALIZED_DIRECTION_INCOME
	case "支出", "支":
		return importing.NORMALIZED_DIRECTION_EXPENSE
	case "/", "中性交易", "中性", "不计收支":
		return importing.NORMALIZED_DIRECTION_NEUTRAL
	default:
		return importing.NORMALIZED_DIRECTION_UNKNOWN
	}
}

func normalizeWechatEvidenceTransactionType(value string) importing.SourceTransactionType {
	return classifyWechatTransactionAction(value).sourceTransactionType()
}

func normalizeWechatEvidenceEconomicEffect(transactionType string, status string) importing.EconomicEffect {
	return classifyWechatEconomicEffect(transactionType, status)
}

func parseWechatEvidenceAmount(value string) (int64, bool) {
	value = normalizeWechatEvidenceText(value, false)
	value = strings.TrimSpace(value)

	for _, prefix := range []string{"CNY", "RMB", "¥", "￥"} {
		if strings.HasPrefix(strings.ToUpper(value), prefix) {
			value = strings.TrimSpace(value[len(prefix):])
			break
		}
	}

	if strings.HasSuffix(value, "元") {
		value = strings.TrimSpace(strings.TrimSuffix(value, "元"))
	}

	if value == "" || strings.HasPrefix(value, "-") {
		return 0, false
	}

	if strings.Contains(value, ",") {
		parts := strings.SplitN(value, ".", 2)
		integerParts := strings.Split(parts[0], ",")

		if len(integerParts[0]) < 1 || len(integerParts[0]) > 3 {
			return 0, false
		}

		for index, part := range integerParts {
			if index > 0 && len(part) != 3 {
				return 0, false
			}

			if !isWechatAsciiDigits(part) {
				return 0, false
			}
		}

		value = strings.ReplaceAll(value, ",", "")
	}

	numberParts := strings.Split(value, ".")

	if len(numberParts) > 2 || !isWechatAsciiDigits(strings.TrimPrefix(numberParts[0], "+")) {
		return 0, false
	}

	if len(numberParts) == 2 && (len(numberParts[1]) < 1 || len(numberParts[1]) > 2 || !isWechatAsciiDigits(numberParts[1])) {
		return 0, false
	}

	amount, err := utils.ParseAmount(value)

	if err != nil || amount < 0 {
		return 0, false
	}

	return amount, true
}

func isWechatAsciiDigits(value string) bool {
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

func allWechatEvidenceCellsEmpty(values []string) bool {
	for _, value := range values {
		if normalizeWechatEvidenceText(value, false) != "" {
			return false
		}
	}

	return true
}

func firstWechatFormulaField(header wechatEvidenceHeader, formulaColumns map[int]bool) string {
	formulaColumn := -1

	for index := range formulaColumns {
		if formulaColumn < 0 || index < formulaColumn {
			formulaColumn = index
		}
	}

	for _, field := range []wechatEvidenceField{
		wechatEvidenceFieldTransactionTime,
		wechatEvidenceFieldTransactionType,
		wechatEvidenceFieldCounterparty,
		wechatEvidenceFieldItem,
		wechatEvidenceFieldDirection,
		wechatEvidenceFieldAmount,
		wechatEvidenceFieldPaymentMethod,
		wechatEvidenceFieldStatus,
		wechatEvidenceFieldTransactionId,
		wechatEvidenceFieldOrderId,
		wechatEvidenceFieldMerchantOrderId,
		wechatEvidenceFieldNote,
	} {
		if index, exists := header.positions[field]; exists && index == formulaColumn {
			return string(field)
		}
	}

	return "row"
}

func hasWechatEvidenceErrorIssue(issues []importing.EvidenceIssue) bool {
	for _, issue := range issues {
		if issue.Severity == importing.ISSUE_SEVERITY_ERROR {
			return true
		}
	}

	return false
}

func appendUniqueWechatIssue(issues []importing.EvidenceIssue, issue importing.EvidenceIssue) []importing.EvidenceIssue {
	for _, existing := range issues {
		if existing.Code == issue.Code && existing.Field == issue.Field && existing.Severity == issue.Severity {
			return issues
		}
	}

	return append(issues, issue)
}

func (b *wechatEvidenceMetadataBuilder) observePreamble(rows []wechatEvidencePhysicalRow, opts importing.ResolvedParseOptions) {
	for _, row := range rows {
		text := strings.Join(row.values, " ")
		normalized := normalizeWechatEvidenceText(text, false)

		if nickname, present := extractWechatEvidenceNickname(normalized); present {
			if nickname == "" || utf8.RuneCountInString(nickname) > 128 {
				b.issues = appendUniqueWechatIssue(b.issues, importing.EvidenceIssue{
					Code:     wechatPayIssueNicknameInvalid,
					Field:    "source_account",
					Severity: importing.ISSUE_SEVERITY_WARNING,
				})
			} else if !containsWechatString(b.nicknames, nickname) {
				b.nicknames = append(b.nicknames, nickname)
			}
		}

		matches := wechatStatementPeriodPattern.FindStringSubmatch(normalized)

		if len(matches) == 3 {
			startText := strings.ReplaceAll(matches[1], "/", "-")
			endText := strings.ReplaceAll(matches[2], "/", "-")
			start, startErr := utils.ParseFromLongDateTimeInFixedUtcOffset(startText, opts.TimezoneUtcOffset)
			end, endErr := utils.ParseFromLongDateTimeInFixedUtcOffset(endText, opts.TimezoneUtcOffset)

			if startErr != nil || endErr != nil || start.Unix() < 1 || end.Unix() < start.Unix() {
				b.addInvalidStatementIssue()
			} else {
				b.periodStarts = append(b.periodStarts, start.Unix())
				b.periodEnds = append(b.periodEnds, end.Unix())
			}
		} else if strings.Contains(normalized, "起始时间") || strings.Contains(normalized, "开始时间") || strings.Contains(normalized, "终止时间") || strings.Contains(normalized, "结束时间") {
			b.addInvalidStatementIssue()
		}
	}
}

func (b *wechatEvidenceMetadataBuilder) addInvalidStatementIssue() {
	b.issues = appendUniqueWechatIssue(b.issues, importing.EvidenceIssue{
		Code:     wechatPayIssueStatementInvalid,
		Field:    "statement_period",
		Severity: importing.ISSUE_SEVERITY_WARNING,
	})
}

func (b *wechatEvidenceMetadataBuilder) build(sourceType importing.SourceType, opts importing.ResolvedParseOptions, metadata importing.DocumentMetadata) importing.DocumentMetadata {
	if len(b.nicknames) == 1 {
		metadata.SourceAccount = importing.SourceAccountCandidate{
			Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY,
			DisplayName:     b.nicknames[0],
			DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME,
		}
	} else if len(b.nicknames) > 1 {
		b.issues = appendUniqueWechatIssue(b.issues, importing.EvidenceIssue{
			Code:     wechatPayIssueNicknameConflict,
			Field:    "source_account",
			Severity: importing.ISSUE_SEVERITY_WARNING,
		})
	}

	if len(b.periodStarts) > 0 {
		start := b.periodStarts[0]
		end := b.periodEnds[0]

		for _, candidate := range b.periodStarts[1:] {
			if candidate < start {
				start = candidate
			}
		}

		for _, candidate := range b.periodEnds[1:] {
			if candidate > end {
				end = candidate
			}
		}

		offset := opts.TimezoneUtcOffset
		metadata.StatementStartUnixTime = &start
		metadata.StatementEndUnixTime = &end
		metadata.StatementTimezoneUtcOffset = &offset
	}

	metadata.SourceType = sourceType
	return metadata
}

func extractWechatEvidenceNickname(value string) (string, bool) {
	index := strings.Index(value, "微信昵称")

	if index < 0 {
		return "", false
	}

	value = strings.TrimSpace(value[index+len("微信昵称"):])
	value = strings.TrimLeft(value, ": ")
	value = strings.TrimSpace(value)

	if len(value) >= 2 {
		pairs := [][2]string{{"[", "]"}, {"【", "】"}, {"(", ")"}}

		for _, pair := range pairs {
			if strings.HasPrefix(value, pair[0]) && strings.HasSuffix(value, pair[1]) {
				value = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, pair[0]), pair[1]))
				break
			}
		}
	}

	return value, true
}

func containsWechatString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}

	return false
}
