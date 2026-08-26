package genericbank

import (
	"context"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/converters/excel"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const maximumHeaderScanRows = 100

type inferenceSheet struct {
	records    []physicalRecord
	encoding   importing.GenericCSVEncoding
	delimiter  importing.GenericCSVDelimiter
	sheetIndex int
}

type mappingCandidate struct {
	mapping importing.GenericBankMapping
	score   int
}

type bankTableProfile struct {
	requiredHeaders         []string
	signedPositiveDirection importing.NormalizedDirection
	paymentMethodPrefix     string
}

var bankTableProfiles = []bankTableProfile{
	{
		requiredHeaders:         []string{"交易日期", "记账日期", "交易金额", "交易摘要", "尾号4位"},
		signedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE,
		paymentMethodPrefix:     "兴业银行信用卡",
	},
	{
		requiredHeaders:         []string{"Trans Date", "Post Date", "Amount", "Tran Description", "Card No."},
		signedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE,
		paymentMethodPrefix:     "兴业银行信用卡",
	},
}

var genericBankTimeFormats = []importing.GenericCSVTimeFormat{
	importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS,
	importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_MINUTES,
	importing.GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_SECONDS,
	importing.GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_MINUTES,
	importing.GENERIC_CSV_TIME_FORMAT_COMPACT_DATE_TIME_MINUTES,
	importing.GENERIC_CSV_TIME_FORMAT_DATE,
	importing.GENERIC_CSV_TIME_FORMAT_SLASH_DATE,
	importing.GENERIC_CSV_TIME_FORMAT_COMPACT_DATE,
}

var genericBankHeaderAliases = map[string][]string{
	"time":             {"交易时间", "交易日期", "交易日", "trans date", "transaction date", "transaction time", "trans time"},
	"amount":           {"交易金额", "金额", "amount", "transaction amount"},
	"direction":        {"收支", "收/支", "交易方向", "借贷标志", "借贷方向", "direction", "debit/credit"},
	"income":           {"收入", "收入金额", "入账金额", "贷方发生额", "credit amount", "income"},
	"expense":          {"支出", "支出金额", "出账金额", "借方发生额", "debit amount", "expense"},
	"currency":         {"币种", "货币", "currency"},
	"transaction_id":   {"交易流水号", "流水号", "交易号", "transaction id", "reference no", "reference number"},
	"order_id":         {"订单号", "order id", "order no"},
	"counterparty":     {"交易对方", "对方户名", "对方名称", "收款人", "付款人", "商户名称", "交易摘要", "tran description", "transaction description", "description"},
	"item":             {"商品说明", "商品名称", "交易用途", "用途", "摘要", "memo"},
	"payment_method":   {"支付方式", "付款方式", "卡号", "尾号4位", "card no", "card number"},
	"status":           {"交易状态", "状态", "status"},
	"transaction_type": {"交易类型", "交易分类", "类型", "transaction type"},
	"note":             {"备注", "附言", "note", "remark"},
}

var genericBankIncomeValues = []string{"credit", "cr", "入账", "收入", "存入", "贷", "贷方", "转入"}
var genericBankExpenseValues = []string{"debit", "dr", "出账", "支出", "取出", "借", "借方", "转出"}

func (p *genericBankTableParser) ResolveParseOptions(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (importing.ResolvedParseOptions, error) {
	if opts.GenericBankMapping != nil {
		return opts, nil
	}
	mapping, err := p.inferMapping(ctx, file.Content)
	if err != nil {
		return importing.ResolvedParseOptions{}, err
	}
	opts.GenericBankMapping = &mapping
	return opts, nil
}

func (p *genericBankTableParser) inferMapping(ctx context.Context, content []byte) (importing.GenericBankMapping, error) {
	sheets, err := p.inferenceSheets(ctx, content)
	if err != nil {
		return importing.GenericBankMapping{}, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	var best *mappingCandidate
	bestCount := 0
	for _, sheet := range sheets {
		limit := len(sheet.records)
		if limit > maximumHeaderScanRows {
			limit = maximumHeaderScanRows
		}
		for headerIndex := 0; headerIndex < limit; headerIndex++ {
			if err := ctx.Err(); err != nil {
				return importing.GenericBankMapping{}, err
			}
			candidate, ok := inferMappingFromHeader(sheet, headerIndex)
			if !ok {
				continue
			}
			if best == nil || candidate.score > best.score {
				copy := candidate
				best = &copy
				bestCount = 1
			} else if candidate.score == best.score {
				bestCount++
			}
		}
	}
	if best == nil || bestCount != 1 {
		return importing.GenericBankMapping{}, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	normalized, err := importing.NormalizeGenericBankMapping(best.mapping)
	if err != nil {
		return importing.GenericBankMapping{}, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	return normalized, nil
}

func (p *genericBankTableParser) inferenceSheets(ctx context.Context, content []byte) ([]inferenceSheet, error) {
	if p.container == tableContainerCSV {
		seen := make(map[string]struct{})
		var sheets []inferenceSheet
		for _, encodingName := range []importing.GenericCSVEncoding{
			importing.GENERIC_CSV_ENCODING_UTF8,
			importing.GENERIC_CSV_ENCODING_GB18030,
			importing.GENERIC_CSV_ENCODING_GBK,
		} {
			decoded, err := decodeContent(content, encodingName)
			if err != nil || !looksLikeText(decoded) {
				continue
			}
			for _, delimiter := range []struct {
				name importing.GenericCSVDelimiter
				rune rune
			}{{importing.GENERIC_CSV_DELIMITER_COMMA, ','}, {importing.GENERIC_CSV_DELIMITER_TAB, '\t'}} {
				records, err := readPhysicalRecords(ctx, decoded, delimiter.rune)
				if err != nil || !hasMultiColumnRecord(records) {
					continue
				}
				key := string(delimiter.rune) + "\x00" + decoded
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				sheets = append(sheets, inferenceSheet{records: records, encoding: encodingName, delimiter: delimiter.name, sheetIndex: -1})
			}
		}
		return sheets, nil
	}

	tables, err := readSpreadsheetTables(content, p.container)
	if err != nil {
		return nil, err
	}
	sheets := make([]inferenceSheet, 0, len(tables))
	for _, table := range tables {
		worksheet, ok := table.(excel.WorksheetDataTable)
		if !ok {
			continue
		}
		records := worksheetPhysicalRecords(worksheet)
		sheets = append(sheets, inferenceSheet{
			records: records, encoding: importing.GENERIC_CSV_ENCODING_UTF8,
			delimiter: importing.GENERIC_CSV_DELIMITER_COMMA, sheetIndex: worksheet.WorksheetIndex(),
		})
	}
	return sheets, nil
}

func inferMappingFromHeader(sheet inferenceSheet, headerIndex int) (mappingCandidate, bool) {
	header := sheet.records[headerIndex].values
	if len(header) < 2 {
		return mappingCandidate{}, false
	}
	mapping := emptyGenericBankMapping()
	mapping.Encoding = sheet.encoding
	mapping.Delimiter = sheet.delimiter
	mapping.SheetIndex = sheet.sheetIndex
	mapping.HeaderRow = headerIndex + 1
	mapping.TimeColumn = findHeaderColumn(header, genericBankHeaderAliases["time"])
	mapping.AmountColumn = findHeaderColumn(header, genericBankHeaderAliases["amount"])
	mapping.DirectionColumn = findHeaderColumn(header, genericBankHeaderAliases["direction"])
	mapping.IncomeColumn = findHeaderColumn(header, genericBankHeaderAliases["income"])
	mapping.ExpenseColumn = findHeaderColumn(header, genericBankHeaderAliases["expense"])
	if mapping.TimeColumn < 0 {
		return mappingCandidate{}, false
	}

	profile := matchBankTableProfile(header)
	switch {
	case mapping.IncomeColumn >= 0 && mapping.ExpenseColumn >= 0:
		mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE
		mapping.AmountColumn = -1
		mapping.DirectionColumn = -1
	case mapping.AmountColumn >= 0 && mapping.DirectionColumn >= 0:
		mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION
		mapping.IncomeValues = append([]string(nil), genericBankIncomeValues...)
		mapping.ExpenseValues = append([]string(nil), genericBankExpenseValues...)
	case mapping.AmountColumn >= 0 && profile != nil:
		mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_SIGNED
		mapping.SignedPositiveDirection = profile.signedPositiveDirection
		mapping.PaymentMethodPrefix = profile.paymentMethodPrefix
	default:
		return mappingCandidate{}, false
	}

	mapping.CurrencyColumn = findHeaderColumn(header, genericBankHeaderAliases["currency"])
	mapping.TransactionIdColumn = findHeaderColumn(header, genericBankHeaderAliases["transaction_id"])
	mapping.OrderIdColumn = findHeaderColumn(header, genericBankHeaderAliases["order_id"])
	mapping.CounterpartyColumn = findHeaderColumn(header, genericBankHeaderAliases["counterparty"])
	mapping.ItemColumn = findHeaderColumn(header, genericBankHeaderAliases["item"])
	mapping.PaymentMethodColumn = findHeaderColumn(header, genericBankHeaderAliases["payment_method"])
	mapping.StatusColumn = findHeaderColumn(header, genericBankHeaderAliases["status"])
	mapping.TransactionTypeColumn = findHeaderColumn(header, genericBankHeaderAliases["transaction_type"])
	mapping.NoteColumn = findHeaderColumn(header, genericBankHeaderAliases["note"])

	dataStart, format, validRows, ok := inferDataStartAndTimeFormat(sheet.records, headerIndex, mapping)
	if !ok || (profile == nil && validRows < 2) {
		return mappingCandidate{}, false
	}
	mapping.TimeFormat = format
	mapping.DataStartRow = dataStart + 1
	mapping.DataEndRow = inferDataEnd(sheet.records, dataStart, mapping, format) + 1
	score := 20 + validRows
	if dataStart == headerIndex+1 {
		score += 5
	}
	for _, column := range []int{mapping.CounterpartyColumn, mapping.ItemColumn, mapping.PaymentMethodColumn, mapping.TransactionIdColumn, mapping.CurrencyColumn} {
		if column >= 0 {
			score++
		}
	}
	if profile != nil {
		score += 100
	}
	return mappingCandidate{mapping: mapping, score: score}, true
}

func emptyGenericBankMapping() importing.GenericBankMapping {
	return importing.GenericBankMapping{
		SheetIndex: -1, TimeColumn: -1, AmountColumn: -1, DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1,
		CurrencyColumn: -1, TransactionIdColumn: -1, OrderIdColumn: -1, MerchantOrderIdColumn: -1,
		CounterpartyColumn: -1, ItemColumn: -1, PaymentMethodColumn: -1, StatusColumn: -1,
		TransactionTypeColumn: -1, NoteColumn: -1,
	}
}

func findHeaderColumn(header []string, aliases []string) int {
	aliasSet := make(map[string]struct{}, len(aliases))
	for _, alias := range aliases {
		aliasSet[normalizeHeader(alias)] = struct{}{}
	}
	found := -1
	for column, value := range header {
		if _, exists := aliasSet[normalizeHeader(value)]; !exists {
			continue
		}
		if found >= 0 {
			return -1
		}
		found = column
	}
	return found
}

func normalizeHeader(value string) string {
	value = strings.ToLower(norm.NFKC.String(strings.TrimSpace(value)))
	return strings.Map(func(char rune) rune {
		if unicode.IsSpace(char) || strings.ContainsRune("_-—–()[]{}（）【】/\\.:：", char) {
			return -1
		}
		return char
	}, value)
}

func matchBankTableProfile(header []string) *bankTableProfile {
	values := make(map[string]struct{}, len(header))
	for _, value := range header {
		values[normalizeHeader(value)] = struct{}{}
	}
	for index := range bankTableProfiles {
		profile := &bankTableProfiles[index]
		matched := true
		for _, required := range profile.requiredHeaders {
			if _, exists := values[normalizeHeader(required)]; !exists {
				matched = false
				break
			}
		}
		if matched {
			return profile
		}
	}
	return nil
}

func inferDataStartAndTimeFormat(records []physicalRecord, headerIndex int, mapping importing.GenericBankMapping) (int, importing.GenericCSVTimeFormat, int, bool) {
	limit := headerIndex + 6
	if limit > len(records) {
		limit = len(records)
	}
	bestStart, bestRows := 0, 0
	var bestFormat importing.GenericCSVTimeFormat
	for start := headerIndex + 1; start < limit; start++ {
		for _, format := range genericBankTimeFormats {
			validRows := countValidRows(records, start, mapping, format)
			if validRows > bestRows {
				bestStart, bestFormat, bestRows = start, format, validRows
			}
		}
	}
	return bestStart, bestFormat, bestRows, bestRows > 0
}

func countValidRows(records []physicalRecord, start int, mapping importing.GenericBankMapping, format importing.GenericCSVTimeFormat) int {
	valid := 0
	for index := start; index < len(records) && index < start+20; index++ {
		if rowEmpty(records[index].values) {
			break
		}
		if rowMatchesMapping(records[index].values, mapping, format) {
			valid++
		} else {
			break
		}
	}
	return valid
}

func inferDataEnd(records []physicalRecord, start int, mapping importing.GenericBankMapping, format importing.GenericCSVTimeFormat) int {
	end := start
	for index := start; index < len(records); index++ {
		if rowEmpty(records[index].values) {
			break
		}
		if !rowMatchesMapping(records[index].values, mapping, format) && index > start {
			break
		}
		end = index
	}
	return end
}

func rowMatchesMapping(values []string, mapping importing.GenericBankMapping, format importing.GenericCSVTimeFormat) bool {
	if mapping.TimeColumn < 0 || mapping.TimeColumn >= len(values) {
		return false
	}
	if _, err := time.Parse(string(format), normalizeText(values[mapping.TimeColumn])); err != nil {
		return false
	}
	getAmount := func(column int) bool {
		if column < 0 || column >= len(values) {
			return false
		}
		unsigned, _, ok := normalizeSignedAmount(values[column])
		if !ok {
			return false
		}
		_, ok = parseUnsignedAmount(unsigned)
		return ok
	}
	switch mapping.AmountMode {
	case importing.GENERIC_CSV_AMOUNT_MODE_SIGNED:
		return getAmount(mapping.AmountColumn)
	case importing.GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION:
		if !getAmount(mapping.AmountColumn) || mapping.DirectionColumn < 0 || mapping.DirectionColumn >= len(values) {
			return false
		}
		direction := strings.ToLower(normalizeText(values[mapping.DirectionColumn]))
		return contains(mapping.IncomeValues, direction) || contains(mapping.ExpenseValues, direction)
	case importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE:
		income := getAmount(mapping.IncomeColumn)
		expense := getAmount(mapping.ExpenseColumn)
		return income != expense
	default:
		return false
	}
}

func rowEmpty(values []string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}

func worksheetPhysicalRecords(worksheet excel.WorksheetDataTable) []physicalRecord {
	name := worksheet.WorksheetName()
	if name == "" {
		name = "Sheet"
	}
	rows := worksheet.PhysicalRows()
	records := make([]physicalRecord, len(rows))
	for rowIndex, values := range rows {
		records[rowIndex] = physicalRecord{
			values: append([]string(nil), values...),
			locator: importing.SourceLocator{
				Kind: importing.LOCATOR_KIND_SPREADSHEET, SheetIndex: worksheet.WorksheetIndex(), SheetName: name, XLSXRow: int64(rowIndex + 1),
			},
		}
	}
	return records
}
