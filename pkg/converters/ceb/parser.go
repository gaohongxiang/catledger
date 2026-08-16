package ceb

import (
	"context"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	parserName           = "ceb_credit_pdf"
	parserVersion        = importing.RuleVersion("ceb-credit-pdf-parser-v3")
	normalizationVersion = importing.RuleVersion("ceb-credit-pdf-normalization-v1")

	statementTitle      = "中国光大银行信用卡对账单"
	columnTradeDate     = "交易日"
	columnPostDate      = "记账日"
	columnCardLast4     = "卡号末四位"
	columnDescription   = "交易说明"
	columnAmount        = "金额"
	depositMarker       = "(存入)"
	tipsMarker          = "温馨提示"
	paymentMethodPrefix = "末四位"
)

var (
	dateLinePattern      = regexp.MustCompile(`^\d{4}/\d{2}/\d{2}$`)
	cardLast4Pattern     = regexp.MustCompile(`^\d{4}$`)
	amountLinePattern    = regexp.MustCompile(`^(\(存入\))?(\d{1,3}(?:,\d{3})*|\d+)\.\d{2}$`)
	periodPattern        = regexp.MustCompile(`(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-–—]\s*(\d{4})年(\d{1,2})月(\d{1,2})日`)
	statementDatePattern = regexp.MustCompile(`账单日(?:Statement Date)?\s*(\d{4})年(\d{1,2})月(\d{1,2})日`)
	dueDatePattern       = regexp.MustCompile(`到期还款日(?:Payment Due Date)?\s*(\d{4})年(\d{1,2})月(\d{1,2})日`)
	creditLimitPattern   = regexp.MustCompile(`信用卡额度(?:Credit Limit)?\s*[¥￥]?\s*((?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2})`)
)

// ImportEvidenceParser 只解析中国光大银行信用卡月结单 PDF，必须由调用方显式选择。
var ImportEvidenceParser importing.ImportEvidenceParser = &cebCreditPDFParser{}

type cebCreditPDFParser struct{}

type extractedLine struct {
	number int64
	text   string
}

func (p *cebCreditPDFParser) Descriptor() importing.ParserDescriptor {
	return importing.ParserDescriptor{
		Name:                  parserName,
		SourceType:            importing.SOURCE_TYPE_BANK,
		Format:                importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF,
		ParserVersion:         parserVersion,
		NormalizationVersion:  normalizationVersion,
		ExplicitSelectionOnly: true,
	}
}

func (p *cebCreditPDFParser) Probe(ctx context.Context, file importing.EvidenceFile) importing.ProbeResult {
	pages, err := extractPDFPageTexts(ctx, file.Content)
	if err != nil {
		return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
	}
	if looksLikeCEBCreditStatement(pages) {
		return importing.ProbeResult{
			Confidence: importing.PROBE_CONFIDENCE_EXACT,
			SourceType: importing.SOURCE_TYPE_BANK,
			Format:     importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF,
		}
	}
	return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
}

func (p *cebCreditPDFParser) Parse(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	descriptor := p.Descriptor()
	if err := opts.ValidateForDescriptor(descriptor); err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	pages, err := extractPDFPageTexts(ctx, file.Content)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, parseError(importing.ISSUE_CODE_FILE_FORMAT_INVALID)
	}
	if !looksLikeCEBCreditStatement(pages) {
		return nil, parseError(importing.ISSUE_CODE_FILE_FORMAT_INVALID)
	}

	document := &importing.EvidenceDocument{
		Metadata: importing.DocumentMetadata{
			SourceType: importing.SOURCE_TYPE_BANK,
			SourceAccount: importing.SourceAccountCandidate{
				Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_MISSING,
				DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
			},
		},
		Rows: make([]importing.EvidenceRow, 0),
	}
	fillStatementPeriod(pages, opts.TimezoneUtcOffset, &document.Metadata)
	fillStatementHeader(pages, opts.TimezoneUtcOffset, &document.Metadata)

	for pageIndex, pageText := range pages {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		pageNumber := pageIndex + 1
		lines := splitPDFLines(pageText)
		for index := 0; index < len(lines); index++ {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if strings.Contains(lines[index].text, tipsMarker) {
				break
			}
			row, consumed := parseTransactionGroup(int64(len(document.Rows)+1), pageNumber, lines, index, opts)
			if consumed == 0 {
				continue
			}
			document.Rows = append(document.Rows, row)
			index += consumed - 1
		}
	}

	if len(document.Rows) == 0 {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	if _, err := importing.ValidateEvidenceDocument(descriptor, document); err != nil {
		return nil, parseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}
	return document, nil
}

func looksLikeCEBCreditStatement(pages []string) bool {
	joined := strings.Join(pages, "\n")
	return strings.Contains(joined, statementTitle) &&
		strings.Contains(joined, columnTradeDate) &&
		strings.Contains(joined, columnPostDate) &&
		strings.Contains(joined, columnCardLast4) &&
		strings.Contains(joined, columnDescription) &&
		strings.Contains(joined, columnAmount)
}

func fillStatementPeriod(pages []string, offset int16, metadata *importing.DocumentMetadata) {
	joined := strings.Join(pages, "\n")
	match := periodPattern.FindStringSubmatch(joined)
	if match == nil {
		return
	}
	start, startOK := civilDateUnix(match[1], match[2], match[3], offset)
	end, endOK := civilDateUnix(match[4], match[5], match[6], offset)
	if !startOK || !endOK || end < start {
		return
	}
	metadata.StatementStartUnixTime = &start
	metadata.StatementEndUnixTime = &end
	metadata.StatementTimezoneUtcOffset = &offset
}

func fillStatementHeader(pages []string, offset int16, metadata *importing.DocumentMetadata) {
	joined := strings.Join(pages, "\n")
	if match := statementDatePattern.FindStringSubmatch(joined); match != nil {
		if unixTime, ok := civilDateUnix(match[1], match[2], match[3], offset); ok {
			metadata.StatementDateUnixTime = &unixTime
			metadata.StatementTimezoneUtcOffset = &offset
		}
	}
	if match := dueDatePattern.FindStringSubmatch(joined); match != nil {
		if unixTime, ok := civilDateUnix(match[1], match[2], match[3], offset); ok {
			metadata.DueUnixTime = &unixTime
			metadata.StatementTimezoneUtcOffset = &offset
		}
	}
	if match := creditLimitPattern.FindStringSubmatch(joined); match != nil {
		if amount, ok := parseUnsignedAmount(match[1]); ok {
			metadata.CreditLimitAmount = &amount
		}
	}
}

func parseTransactionGroup(rowNumber int64, pageNumber int, lines []extractedLine, index int, opts importing.ResolvedParseOptions) (importing.EvidenceRow, int) {
	if index+4 >= len(lines) {
		return importing.EvidenceRow{}, 0
	}
	tradeDate := lines[index].text
	postDate := lines[index+1].text
	cardLast4 := lines[index+2].text
	description := lines[index+3].text
	amountLine := lines[index+4].text
	if !dateLinePattern.MatchString(tradeDate) || !dateLinePattern.MatchString(postDate) ||
		!cardLast4Pattern.MatchString(cardLast4) || !isDescriptionLine(description) || !amountLinePattern.MatchString(amountLine) {
		return importing.EvidenceRow{}, 0
	}

	deposit := strings.HasPrefix(amountLine, depositMarker)
	rawAmount := amountLine
	if deposit {
		rawAmount = strings.TrimPrefix(amountLine, depositMarker)
	}
	paymentMethod := paymentMethodPrefix + cardLast4
	descriptionNormalized := normalizeText(description)
	raw := importing.CanonicalRawEvidence{
		TransactionTime: tradeDate,
		Amount:          rawAmount,
		Counterparty:    description,
		PaymentMethod:   paymentMethod,
		Note:            postDate,
	}
	if deposit {
		raw.Direction = depositMarker
	}

	issues := make([]importing.EvidenceIssue, 0, 4)
	normalized := importing.NormalizedEvidence{
		TimezoneUtcOffset: opts.TimezoneUtcOffset,
		Currency:          opts.Currency,
		Direction:         importing.NORMALIZED_DIRECTION_EXPENSE,
		TransactionType:   importing.SOURCE_TRANSACTION_TYPE_OTHER,
		EconomicEffect:    importing.ECONOMIC_EFFECT_NORMAL,
		Counterparty:      descriptionNormalized,
		PaymentMethod:     paymentMethod,
		Note:              postDate,
	}
	if deposit {
		normalized.Direction = importing.NORMALIZED_DIRECTION_INCOME
	}
	if unixTime, ok := slashDateUnix(tradeDate, opts.TimezoneUtcOffset); ok {
		normalized.UnixTime = &unixTime
	} else {
		issues = append(issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_TIME_INVALID, Field: "transaction_time", Severity: importing.ISSUE_SEVERITY_ERROR})
	}
	if amount, ok := parseUnsignedAmount(rawAmount); ok {
		normalized.Amount = &amount
	} else {
		issues = append(issues, importing.EvidenceIssue{Code: importing.ISSUE_CODE_ROW_AMOUNT_INVALID, Field: "amount", Severity: importing.ISSUE_SEVERITY_ERROR})
	}

	parseState := importing.PARSE_STATE_VALID
	for _, issue := range issues {
		if issue.Severity == importing.ISSUE_SEVERITY_ERROR {
			parseState = importing.PARSE_STATE_INVALID
			break
		}
	}

	return importing.EvidenceRow{
		RowNumber: rowNumber,
		Locator: importing.SourceLocator{
			Kind:    importing.LOCATOR_KIND_PDF,
			PDFPage: pageNumber,
			PDFLine: lines[index].number,
		},
		RawFields: []importing.RawField{
			{Name: columnTradeDate, Value: tradeDate},
			{Name: columnPostDate, Value: postDate},
			{Name: columnCardLast4, Value: cardLast4},
			{Name: columnDescription, Value: description},
			{Name: columnAmount, Value: amountLine},
		},
		Raw:         raw,
		Identifiers: importing.SourceIdentifiers{},
		Normalized:  normalized,
		FingerprintMaterials: importing.StrongFingerprintMaterials{
			Counterparty:  descriptionNormalized,
			Item:          descriptionNormalized,
			PaymentMethod: normalized.PaymentMethod,
		},
		ParseStatus: parseState,
		Issues:      issues,
	}, 5
}

func isDescriptionLine(value string) bool {
	return value != "" &&
		!dateLinePattern.MatchString(value) &&
		!cardLast4Pattern.MatchString(value) &&
		!amountLinePattern.MatchString(value) &&
		!strings.Contains(value, tipsMarker) &&
		utf8.RuneCountInString(value) <= 255
}

func splitPDFLines(pageText string) []extractedLine {
	rawLines := strings.Split(pageText, "\n")
	lines := make([]extractedLine, 0, len(rawLines))
	for index, raw := range rawLines {
		text := strings.TrimSpace(norm.NFKC.String(raw))
		if text == "" {
			continue
		}
		lines = append(lines, extractedLine{number: int64(index + 1), text: text})
	}
	return lines
}

func slashDateUnix(value string, offset int16) (int64, bool) {
	parts := strings.Split(value, "/")
	if len(parts) != 3 {
		return 0, false
	}
	return civilDateUnix(parts[0], parts[1], parts[2], offset)
}

func civilDateUnix(yearText, monthText, dayText string, offset int16) (int64, bool) {
	year, yearErr := strconv.Atoi(yearText)
	month, monthErr := strconv.Atoi(monthText)
	day, dayErr := strconv.Atoi(dayText)
	if yearErr != nil || monthErr != nil || dayErr != nil || month < 1 || month > 12 || day < 1 || day > 31 {
		return 0, false
	}
	location := time.FixedZone("ceb-credit", int(offset)*60)
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, location)
	if parsed.Year() != year || parsed.Month() != time.Month(month) || parsed.Day() != day || parsed.Unix() < 1 {
		return 0, false
	}
	return parsed.Unix(), true
}

func parseUnsignedAmount(value string) (int64, bool) {
	value = strings.TrimSpace(value)
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

func normalizeText(value string) string {
	return strings.TrimSpace(norm.NFKC.String(strings.TrimPrefix(value, "\ufeff")))
}

func parseError(code importing.IssueCode) error {
	return &importing.EvidenceParseError{Code: code}
}
