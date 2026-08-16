package ceb

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/converters/alipay"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestDescriptorRequiresExplicitSelection(t *testing.T) {
	descriptor := ImportEvidenceParser.Descriptor()
	if err := descriptor.Validate(); err != nil {
		t.Fatalf("descriptor 未通过中心校验: %v", err)
	}
	if descriptor.Name != parserName || descriptor.SourceType != importing.SOURCE_TYPE_BANK ||
		descriptor.Format != importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF || !descriptor.ExplicitSelectionOnly ||
		descriptor.ParserVersion != parserVersion || descriptor.NormalizationVersion != normalizationVersion {
		t.Fatalf("unexpected CEB descriptor: %+v", descriptor)
	}
}

func TestProbeMatchesOnlyEverbrightCreditStatement(t *testing.T) {
	content := syntheticCEBStatementPDF([][]string{cebStatementLines(
		[]string{"2026/07/01", "2026/07/02", "1234", "测试商户甲", "12.34"},
	)})
	probe := ImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: content})
	if err := probe.Validate(ImportEvidenceParser.Descriptor()); err != nil {
		t.Fatalf("probe 未通过中心校验: %v", err)
	}
	if probe.Confidence != importing.PROBE_CONFIDENCE_EXACT || probe.Format != importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF {
		t.Fatalf("光大对账单未被精确命中: %+v", probe)
	}

	unmatched := []importing.EvidenceFile{
		{Content: nil},
		{Content: []byte("time,amount\n2026-07-01,1.00\n")},
		{Content: []byte{'P', 'K', 3, 4}},
		{Content: asciiPDF("Hello PDF")},
	}
	for _, file := range unmatched {
		result := ImportEvidenceParser.Probe(context.Background(), file)
		if result.Confidence.Matched() {
			t.Fatalf("非光大文件被认成光大对账单: %+v", result)
		}
	}

	cross := alipay.AlipayAppImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: content})
	if cross.Confidence.Matched() {
		t.Fatalf("支付宝解析器不应认领光大 PDF: %+v", cross)
	}
}

func TestParseTwoCardsDepositAndStatementPeriod(t *testing.T) {
	content := syntheticCEBStatementPDF([][]string{
		cebStatementLines(
			[]string{"2026/07/01", "2026/07/02", "1234", "测试商户甲", "12.34"},
			[]string{"2026/07/03", "2026/07/03", "1234", "测试商户乙", "1,234.56"},
		),
		append([]string{
			"账号 : 00000000****5678",
			"测试金卡",
			"上期欠款 : 0.00",
			"交易日",
			"记账日",
			"卡号末四位",
			"交易说明",
			"金额",
		}, []string{"2026/07/04", "2026/07/05", "5678", "款项转入", "(存入)100.00"}...),
		{"中国光大银行信用卡对账单（2026年07月）", "温馨提示", "本页没有交易明细。"},
	})

	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, cebOptions())
	if err != nil {
		t.Fatalf("parse CEB PDF: %v", err)
	}
	if _, err := importing.ValidateEvidenceDocument(ImportEvidenceParser.Descriptor(), document); err != nil {
		t.Fatalf("document 未通过中心校验: %v", err)
	}
	if len(document.Rows) != 3 {
		t.Fatalf("unexpected row count: %d", len(document.Rows))
	}
	if document.Metadata.SourceAccount.Kind != importing.SOURCE_ACCOUNT_EVIDENCE_MISSING {
		t.Fatalf("parser invented a source account: %+v", document.Metadata.SourceAccount)
	}
	if document.Metadata.StatementStartUnixTime == nil || document.Metadata.StatementEndUnixTime == nil ||
		*document.Metadata.StatementStartUnixTime != cebUnix(2026, 7, 1) ||
		*document.Metadata.StatementEndUnixTime != cebUnix(2026, 7, 31) {
		t.Fatalf("statement period was not captured: %+v", document.Metadata)
	}
	if document.Metadata.StatementDateUnixTime == nil || *document.Metadata.StatementDateUnixTime != cebUnix(2026, 8, 1) ||
		document.Metadata.DueUnixTime == nil || *document.Metadata.DueUnixTime != cebUnix(2026, 8, 20) ||
		document.Metadata.CreditLimitAmount == nil || *document.Metadata.CreditLimitAmount != 5000000 {
		t.Fatalf("statement header was not captured: %+v", document.Metadata)
	}

	expense, thousand, deposit := document.Rows[0], document.Rows[1], document.Rows[2]
	if expense.Normalized.Amount == nil || *expense.Normalized.Amount != 1234 ||
		expense.Normalized.Direction != importing.NORMALIZED_DIRECTION_EXPENSE ||
		expense.Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER ||
		expense.Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL ||
		expense.Raw.PaymentMethod != "末四位1234" || expense.Raw.Item != "" ||
		expense.Raw.Counterparty != "测试商户甲" || expense.Normalized.Counterparty != "测试商户甲" ||
		expense.Normalized.Item != "" || expense.FingerprintMaterials.Counterparty != "测试商户甲" ||
		expense.FingerprintMaterials.Item != "测试商户甲" {
		t.Fatalf("expense row semantics changed: %+v raw=%+v fingerprint=%+v", expense.Normalized, expense.Raw, expense.FingerprintMaterials)
	}
	if thousand.Normalized.Amount == nil || *thousand.Normalized.Amount != 123456 {
		t.Fatalf("thousands amount was not parsed: %+v", thousand.Normalized)
	}
	if deposit.Normalized.Amount == nil || *deposit.Normalized.Amount != 10000 ||
		deposit.Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME ||
		deposit.Raw.Direction != "(存入)" || deposit.Raw.PaymentMethod != "末四位5678" ||
		deposit.Locator.Kind != importing.LOCATOR_KIND_PDF || deposit.Locator.PDFPage != 2 || deposit.Locator.PDFLine < 1 {
		t.Fatalf("deposit/card split changed: %+v locator=%+v", deposit, deposit.Locator)
	}
	if expense.Locator.PDFPage != 1 || thousand.Locator.PDFPage != 1 || thousand.Locator.PDFLine <= expense.Locator.PDFLine {
		t.Fatalf("page-1 locators are not stable: first=%+v second=%+v", expense.Locator, thousand.Locator)
	}
	if encoded, err := importing.EncodeSourceLocator(deposit.Locator); err != nil || !strings.HasPrefix(encoded, "v1:pdf:2:") {
		t.Fatalf("PDF locator encoding changed: %q %v", encoded, err)
	}
}

func TestParseRejectsMappingAndHeaderOnlyStatement(t *testing.T) {
	content := syntheticCEBStatementPDF([][]string{cebStatementLines()})
	_, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, cebOptions())
	if code := importing.NormalizeEvidenceParseError(ImportEvidenceParser.Descriptor(), err); code != importing.ISSUE_CODE_FILE_STRUCTURE_INVALID {
		t.Fatalf("header-only statement was accepted: %v", err)
	}

	mapping := importing.GenericCSVMapping{
		Encoding: importing.GENERIC_CSV_ENCODING_UTF8, Delimiter: importing.GENERIC_CSV_DELIMITER_COMMA,
		HeaderRow: 1, TimeFormat: importing.GENERIC_CSV_TIME_FORMAT_SLASH_DATE, TimeColumn: 0,
		AmountMode: importing.GENERIC_CSV_AMOUNT_MODE_SIGNED, SignedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE,
		AmountColumn: 1, DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1, CurrencyColumn: -1,
		TransactionIdColumn: -1, OrderIdColumn: -1, MerchantOrderIdColumn: -1, CounterpartyColumn: -1,
		ItemColumn: -1, PaymentMethodColumn: -1, StatusColumn: -1, TransactionTypeColumn: -1, NoteColumn: -1,
	}
	opts := cebOptions()
	opts.GenericCSVMapping = &mapping
	content = syntheticCEBStatementPDF([][]string{cebStatementLines(
		[]string{"2026/07/01", "2026/07/02", "1234", "测试商户甲", "12.34"},
	)})
	_, err = ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, opts)
	if code := importing.NormalizeEvidenceParseError(ImportEvidenceParser.Descriptor(), err); code != importing.ISSUE_CODE_FILE_STRUCTURE_INVALID {
		t.Fatalf("generic CSV mapping was accepted: %v", err)
	}
}

func TestParseHonorsCancellationAndKeepsInvalidDateRow(t *testing.T) {
	content := syntheticCEBStatementPDF([][]string{cebStatementLines(
		[]string{"2026/13/40", "2026/07/02", "1234", "测试商户甲", "12.34"},
		[]string{"2026/07/08", "2026/07/08", "1234", "测试商户丙", "3.00"},
	)})
	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, cebOptions())
	if err != nil {
		t.Fatalf("parse mixed rows: %v", err)
	}
	if len(document.Rows) != 2 || document.Rows[0].ParseStatus != importing.PARSE_STATE_INVALID ||
		document.Rows[1].ParseStatus != importing.PARSE_STATE_VALID || document.Rows[0].Raw.Counterparty != "测试商户甲" ||
		document.Rows[0].Raw.Item != "" {
		t.Fatalf("invalid physical row evidence was lost: %+v", document.Rows)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ImportEvidenceParser.Parse(ctx, importing.EvidenceFile{Content: content}, cebOptions()); err == nil {
		t.Fatal("canceled parse was accepted")
	}
}

func TestOptionalLocalEverbrightStatement(t *testing.T) {
	path := strings.TrimSpace(os.Getenv("EZBK_CEB_CREDIT_PDF"))
	if path == "" {
		t.Skip("optional local Everbright PDF not provided")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read optional local PDF: %v", err)
	}
	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, cebOptions())
	if err != nil {
		t.Fatalf("optional local PDF parse failed: %v", err)
	}
	if len(document.Rows) < 1 {
		t.Fatal("optional local PDF produced no transaction rows")
	}
	if document.Metadata.StatementDateUnixTime == nil || *document.Metadata.StatementDateUnixTime < 1 ||
		document.Metadata.DueUnixTime == nil || *document.Metadata.DueUnixTime < 1 ||
		document.Metadata.CreditLimitAmount == nil || *document.Metadata.CreditLimitAmount < 1 {
		t.Fatal("optional local PDF did not yield statement date, due date and credit limit")
	}
	paymentMethods := map[string]struct{}{}
	for _, row := range document.Rows {
		if row.Locator.Kind != importing.LOCATOR_KIND_PDF || row.Locator.PDFPage < 1 || row.Locator.PDFLine < 1 {
			t.Fatalf("optional local PDF locator is not a PDF position: %+v", row.Locator)
		}
		paymentMethods[row.Raw.PaymentMethod] = struct{}{}
	}
	if len(paymentMethods) < 1 {
		t.Fatal("optional local PDF produced no card payment methods")
	}
}

func cebOptions() importing.ResolvedParseOptions {
	return importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480}
}

func cebUnix(year int, month time.Month, day int) int64 {
	return time.Date(year, month, day, 0, 0, 0, 0, time.FixedZone("ceb-credit", 480*60)).Unix()
}

func cebStatementLines(transactions ...[]string) []string {
	lines := []string{
		"中国光大银行信用卡对账单（2026年07月）",
		"账单周期",
		"2026年07月01日-2026年07月31日",
		"账单日Statement Date",
		"2026年08月01日",
		"到期还款日Payment Due Date",
		"2026年08月20日",
		"信用卡额度Credit Limit",
		"￥50,000.00",
		"人民币账户交易明细",
		"账号 : 00000000****1234",
		"测试白金卡",
		"上期欠款 : 0.00",
		"交易日",
		"记账日",
		"卡号末四位",
		"交易说明",
		"金额",
	}
	for _, transaction := range transactions {
		lines = append(lines, transaction...)
	}
	return lines
}

func asciiPDF(text string) []byte {
	return syntheticCEBStatementPDF([][]string{{text}})
}

func syntheticCEBStatementPDF(pages [][]string) []byte {
	used := map[rune]struct{}{}
	for _, page := range pages {
		for _, line := range page {
			for _, char := range line {
				used[char] = struct{}{}
			}
		}
	}
	runes := make([]rune, 0, len(used))
	for char := range used {
		runes = append(runes, char)
	}

	var cmap strings.Builder
	cmap.WriteString("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n")
	cmap.WriteString("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n")
	cmap.WriteString("/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n")
	fmt.Fprintf(&cmap, "%d beginbfchar\n", len(runes))
	for _, char := range runes {
		fmt.Fprintf(&cmap, "<%04X> <%04X>\n", char, char)
	}
	cmap.WriteString("endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")

	pageCount := len(pages)
	if pageCount < 1 {
		pageCount = 1
		pages = [][]string{{""}}
	}
	fontType0 := 3 + 2*pageCount
	objects := make([]string, 7+2*pageCount)
	kids := make([]string, 0, pageCount)
	for pageIndex, lines := range pages {
		var content strings.Builder
		y := 800
		for _, line := range lines {
			content.WriteString("BT\n/F1 12 Tf\n")
			fmt.Fprintf(&content, "1 0 0 1 50 %d Tm\n<", y)
			for _, char := range line {
				fmt.Fprintf(&content, "%04X", char)
			}
			content.WriteString("> Tj\nET\n")
			y -= 18
		}
		stream := content.String()
		pageObject := 3 + 2*pageIndex
		contentObject := pageObject + 1
		kids = append(kids, fmt.Sprintf("%d 0 R", pageObject))
		objects[pageObject-1] = fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>", contentObject, fontType0)
		objects[contentObject-1] = fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream)
	}
	objects[0] = "<< /Type /Catalog /Pages 2 0 R >>"
	objects[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pageCount)
	objects[fontType0-1] = fmt.Sprintf("<< /Type /Font /Subtype /Type0 /BaseFont /Synth /Encoding /Identity-H /DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>", fontType0+1, fontType0+3)
	objects[fontType0] = fmt.Sprintf("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synth /CIDSystemInfo %d 0 R /FontDescriptor %d 0 R /DW 500 /CIDToGIDMap /Identity >>", fontType0+2, fontType0+4)
	objects[fontType0+1] = "<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>"
	cmapText := cmap.String()
	objects[fontType0+2] = fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(cmapText), cmapText)
	objects[fontType0+3] = "<< /Type /FontDescriptor /FontName /Synth /Flags 4 /FontBBox [0 -200 500 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>"

	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	startxref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for index := 1; index <= len(objects); index++ {
		fmt.Fprintf(&out, "%010d 00000 n \n", offsets[index])
	}
	fmt.Fprintf(&out, "trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, startxref)
	return out.Bytes()
}
