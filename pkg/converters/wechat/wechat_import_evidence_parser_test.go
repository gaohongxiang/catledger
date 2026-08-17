package wechat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xuri/excelize/v2"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

var wechatEvidenceTestOptions = importing.ResolvedParseOptions{
	Currency:          "CNY",
	TimezoneUtcOffset: 480,
}

func TestWeChatPayImportEvidenceParserDescriptors(t *testing.T) {
	tests := []struct {
		parser importing.ImportEvidenceParser
		format importing.EvidenceFormat
		name   string
	}{
		{WeChatPayImportEvidenceCsvParser, importing.EVIDENCE_FORMAT_WECHAT_CSV, wechatPayCsvEvidenceParserName},
		{WeChatPayImportEvidenceXlsxParser, importing.EVIDENCE_FORMAT_WECHAT_XLSX, wechatPayXlsxEvidenceParserName},
	}

	for _, test := range tests {
		descriptor := test.parser.Descriptor()
		require.NoError(t, descriptor.Validate())
		assert.Equal(t, test.name, descriptor.Name)
		assert.Equal(t, importing.SOURCE_TYPE_WECHAT, descriptor.SourceType)
		assert.Equal(t, test.format, descriptor.Format)
		assert.NotEmpty(t, descriptor.ParserVersion)
		assert.Equal(t, wechatPayNormalizationVersion, descriptor.NormalizationVersion)
	}
}

func TestWeChatPayImportEvidenceCsvParserProbe(t *testing.T) {
	content := readWechatEvidenceGoldenCsv(t)
	file := importing.EvidenceFile{OriginalFileName: "synthetic.csv", Content: content}
	result := WeChatPayImportEvidenceCsvParser.Probe(context.Background(), file)

	require.NoError(t, result.Validate(WeChatPayImportEvidenceCsvParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_EXACT, result.Confidence)
	assert.Equal(t, importing.SOURCE_TYPE_WECHAT, result.SourceType)
	assert.Equal(t, importing.EVIDENCE_FORMAT_WECHAT_CSV, result.Format)
	assert.Equal(t, importing.ISSUE_CODE_NONE, result.IssueCode)

	headerOnly := []byte("交易时间,交易类型,金额（元）,支付方式,当前状态\n2026-01-01 00:00:00,商户消费,￥1.00,零钱,支付成功\n")
	result = WeChatPayImportEvidenceCsvParser.Probe(context.Background(), importing.EvidenceFile{Content: headerOnly})
	require.NoError(t, result.Validate(WeChatPayImportEvidenceCsvParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_POSSIBLE, result.Confidence)
	assert.Equal(t, wechatPayIssueFilePreambleMissing, result.IssueCode)

	result = WeChatPayImportEvidenceCsvParser.Probe(context.Background(), importing.EvidenceFile{Content: []byte("a,b\n1,2\n")})
	require.NoError(t, result.Validate(WeChatPayImportEvidenceCsvParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_NONE, result.Confidence)
}

func TestWeChatPayImportEvidenceParsersDoNotClaimTheOtherContainer(t *testing.T) {
	csvContent := readWechatEvidenceGoldenCsv(t)
	xlsxContent := buildWechatEvidenceGoldenXlsx(t)

	csvResult := WeChatPayImportEvidenceCsvParser.Probe(context.Background(), importing.EvidenceFile{Content: xlsxContent})
	require.NoError(t, csvResult.Validate(WeChatPayImportEvidenceCsvParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_NONE, csvResult.Confidence)

	xlsxResult := WeChatPayImportEvidenceXlsxParser.Probe(context.Background(), importing.EvidenceFile{Content: csvContent})
	require.NoError(t, xlsxResult.Validate(WeChatPayImportEvidenceXlsxParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_NONE, xlsxResult.Confidence)
}

func TestWeChatPayImportEvidenceCsvParserParseGoldenFile(t *testing.T) {
	content := readWechatEvidenceGoldenCsv(t)
	require.True(t, bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}), "金标 CSV 必须实际包含 UTF-8 BOM")

	document, err := WeChatPayImportEvidenceCsvParser.Parse(
		context.Background(),
		importing.EvidenceFile{OriginalFileName: "synthetic.csv", Content: content},
		wechatEvidenceTestOptions,
	)
	require.NoError(t, err)

	eligibilities, err := importing.ValidateEvidenceDocument(WeChatPayImportEvidenceCsvParser.Descriptor(), document)
	require.NoError(t, err)
	require.Len(t, document.Rows, 6)
	require.Len(t, eligibilities, 6)

	assert.Equal(t, importing.SOURCE_TYPE_WECHAT, document.Metadata.SourceType)
	assert.Equal(t, importing.SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY, document.Metadata.SourceAccount.Kind)
	assert.Empty(t, document.Metadata.SourceAccount.Identifier)
	assert.Equal(t, "合成用户甲", document.Metadata.SourceAccount.DisplayName)
	assert.Equal(t, importing.SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME, document.Metadata.SourceAccount.DiscoveryMethod)
	require.NoError(t, document.Metadata.SourceAccount.Validate(importing.SOURCE_TYPE_WECHAT))

	safeName, err := importing.SafeSourceAccountDisplayName(importing.SOURCE_TYPE_WECHAT, document.Metadata.SourceAccount)
	require.NoError(t, err)
	assert.NotEqual(t, document.Metadata.SourceAccount.DisplayName, safeName)
	assert.NotContains(t, safeName, "成用户")

	statementStart := time.Date(2026, 1, 1, 0, 0, 0, 0, time.FixedZone("", 8*60*60)).Unix()
	statementEnd := time.Date(2026, 1, 31, 23, 59, 59, 0, time.FixedZone("", 8*60*60)).Unix()
	require.NotNil(t, document.Metadata.StatementStartUnixTime)
	require.NotNil(t, document.Metadata.StatementEndUnixTime)
	require.NotNil(t, document.Metadata.StatementTimezoneUtcOffset)
	assert.Equal(t, statementStart, *document.Metadata.StatementStartUnixTime)
	assert.Equal(t, statementEnd, *document.Metadata.StatementEndUnixTime)
	assert.Equal(t, int16(480), *document.Metadata.StatementTimezoneUtcOffset)

	first := document.Rows[0]
	assert.Equal(t, int64(1), first.RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_CSV, CSVStartRow: 7, CSVEndRow: 7}, first.Locator)
	require.Len(t, first.RawFields, 11)
	assert.Equal(t, "交易时间", first.RawFields[0].Name)
	assert.Equal(t, " 2026-01-02 03:04:05 ", first.RawFields[0].Value)
	assert.Equal(t, " 合成银行卡(尾号0000) ", first.RawFields[6].Value)
	assert.Equal(t, " 2026-01-02 03:04:05 ", first.Raw.TransactionTime)
	assert.Equal(t, "￥1,234.56", first.Raw.Amount)
	assert.Equal(t, "支出", first.Raw.Direction)
	assert.Equal(t, " 原始备注保留空格 ", first.Raw.Note)
	require.NotNil(t, first.Normalized.UnixTime)
	require.NotNil(t, first.Normalized.Amount)
	assert.Equal(t, time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("", 8*60*60)).Unix(), *first.Normalized.UnixTime)
	assert.Equal(t, int64(123456), *first.Normalized.Amount)
	assert.Equal(t, importing.NORMALIZED_DIRECTION_EXPENSE, first.Normalized.Direction)
	assert.Equal(t, importing.SOURCE_TRANSACTION_TYPE_PAYMENT, first.Normalized.TransactionType)
	assert.Equal(t, importing.ECONOMIC_EFFECT_NORMAL, first.Normalized.EconomicEffect)
	assert.Equal(t, "合成商户甲", first.Normalized.Counterparty)
	assert.Equal(t, "合成商品甲", first.Normalized.Item)
	assert.Equal(t, "合成银行卡(尾号0000)", first.Normalized.PaymentMethod)
	assert.Equal(t, "原始备注保留空格", first.Normalized.Note)
	assert.Equal(t, "wx-synth-0001", first.Identifiers.TransactionId)
	assert.Empty(t, first.Identifiers.OrderId)
	assert.Equal(t, "merchant-synth-0001", first.Identifiers.MerchantOrderId)
	assert.Equal(t, importing.PARSE_STATE_VALID, first.ParseStatus)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_POSTABLE, eligibilities[0])

	refund := document.Rows[1]
	assert.Equal(t, importing.NORMALIZED_DIRECTION_INCOME, refund.Normalized.Direction)
	assert.Equal(t, importing.SOURCE_TRANSACTION_TYPE_PAYMENT, refund.Normalized.TransactionType)
	assert.Equal(t, importing.ECONOMIC_EFFECT_REFUND, refund.Normalized.EconomicEffect)
	assert.Equal(t, int64(1234), *refund.Normalized.Amount)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_POSTABLE, eligibilities[1])

	unknown := document.Rows[2]
	assert.Equal(t, importing.PARSE_STATE_VALID, unknown.ParseStatus)
	assert.Equal(t, importing.NORMALIZED_DIRECTION_UNKNOWN, unknown.Normalized.Direction)
	assert.Equal(t, importing.SOURCE_TRANSACTION_TYPE_UNKNOWN, unknown.Normalized.TransactionType)
	assert.Equal(t, importing.ECONOMIC_EFFECT_UNKNOWN, unknown.Normalized.EconomicEffect)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, eligibilities[2])
	assertWechatEvidenceIssue(t, unknown.Issues, importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN, importing.ISSUE_SEVERITY_WARNING)
	assertWechatEvidenceIssue(t, unknown.Issues, importing.ISSUE_CODE_ROW_STATUS_UNKNOWN, importing.ISSUE_SEVERITY_WARNING)
	assertWechatEvidenceIssue(t, unknown.Issues, importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN, importing.ISSUE_SEVERITY_WARNING)

	invalid := document.Rows[3]
	assert.Equal(t, importing.PARSE_STATE_INVALID, invalid.ParseStatus)
	assert.Nil(t, invalid.Normalized.UnixTime)
	assert.Nil(t, invalid.Normalized.Amount)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE, eligibilities[3])
	assertWechatEvidenceIssue(t, invalid.Issues, importing.ISSUE_CODE_ROW_TIME_INVALID, importing.ISSUE_SEVERITY_ERROR)
	assertWechatEvidenceIssue(t, invalid.Issues, importing.ISSUE_CODE_ROW_AMOUNT_INVALID, importing.ISSUE_SEVERITY_ERROR)

	empty := document.Rows[4]
	assert.Equal(t, int64(5), empty.RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_CSV, CSVStartRow: 11, CSVEndRow: 11}, empty.Locator)
	assert.Empty(t, empty.RawFields)
	assert.Equal(t, importing.PARSE_STATE_INVALID, empty.ParseStatus)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE, eligibilities[4])
	assertWechatEvidenceIssue(t, empty.Issues, wechatPayIssueRowEmpty, importing.ISSUE_SEVERITY_ERROR)

	multiline := document.Rows[5]
	assert.Equal(t, int64(6), multiline.RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_CSV, CSVStartRow: 12, CSVEndRow: 13}, multiline.Locator)
	assert.Equal(t, "合成备注第一行\n合成备注第二行", multiline.Raw.Note)
	assert.Equal(t, importing.NORMALIZED_DIRECTION_NEUTRAL, multiline.Normalized.Direction)
	assert.Equal(t, importing.SOURCE_TRANSACTION_TYPE_TOP_UP, multiline.Normalized.TransactionType)
	assert.Equal(t, importing.ECONOMIC_EFFECT_NORMAL, multiline.Normalized.EconomicEffect)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, eligibilities[5])

	for index, row := range document.Rows {
		assert.Equal(t, int64(index+1), row.RowNumber)
		_, err := importing.ValidateEvidenceRow(importing.SOURCE_TYPE_WECHAT, row)
		require.NoError(t, err)
	}
}

func TestWeChatPayImportEvidenceCsvParserParseUtf16AndHeaderVariant(t *testing.T) {
	content := bytes.TrimPrefix(readWechatEvidenceGoldenCsv(t), []byte{0xef, 0xbb, 0xbf})
	littleEndian, _, err := transform.Bytes(unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder(), content)
	require.NoError(t, err)
	bigEndian, _, err := transform.Bytes(unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewEncoder(), content)
	require.NoError(t, err)

	for _, test := range []struct {
		name    string
		content []byte
	}{
		{name: "little endian", content: littleEndian},
		{name: "big endian", content: bigEndian},
	} {
		t.Run(test.name, func(t *testing.T) {
			document, err := WeChatPayImportEvidenceCsvParser.Parse(
				context.Background(),
				importing.EvidenceFile{OriginalFileName: "synthetic-utf16.csv", Content: test.content},
				wechatEvidenceTestOptions,
			)
			require.NoError(t, err)
			require.Len(t, document.Rows, 6)
			assert.Equal(t, "合成用户甲", document.Metadata.SourceAccount.DisplayName)
		})
	}

	headerOnly := []byte("交易时间,交易类型,金额（元）,支付方式,当前状态\n2026-02-01 00:00:00,商户消费,￥1.00,零钱,支付成功\n")
	document, err := WeChatPayImportEvidenceCsvParser.Parse(
		context.Background(),
		importing.EvidenceFile{OriginalFileName: "synthetic-header-variant.csv", Content: headerOnly},
		wechatEvidenceTestOptions,
	)
	require.NoError(t, err)
	require.Len(t, document.Rows, 1)
	assert.Equal(t, importing.PARSE_STATE_VALID, document.Rows[0].ParseStatus)
	assert.Equal(t, importing.NORMALIZED_DIRECTION_UNKNOWN, document.Rows[0].Normalized.Direction)
	assertWechatEvidenceIssue(t, document.Issues, wechatPayIssueFilePreambleMissing, importing.ISSUE_SEVERITY_WARNING)
	assertWechatEvidenceIssue(t, document.Rows[0].Issues, importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN, importing.ISSUE_SEVERITY_WARNING)
	_, err = importing.ValidateEvidenceDocument(WeChatPayImportEvidenceCsvParser.Descriptor(), document)
	require.NoError(t, err)
}

func TestWeChatPayImportEvidenceCsvParserReturnsSafeFileErrors(t *testing.T) {
	tests := []struct {
		name     string
		content  []byte
		expected importing.IssueCode
	}{
		{
			name:     "invalid encoding",
			content:  []byte{0xff, 0xfe, 0x00},
			expected: importing.ISSUE_CODE_FILE_ENCODING_INVALID,
		},
		{
			name: "malformed quoted record",
			content: []byte("微信支付账单明细\n" +
				"交易时间,交易类型,收/支,金额(元),当前状态\n" +
				"2026-01-01 00:00:00,商户消费,支出,￥1.00,\"synthetic-secret\n"),
			expected: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID,
		},
		{
			name:     "unrelated format",
			content:  []byte("synthetic-secret"),
			expected: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document, err := WeChatPayImportEvidenceCsvParser.Parse(
				context.Background(),
				importing.EvidenceFile{OriginalFileName: "synthetic.csv", Content: test.content},
				wechatEvidenceTestOptions,
			)
			require.Nil(t, document)
			require.Error(t, err)
			assert.Equal(t, test.expected, importing.NormalizeEvidenceParseError(WeChatPayImportEvidenceCsvParser.Descriptor(), err))
			assert.Equal(t, string(test.expected), err.Error())
			assert.NotContains(t, err.Error(), "synthetic-secret")
		})
	}
}

func TestWeChatPayImportEvidenceCsvParserRejectsMalformedEncodings(t *testing.T) {
	invalidUTF8WechatCsv := append([]byte(
		"微信支付账单明细,,,,,\n"+
			wechatPayTransactionDataHeaderStartContentBeginning+",,,,,\n"+
			"交易时间,交易类型,收/支,金额(元),当前状态,备注\n"+
			"2026-01-01 00:00:00,商户消费,支出,￥1.00,支付成功,synthetic-secret:"), 0xff, '\n')
	tests := []struct {
		name    string
		content []byte
	}{
		{
			name:    "UTF-8 without BOM contains invalid byte",
			content: invalidUTF8WechatCsv,
		},
		{
			name:    "UTF-8 BOM payload contains invalid byte",
			content: append([]byte{0xef, 0xbb, 0xbf}, append([]byte("synthetic-secret:"), 0xc0, 0xaf)...),
		},
		{
			name:    "UTF-16LE has odd payload length",
			content: []byte{0xff, 0xfe, 0x41},
		},
		{
			name:    "UTF-16LE has unpaired high surrogate",
			content: []byte{0xff, 0xfe, 0x00, 0xd8},
		},
		{
			name:    "UTF-16LE has unpaired low surrogate",
			content: []byte{0xff, 0xfe, 0x00, 0xdc},
		},
		{
			name:    "UTF-16BE high surrogate is followed by a non-surrogate",
			content: []byte{0xfe, 0xff, 0xd8, 0x00, 0x00, 0x41},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			file := importing.EvidenceFile{OriginalFileName: "synthetic.csv", Content: test.content}
			probe := WeChatPayImportEvidenceCsvParser.Probe(context.Background(), file)
			require.NoError(t, probe.Validate(WeChatPayImportEvidenceCsvParser.Descriptor()))
			assert.Equal(t, importing.PROBE_CONFIDENCE_NONE, probe.Confidence)
			assert.Equal(t, importing.ISSUE_CODE_FILE_ENCODING_INVALID, probe.IssueCode)

			document, err := WeChatPayImportEvidenceCsvParser.Parse(context.Background(), file, wechatEvidenceTestOptions)
			require.Nil(t, document)
			require.Error(t, err)
			assert.Equal(t, importing.ISSUE_CODE_FILE_ENCODING_INVALID, importing.NormalizeEvidenceParseError(WeChatPayImportEvidenceCsvParser.Descriptor(), err))
			assert.Equal(t, string(importing.ISSUE_CODE_FILE_ENCODING_INVALID), err.Error())
			assert.NotContains(t, err.Error(), "synthetic-secret")
			assert.NotContains(t, err.Error(), "�")
		})
	}
}

func TestDecodeWechatEvidenceCsvAcceptsValidUTF16SurrogatePairs(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{name: "little endian", content: []byte{0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde}},
		{name: "big endian", content: []byte{0xfe, 0xff, 0xd8, 0x3d, 0xde, 0x00}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decoded, err := decodeWechatEvidenceCsv(test.content)
			require.NoError(t, err)
			assert.Equal(t, "😀", decoded)
			assert.NotContains(t, decoded, "�")
		})
	}
}

func TestWeChatPayImportEvidenceParserHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	document, err := WeChatPayImportEvidenceCsvParser.Parse(
		ctx,
		importing.EvidenceFile{Content: readWechatEvidenceGoldenCsv(t)},
		wechatEvidenceTestOptions,
	)
	assert.Nil(t, document)
	assert.True(t, errors.Is(err, context.Canceled))

	result := WeChatPayImportEvidenceCsvParser.Probe(ctx, importing.EvidenceFile{Content: readWechatEvidenceGoldenCsv(t)})
	assert.Equal(t, importing.PROBE_CONFIDENCE_NONE, result.Confidence)
}

func TestNormalizeWechatEvidenceSemantics(t *testing.T) {
	directionTests := map[string]importing.NormalizedDirection{
		"收入":   importing.NORMALIZED_DIRECTION_INCOME,
		" 支出 ": importing.NORMALIZED_DIRECTION_EXPENSE,
		"/":    importing.NORMALIZED_DIRECTION_NEUTRAL,
		"待确认":  importing.NORMALIZED_DIRECTION_UNKNOWN,
	}

	for raw, expected := range directionTests {
		assert.Equal(t, expected, normalizeWechatEvidenceDirection(raw), raw)
	}

	typeTests := map[string]importing.SourceTransactionType{
		"商户消费":  importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
		"信用卡还款": importing.SOURCE_TRANSACTION_TYPE_TRANSFER,
		"零钱充值":  importing.SOURCE_TRANSACTION_TYPE_TOP_UP,
		"零钱提现":  importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL,
		"提现手续费": importing.SOURCE_TRANSACTION_TYPE_FEE,
		"零钱通收益": importing.SOURCE_TRANSACTION_TYPE_OTHER,
		"合成未知":  importing.SOURCE_TRANSACTION_TYPE_UNKNOWN,
	}

	for raw, expected := range typeTests {
		assert.Equal(t, expected, normalizeWechatEvidenceTransactionType(raw), raw)
	}

	effectTests := []struct {
		transactionType string
		status          string
		expected        importing.EconomicEffect
	}{
		{"商户消费", "支付成功", importing.ECONOMIC_EFFECT_NORMAL},
		{"商户消费-退款", "已全额退款", importing.ECONOMIC_EFFECT_REFUND},
		{"商户消费-退款", "退款失败", importing.ECONOMIC_EFFECT_FAILED},
		{"商户消费-退款", "退款处理中", importing.ECONOMIC_EFFECT_UNKNOWN},
		{"商户消费", "交易已关闭", importing.ECONOMIC_EFFECT_CLOSED},
		{"商户消费", "支付失败", importing.ECONOMIC_EFFECT_FAILED},
		{"商户消费", "处理中", importing.ECONOMIC_EFFECT_UNKNOWN},
	}

	for _, test := range effectTests {
		assert.Equal(t, test.expected, normalizeWechatEvidenceEconomicEffect(test.transactionType, test.status), test.status)
	}
}

func TestWeChatPayImportEvidenceXlsxParserParseMultipleSheets(t *testing.T) {
	content := buildWechatEvidenceGoldenXlsx(t)
	file := importing.EvidenceFile{OriginalFileName: "synthetic.xlsx", Content: content}
	probe := WeChatPayImportEvidenceXlsxParser.Probe(context.Background(), file)
	require.NoError(t, probe.Validate(WeChatPayImportEvidenceXlsxParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_EXACT, probe.Confidence)

	document, err := WeChatPayImportEvidenceXlsxParser.Parse(context.Background(), file, wechatEvidenceTestOptions)
	require.NoError(t, err)
	eligibilities, err := importing.ValidateEvidenceDocument(WeChatPayImportEvidenceXlsxParser.Descriptor(), document)
	require.NoError(t, err)
	require.Len(t, document.Rows, 5)
	require.Len(t, eligibilities, 5)

	assert.Equal(t, "合成用户乙", document.Metadata.SourceAccount.DisplayName)
	assert.Equal(t, int64(1), document.Rows[0].RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_XLSX, SheetIndex: 0, SheetName: "合成账单一", XLSXRow: 6}, document.Rows[0].Locator)
	assert.Equal(t, importing.PARSE_STATE_VALID, document.Rows[0].ParseStatus)
	assert.Equal(t, int64(256), *document.Rows[0].Normalized.Amount)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_POSTABLE, eligibilities[0])

	assert.Equal(t, int64(2), document.Rows[1].RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_XLSX, SheetIndex: 0, SheetName: "合成账单一", XLSXRow: 7}, document.Rows[1].Locator)
	assert.Equal(t, importing.PARSE_STATE_INVALID, document.Rows[1].ParseStatus)
	assertWechatEvidenceIssue(t, document.Rows[1].Issues, wechatPayIssueRowEmpty, importing.ISSUE_SEVERITY_ERROR)

	assert.Equal(t, int64(3), document.Rows[2].RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_XLSX, SheetIndex: 0, SheetName: "合成账单一", XLSXRow: 8}, document.Rows[2].Locator)
	assert.Equal(t, importing.PARSE_STATE_INVALID, document.Rows[2].ParseStatus)
	assertWechatEvidenceIssue(t, document.Rows[2].Issues, importing.ISSUE_CODE_ROW_AMOUNT_INVALID, importing.ISSUE_SEVERITY_ERROR)

	assert.Equal(t, int64(4), document.Rows[3].RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_XLSX, SheetIndex: 2, SheetName: "合成账单二", XLSXRow: 2}, document.Rows[3].Locator)
	assert.Equal(t, importing.ECONOMIC_EFFECT_REFUND, document.Rows[3].Normalized.EconomicEffect)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_POSTABLE, eligibilities[3])

	assert.Equal(t, int64(5), document.Rows[4].RowNumber)
	assert.Equal(t, importing.SourceLocator{Kind: importing.LOCATOR_KIND_XLSX, SheetIndex: 2, SheetName: "合成账单二", XLSXRow: 3}, document.Rows[4].Locator)
	assert.Equal(t, importing.PARSE_STATE_INVALID, document.Rows[4].ParseStatus)
	assert.Equal(t, "=1+1", document.Rows[4].Raw.Amount)
	assert.Equal(t, "=1+1", document.Rows[4].RawFields[5].Value)
	assertWechatEvidenceIssue(t, document.Rows[4].Issues, wechatPayIssueXlsxFormula, importing.ISSUE_SEVERITY_ERROR)
	assertWechatEvidenceIssue(t, document.Rows[4].Issues, importing.ISSUE_CODE_ROW_AMOUNT_INVALID, importing.ISSUE_SEVERITY_ERROR)
	assert.Equal(t, importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE, eligibilities[4])

	for index, row := range document.Rows {
		assert.Equal(t, int64(index+1), row.RowNumber)
		encoded, err := importing.EncodeSourceLocator(row.Locator)
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(encoded, "v1:xlsx:"))
	}
}

func TestWeChatPayImportEvidenceXlsxParserReturnsSafeFileError(t *testing.T) {
	content := []byte{'P', 'K', 0x03, 0x04, 's', 'y', 'n', 't', 'h'}
	file := importing.EvidenceFile{OriginalFileName: "synthetic.xlsx", Content: content}
	probe := WeChatPayImportEvidenceXlsxParser.Probe(context.Background(), file)
	require.NoError(t, probe.Validate(WeChatPayImportEvidenceXlsxParser.Descriptor()))
	assert.Equal(t, importing.PROBE_CONFIDENCE_POSSIBLE, probe.Confidence)
	assert.Equal(t, importing.ISSUE_CODE_FILE_FORMAT_INVALID, probe.IssueCode)

	document, err := WeChatPayImportEvidenceXlsxParser.Parse(context.Background(), file, wechatEvidenceTestOptions)
	assert.Nil(t, document)
	require.Error(t, err)
	assert.Equal(t, importing.ISSUE_CODE_FILE_FORMAT_INVALID, importing.NormalizeEvidenceParseError(WeChatPayImportEvidenceXlsxParser.Descriptor(), err))
	assert.Equal(t, string(importing.ISSUE_CODE_FILE_FORMAT_INVALID), err.Error())
}

func TestWeChatPayImportEvidenceCsvParserLocksSourceColumnMapping(t *testing.T) {
	content := []byte("微信支付账单明细,,,,,,,,,,,\n" +
		wechatPayTransactionDataHeaderStartContentBeginning + ",,,,,,,,,,,\n" +
		"交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注,无关列\n" +
		"2026-08-17 10:11:12,MAP-TYPE,MAP-COUNTERPARTY,MAP-ITEM,支出,￥12.34,MAP-PAYMENT,MAP-STATUS,MAP-TX-ID,MAP-MERCHANT-ID,MAP-NOTE,MAP-EXTRA\n")
	assertWechatUnifiedProjection(t, content, importing.CanonicalRawEvidence{
		TransactionTime: "2026-08-17 10:11:12",
		Amount:          "￥12.34",
		Direction:       "支出",
		Status:          "MAP-STATUS",
		TransactionType: "MAP-TYPE",
		Counterparty:    "MAP-COUNTERPARTY",
		Item:            "MAP-ITEM",
		PaymentMethod:   "MAP-PAYMENT",
		Note:            "MAP-NOTE",
	}, importing.SourceIdentifiers{
		TransactionId:   "MAP-TX-ID",
		MerchantOrderId: "MAP-MERCHANT-ID",
	})
}

func TestWeChatPayImportEvidenceCsvParserLocksAliasColumnMapping(t *testing.T) {
	content := []byte("微信支付账单明细,,,,,,,,,,,\n" +
		wechatPayTransactionDataHeaderStartContentBeginning + ",,,,,,,,,,,\n" +
		"交易日期,业务类型,交易对象,商品说明,收支,金额（元）,付款方式,交易状态,微信交易单号,订单号,商家单号,交易备注,无关列\n" +
		"2026-08-17 10:11:12,MAP-TYPE,MAP-COUNTERPARTY,MAP-ITEM,支出,￥12.34,MAP-PAYMENT,MAP-STATUS,MAP-TX-ID,MAP-ORDER-ID,MAP-MERCHANT-ID,MAP-NOTE,MAP-EXTRA\n")
	assertWechatUnifiedProjection(t, content, importing.CanonicalRawEvidence{
		TransactionTime: "2026-08-17 10:11:12",
		Amount:          "￥12.34",
		Direction:       "支出",
		Status:          "MAP-STATUS",
		TransactionType: "MAP-TYPE",
		Counterparty:    "MAP-COUNTERPARTY",
		Item:            "MAP-ITEM",
		PaymentMethod:   "MAP-PAYMENT",
		Note:            "MAP-NOTE",
	}, importing.SourceIdentifiers{
		TransactionId:   "MAP-TX-ID",
		OrderId:         "MAP-ORDER-ID",
		MerchantOrderId: "MAP-MERCHANT-ID",
	})
}

func readWechatEvidenceGoldenCsv(t *testing.T) []byte {
	t.Helper()
	content, err := os.ReadFile("testdata/wechat_pay_evidence_golden.csv")
	require.NoError(t, err)
	return content
}

func buildWechatEvidenceGoldenXlsx(t *testing.T) []byte {
	t.Helper()
	workbook := excelize.NewFile()
	require.NoError(t, workbook.SetSheetName("Sheet1", "合成账单一"))

	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 1, []interface{}{"微信支付账单明细"})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 2, []interface{}{"微信昵称：[合成用户乙]"})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 3, []interface{}{"起始时间：[2026-02-01 00:00:00] 终止时间：[2026-02-28 23:59:59]"})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 4, []interface{}{wechatPayTransactionDataHeaderStartContentBeginning})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 5, []interface{}{
		"交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注",
	})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 6, []interface{}{
		"2026-02-02 01:02:03", "二维码收款", "合成对象一", "合成项目一", "收入", "￥2.56", "/", "已收钱", "wx-xlsx-0001", "merchant-xlsx-0001", "合成备注一",
	})
	setWechatEvidenceSheetRow(t, workbook, "合成账单一", 8, []interface{}{
		"2026-02-03 02:03:04", "商户消费", "合成对象二", "合成项目二", "支出", "￥bad", "零钱", "支付成功", "wx-xlsx-invalid", "/", "合成无效行",
	})

	_, err := workbook.NewSheet("合成说明")
	require.NoError(t, err)
	setWechatEvidenceSheetRow(t, workbook, "合成说明", 1, []interface{}{"这是完全合成且不包含账单数据的说明页"})

	_, err = workbook.NewSheet("合成账单二")
	require.NoError(t, err)
	setWechatEvidenceSheetRow(t, workbook, "合成账单二", 1, []interface{}{
		"交易日期", "业务类型", "交易对象", "商品说明", "收支", "金额（元）", "付款方式", "交易状态", "微信交易单号", "商家单号", "交易备注",
	})
	setWechatEvidenceSheetRow(t, workbook, "合成账单二", 2, []interface{}{
		"2026-02-04 03:04:05", "商户消费-退款", "合成对象三", "合成项目三", "收入", "￥1.25", "零钱", "退款成功", "wx-xlsx-0002", "merchant-xlsx-0002", "合成退款行",
	})
	setWechatEvidenceSheetRow(t, workbook, "合成账单二", 3, []interface{}{
		"2026-02-05 04:05:06", "商户消费", "合成对象四", "合成项目四", "支出", "", "零钱", "支付成功", "wx-xlsx-formula", "merchant-xlsx-formula", "合成公式行",
	})
	require.NoError(t, workbook.SetCellFormula("合成账单二", "F3", "=1+1"))

	buffer, err := workbook.WriteToBuffer()
	require.NoError(t, err)
	require.NoError(t, workbook.Close())
	return buffer.Bytes()
}

func setWechatEvidenceSheetRow(t *testing.T, workbook *excelize.File, sheet string, row int, values []interface{}) {
	t.Helper()
	cell, err := excelize.CoordinatesToCellName(1, row)
	require.NoError(t, err)
	require.NoError(t, workbook.SetSheetRow(sheet, cell, &values))
}

func assertWechatUnifiedProjection(t *testing.T, content []byte, wantRaw importing.CanonicalRawEvidence, wantIDs importing.SourceIdentifiers) {
	t.Helper()

	document, err := WeChatPayImportEvidenceCsvParser.Parse(
		context.Background(),
		importing.EvidenceFile{OriginalFileName: "mapping.csv", Content: content},
		wechatEvidenceTestOptions,
	)
	require.NoError(t, err)
	require.Len(t, document.Rows, 1)

	row := document.Rows[0]
	assert.Equal(t, wantRaw, row.Raw)
	assert.Equal(t, wantIDs, row.Identifiers)
	assert.NotContains(t, fmt.Sprintf("%+v%+v", row.Raw, row.Identifiers), "MAP-EXTRA")
}

func assertWechatEvidenceIssue(t *testing.T, issues []importing.EvidenceIssue, code importing.IssueCode, severity importing.IssueSeverity) {
	t.Helper()

	for _, issue := range issues {
		if issue.Code == code && issue.Severity == severity {
			return
		}
	}

	assert.Failf(t, "missing evidence issue", "code=%s severity=%s issues=%v", code, severity, issues)
}
