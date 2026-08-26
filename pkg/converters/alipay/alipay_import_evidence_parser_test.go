package alipay

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

var alipayEvidenceTestOptions = importing.ResolvedParseOptions{
	Currency:          "CNY",
	TimezoneUtcOffset: 480,
}

func TestAlipayEvidenceParserDescriptorsAndProbe(t *testing.T) {
	appContent := readAlipayEvidenceFixture(t, "testdata/alipay_app_utf8_bom.csv")
	webContent := readAlipayEvidenceFixture(t, "testdata/alipay_web_utf8.csv")

	if !bytes.HasPrefix(appContent, []byte{0xef, 0xbb, 0xbf}) {
		t.Fatal("App 金标夹具必须覆盖 UTF-8 BOM")
	}

	tests := []struct {
		name           string
		parser         importing.ImportEvidenceParser
		content        []byte
		expectedName   string
		expectedFormat importing.EvidenceFormat
		crossParser    importing.ImportEvidenceParser
		crossContent   []byte
	}{
		{
			name:           "app",
			parser:         AlipayAppImportEvidenceParser,
			content:        appContent,
			expectedName:   "alipay-app-csv",
			expectedFormat: importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV,
			crossParser:    AlipayWebImportEvidenceParser,
			crossContent:   appContent,
		},
		{
			name:           "web",
			parser:         AlipayWebImportEvidenceParser,
			content:        webContent,
			expectedName:   "alipay-web-csv",
			expectedFormat: importing.EVIDENCE_FORMAT_ALIPAY_WEB_CSV,
			crossParser:    AlipayAppImportEvidenceParser,
			crossContent:   webContent,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := test.parser.Descriptor()

			if err := descriptor.Validate(); err != nil {
				t.Fatalf("descriptor 未通过中心校验: %v", err)
			}

			if descriptor.Name != test.expectedName ||
				descriptor.SourceType != importing.SOURCE_TYPE_ALIPAY ||
				descriptor.Format != test.expectedFormat ||
				descriptor.ParserVersion != alipayEvidenceParserVersion ||
				descriptor.NormalizationVersion != alipayEvidenceNormalizationVersion {
				t.Fatalf("descriptor 版本或格式不符合冻结值: %+v", descriptor)
			}

			probe := test.parser.Probe(context.Background(), importing.EvidenceFile{Content: test.content})

			if err := probe.Validate(descriptor); err != nil {
				t.Fatalf("probe 未通过中心校验: %v", err)
			}

			if probe.Confidence != importing.PROBE_CONFIDENCE_EXACT || probe.IssueCode != importing.ISSUE_CODE_NONE {
				t.Fatalf("有效 %s 夹具探测结果异常: %+v", test.name, probe)
			}

			crossProbe := test.crossParser.Probe(context.Background(), importing.EvidenceFile{Content: test.crossContent})

			if err := crossProbe.Validate(test.crossParser.Descriptor()); err != nil {
				t.Fatalf("交叉 probe 未通过中心校验: %v", err)
			}

			if crossProbe.Confidence != importing.PROBE_CONFIDENCE_NONE {
				t.Fatalf("%s 格式被另一解析器误认: %+v", test.name, crossProbe)
			}
		})
	}

	unmatched := AlipayAppImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: []byte("synthetic,not,alipay\n")})

	if err := unmatched.Validate(AlipayAppImportEvidenceParser.Descriptor()); err != nil {
		t.Fatalf("未匹配 probe 未通过中心校验: %v", err)
	}

	if unmatched.Confidence != importing.PROBE_CONFIDENCE_NONE || unmatched.SourceType != "" || unmatched.Format != "" {
		t.Fatalf("普通 CSV 被误认成支付宝 App: %+v", unmatched)
	}
}

func TestAlipayEvidenceParserUsesConcreteProductSemanticsBeforeBroadCategory(t *testing.T) {
	content := []byte("------------------------------------------------------------------------------------\n" +
		"支付宝账户：synthetic@example.test\n" +
		"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
		"交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,备注\n" +
		"2026-07-02 08:00:00,投资理财,天弘基金管理有限公司,余额宝-2026.07.02-收益发放,不计收支,0.01,余额宝,交易成功,SYN-EARNING-001,收益发放\n")

	document, err := AlipayAppImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{
		OriginalFileName: "synthetic-earning.csv",
		Content:          content,
	}, alipayEvidenceTestOptions)

	if err != nil {
		t.Fatalf("解析收益发放样例失败: %v", err)
	}
	if len(document.Rows) != 1 {
		t.Fatalf("收益发放样例行数错误: %d", len(document.Rows))
	}

	row := document.Rows[0]
	if row.Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME ||
		row.Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER ||
		row.Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL {
		t.Fatalf("收益发放语义错误: %+v", row.Normalized)
	}
	if hasAlipayEvidenceIssue(row.Issues, importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN) ||
		hasAlipayEvidenceIssue(row.Issues, importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN) {
		t.Fatalf("收益发放不应进入方向或类型待确认: %+v", row.Issues)
	}
}

func TestAlipayEvidenceParserTreatsExplicitRewardAsIncome(t *testing.T) {
	content := []byte("------------------------------------------------------------------------------------\n" +
		"支付宝账户：synthetic@example.test\n" +
		"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
		"交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,备注\n" +
		"2026-07-23 15:30:54,转账红包,活动平台,平台活动奖励,收入,30.00,-,交易成功,SYN-REWARD-001,\n")

	document, err := AlipayAppImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{
		OriginalFileName: "synthetic-reward.csv",
		Content:          content,
	}, alipayEvidenceTestOptions)
	if err != nil {
		t.Fatalf("解析活动奖励样例失败: %v", err)
	}
	if len(document.Rows) != 1 {
		t.Fatalf("活动奖励样例行数错误: %d", len(document.Rows))
	}
	row := document.Rows[0]
	if row.Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME ||
		row.Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER ||
		row.Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL {
		t.Fatalf("活动奖励语义错误: %+v", row.Normalized)
	}
	if hasAlipayEvidenceIssue(row.Issues, importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN) ||
		hasAlipayEvidenceIssue(row.Issues, importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN) {
		t.Fatalf("活动奖励不应进入方向或类型待确认: %+v", row.Issues)
	}
}

func TestAlipayAppEvidenceParserGoldenDocument(t *testing.T) {
	content := readAlipayEvidenceFixture(t, "testdata/alipay_app_utf8_bom.csv")
	document, err := AlipayAppImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{
		OriginalFileName: "synthetic-app.csv",
		Content:          content,
	}, alipayEvidenceTestOptions)

	if err != nil {
		t.Fatalf("解析 App 金标夹具失败: %v", err)
	}

	eligibilities, err := importing.ValidateEvidenceDocument(AlipayAppImportEvidenceParser.Descriptor(), document)

	if err != nil {
		t.Fatalf("App 文档未通过中心校验: %v", err)
	}

	if len(document.Rows) != 7 {
		t.Fatalf("逻辑行数量错误: %d", len(document.Rows))
	}

	if document.Metadata.SourceAccount.Kind != importing.SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER ||
		document.Metadata.SourceAccount.Identifier != "ledger.user@example.test" ||
		document.Metadata.SourceAccount.DisplayName != "" ||
		document.Metadata.SourceAccount.DiscoveryMethod != importing.SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT {
		t.Fatalf("稳定来源账户证据错误: %+v", document.Metadata.SourceAccount)
	}

	sourceAccountKey, err := importing.ComputeSourceAccountKey(importing.SOURCE_TYPE_ALIPAY, document.Metadata.SourceAccount)

	if err != nil || len(sourceAccountKey) != 64 || strings.Contains(sourceAccountKey, "ledger.user") {
		t.Fatalf("稳定来源账户 key 异常: length=%d err=%v", len(sourceAccountKey), err)
	}

	safeDisplay, err := importing.SafeSourceAccountDisplayName(importing.SOURCE_TYPE_ALIPAY, document.Metadata.SourceAccount)

	if err != nil || safeDisplay != "l***@e******.test" {
		t.Fatalf("来源账户脱敏展示错误: %q %v", safeDisplay, err)
	}

	expectedStart := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60)).Unix()
	expectedEnd := time.Date(2026, time.August, 31, 23, 59, 59, 0, time.FixedZone("UTC+8", 8*60*60)).Unix()

	if document.Metadata.StatementStartUnixTime == nil || *document.Metadata.StatementStartUnixTime != expectedStart ||
		document.Metadata.StatementEndUnixTime == nil || *document.Metadata.StatementEndUnixTime != expectedEnd ||
		document.Metadata.StatementTimezoneUtcOffset == nil || *document.Metadata.StatementTimezoneUtcOffset != 480 {
		t.Fatalf("账期元数据错误: %+v", document.Metadata)
	}

	expectedLocators := [][2]int64{{9, 10}, {11, 11}, {12, 12}, {13, 13}, {14, 14}, {15, 15}, {16, 16}}

	for index, expected := range expectedLocators {
		row := document.Rows[index]

		if row.RowNumber != int64(index+1) || row.Locator.Kind != importing.LOCATOR_KIND_CSV ||
			row.Locator.CSVStartRow != expected[0] || row.Locator.CSVEndRow != expected[1] {
			t.Fatalf("第 %d 行物理定位错误: %+v", index+1, row.Locator)
		}
	}

	first := document.Rows[0]

	if first.Raw.Counterparty != "  合成商户甲  " || first.Normalized.Counterparty != "合成商户甲" {
		t.Fatalf("trim 前后证据未分离: raw=%q normalized=%q", first.Raw.Counterparty, first.Normalized.Counterparty)
	}
	if first.Raw.PaymentMethod != "合成银行卡(尾号0001)" || first.Normalized.PaymentMethod != "合成银行卡(尾号0001)" {
		t.Fatalf("付款方式列未进入规范化证据: raw=%q normalized=%q", first.Raw.PaymentMethod, first.Normalized.PaymentMethod)
	}

	if first.Raw.Note != "合成备注第一行\n合成备注第二行" || first.RawFields[2].Name != "交易对方" || first.RawFields[2].Value != "  合成商户甲  " {
		t.Fatalf("有序原始快照错误: raw_note=%q raw_field=%+v", first.Raw.Note, first.RawFields[2])
	}

	if first.ParseStatus != importing.PARSE_STATE_VALID || first.Normalized.UnixTime == nil ||
		first.Normalized.Amount == nil || *first.Normalized.Amount != 1234 ||
		first.Normalized.Direction != importing.NORMALIZED_DIRECTION_EXPENSE ||
		first.Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL ||
		first.Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_PAYMENT ||
		first.Identifiers.TransactionId != "SYN-TX-001" ||
		first.Identifiers.MerchantOrderId != "SYN-MERCHANT-001" {
		t.Fatalf("首行标准化结果错误: %+v", first)
	}

	identity, err := importing.BuildIdentityCandidate(importing.IdentityBuildInput{
		ParseState:           first.ParseStatus,
		SourceType:           importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey:     sourceAccountKey,
		BatchId:              1,
		RowNumber:            first.RowNumber,
		Identifiers:          first.Identifiers,
		Normalized:           first.Normalized,
		FingerprintMaterials: first.FingerprintMaterials,
	})

	if err != nil || identity == nil || identity.Kind != importing.IDENTITY_KIND_SOURCE_TRANSACTION_ID {
		t.Fatalf("中心身份构造未消费解析结果: %+v %v", identity, err)
	}

	if document.Rows[1].ParseStatus != importing.PARSE_STATE_INVALID || document.Rows[1].Normalized.UnixTime != nil ||
		document.Rows[1].Normalized.Amount == nil || *document.Rows[1].Normalized.Amount != 200 ||
		!hasAlipayEvidenceIssue(document.Rows[1].Issues, importing.ISSUE_CODE_ROW_TIME_INVALID) {
		t.Fatalf("无效时间行未完整保留: %+v", document.Rows[1])
	}

	if document.Rows[2].ParseStatus != importing.PARSE_STATE_INVALID || document.Rows[2].Normalized.Amount != nil ||
		!hasAlipayEvidenceIssue(document.Rows[2].Issues, importing.ISSUE_CODE_ROW_AMOUNT_INVALID) {
		t.Fatalf("无效金额行未完整保留: %+v", document.Rows[2])
	}

	if document.Rows[3].Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME ||
		document.Rows[3].Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND {
		t.Fatalf("退款语义错误: %+v", document.Rows[3].Normalized)
	}

	if document.Rows[4].Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_CLOSED {
		t.Fatalf("关闭状态语义错误: %+v", document.Rows[4].Normalized)
	}

	if document.Rows[5].Normalized.Direction != importing.NORMALIZED_DIRECTION_UNKNOWN ||
		document.Rows[5].Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_UNKNOWN ||
		document.Rows[5].Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_UNKNOWN ||
		!hasAlipayEvidenceIssue(document.Rows[5].Issues, importing.ISSUE_CODE_ROW_DIRECTION_UNKNOWN) ||
		!hasAlipayEvidenceIssue(document.Rows[5].Issues, importing.ISSUE_CODE_ROW_STATUS_UNKNOWN) ||
		!hasAlipayEvidenceIssue(document.Rows[5].Issues, importing.ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN) {
		t.Fatalf("未知语义未稳定降级: %+v", document.Rows[5])
	}

	if document.Rows[6].ParseStatus != importing.PARSE_STATE_VALID ||
		document.Rows[6].Normalized.Direction != importing.NORMALIZED_DIRECTION_NEUTRAL ||
		document.Rows[6].Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_UNKNOWN {
		t.Fatalf("待复核逻辑行被丢弃或误判: %+v", document.Rows[6])
	}

	expectedEligibility := []importing.SemanticEligibility{
		importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE,
		importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE,
		importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE,
		importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED,
		importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED,
	}

	for index := range expectedEligibility {
		if eligibilities[index] != expectedEligibility[index] {
			t.Fatalf("第 %d 行中心语义资格错误: got=%s want=%s", index+1, eligibilities[index], expectedEligibility[index])
		}
	}
}

func TestAlipayWebEvidenceParserGB18030GoldenDocument(t *testing.T) {
	utf8Content := readAlipayEvidenceFixture(t, "testdata/alipay_web_utf8.csv")
	encoded, _, err := transform.Bytes(simplifiedchinese.GB18030.NewEncoder(), utf8Content)

	if err != nil {
		t.Fatalf("构造 GB18030 合成夹具失败: %v", err)
	}

	if utf8.Valid(encoded) {
		t.Fatal("Web 编码测试没有真正生成非 UTF-8 字节")
	}

	probe := AlipayWebImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: encoded})

	if err := probe.Validate(AlipayWebImportEvidenceParser.Descriptor()); err != nil {
		t.Fatalf("GB18030 probe 未通过中心校验: %v", err)
	}

	if probe.Confidence != importing.PROBE_CONFIDENCE_EXACT || probe.IssueCode != importing.ISSUE_CODE_NONE {
		t.Fatalf("GB18030 Web 探测失败: %+v", probe)
	}

	document, err := AlipayWebImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{
		OriginalFileName: "synthetic-web.csv",
		Content:          encoded,
	}, alipayEvidenceTestOptions)

	if err != nil {
		t.Fatalf("解析 GB18030 Web 金标夹具失败: %v", err)
	}

	eligibilities, err := importing.ValidateEvidenceDocument(AlipayWebImportEvidenceParser.Descriptor(), document)

	if err != nil {
		t.Fatalf("Web 文档未通过中心校验: %v", err)
	}

	if len(document.Rows) != 3 {
		t.Fatalf("Web 逻辑行数量错误: %d", len(document.Rows))
	}

	if document.Metadata.SourceAccount.Kind != importing.SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY ||
		document.Metadata.SourceAccount.DisplayName != "***0000" ||
		document.Metadata.SourceAccount.Identifier != "" {
		t.Fatalf("掩码来源账户证据错误: %+v", document.Metadata.SourceAccount)
	}

	if _, err := importing.ComputeSourceAccountKey(importing.SOURCE_TYPE_ALIPAY, document.Metadata.SourceAccount); err == nil {
		t.Fatal("掩码来源账户错误生成了跨文件 key")
	}

	if display, err := importing.SafeSourceAccountDisplayName(importing.SOURCE_TYPE_ALIPAY, document.Metadata.SourceAccount); err != nil || display != "***0000" {
		t.Fatalf("掩码来源账户展示错误: %q %v", display, err)
	}

	for index, row := range document.Rows {
		expectedLine := int64(index + 6)

		if row.RowNumber != int64(index+1) || row.Locator.CSVStartRow != expectedLine || row.Locator.CSVEndRow != expectedLine {
			t.Fatalf("Web 第 %d 行定位错误: %+v", index+1, row.Locator)
		}
	}

	if document.Rows[0].RawFields[2].Name != " 交易创建时间 " ||
		document.Rows[0].RawFields[9].Name != " 金额（元） " {
		t.Fatalf("Web 原始表头差异未保留: time=%q amount=%q", document.Rows[0].RawFields[2].Name, document.Rows[0].RawFields[9].Name)
	}

	if document.Rows[0].Identifiers.TransactionId != "SYN-WEB-TX-001" ||
		document.Rows[0].Identifiers.MerchantOrderId != "SYN-WEB-MERCHANT-001" ||
		document.Rows[0].Normalized.Amount == nil || *document.Rows[0].Normalized.Amount != 888 ||
		document.Rows[0].Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_PAYMENT ||
		document.Rows[0].Normalized.PaymentMethod != "" {
		t.Fatalf("Web 首行投影错误: %+v", document.Rows[0])
	}

	if document.Rows[1].Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_FAILED ||
		eligibilities[1] != importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE {
		t.Fatalf("失败交易语义错误: %+v eligibility=%s", document.Rows[1].Normalized, eligibilities[1])
	}

	if document.Rows[2].Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND ||
		document.Rows[2].Normalized.Direction != importing.NORMALIZED_DIRECTION_NEUTRAL ||
		eligibilities[2] != importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED {
		t.Fatalf("Web 退款待复核语义错误: %+v eligibility=%s", document.Rows[2].Normalized, eligibilities[2])
	}
}

func TestAlipayEvidenceParserRetainsStructurallyInvalidLogicalRows(t *testing.T) {
	content := []byte("\n" +
		"------------------------------------------------------------------------------------\n" +
		"\n" +
		"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
		"\n" +
		"交易时间,收/支,金额,交易状态,交易订单号,备注\n" +
		"\n" +
		",,,,,\n" +
		"2026-08-02 10:00:00,支出,1.00,交易成功,SYN-EMPTY-NEXT,合成有效行\n" +
		"------------------------------------------------------------------------------------\n")
	document, err := AlipayAppImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, alipayEvidenceTestOptions)

	if err != nil {
		t.Fatalf("包含缺列逻辑行的文件不应整体解析失败: %v", err)
	}

	eligibilities, err := importing.ValidateEvidenceDocument(AlipayAppImportEvidenceParser.Descriptor(), document)

	if err != nil {
		t.Fatalf("缺列逻辑行未通过中心校验: %v", err)
	}

	if document.Metadata.SourceAccount.Kind != importing.SOURCE_ACCOUNT_EVIDENCE_MISSING ||
		!hasAlipayEvidenceIssue(document.Issues, alipayIssueSourceAccountMissing) {
		t.Fatalf("缺失来源账户证据未稳定表达: metadata=%+v issues=%+v", document.Metadata, document.Issues)
	}

	if len(document.Rows) != 3 || len(eligibilities) != 3 {
		t.Fatalf("数据区空记录或后续有效行丢失: rows=%d eligibility=%v", len(document.Rows), eligibilities)
	}

	emptyPhysicalRow := document.Rows[0]

	if emptyPhysicalRow.RowNumber != 1 || emptyPhysicalRow.Locator.CSVStartRow != 7 || emptyPhysicalRow.Locator.CSVEndRow != 7 ||
		emptyPhysicalRow.ParseStatus != importing.PARSE_STATE_INVALID || len(emptyPhysicalRow.RawFields) != 0 ||
		eligibilities[0] != importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE ||
		!hasAlipayEvidenceIssue(emptyPhysicalRow.Issues, alipayIssueRowColumnCountMismatch) ||
		!hasAlipayEvidenceIssue(emptyPhysicalRow.Issues, importing.ISSUE_CODE_ROW_FIELD_MISSING) {
		t.Fatalf("真正空物理行证据错误: %+v", emptyPhysicalRow)
	}

	allEmptyFieldsRow := document.Rows[1]

	if allEmptyFieldsRow.RowNumber != 2 || allEmptyFieldsRow.Locator.CSVStartRow != 8 || allEmptyFieldsRow.Locator.CSVEndRow != 8 ||
		allEmptyFieldsRow.ParseStatus != importing.PARSE_STATE_INVALID || len(allEmptyFieldsRow.RawFields) != 6 ||
		allEmptyFieldsRow.RawFields[0].Name != "交易时间" || allEmptyFieldsRow.RawFields[0].Value != "" ||
		eligibilities[1] != importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE ||
		hasAlipayEvidenceIssue(allEmptyFieldsRow.Issues, alipayIssueRowColumnCountMismatch) ||
		!hasAlipayEvidenceIssue(allEmptyFieldsRow.Issues, importing.ISSUE_CODE_ROW_FIELD_MISSING) {
		t.Fatalf("逗号组成的全空字段记录证据错误: %+v", allEmptyFieldsRow)
	}

	validRow := document.Rows[2]

	if validRow.RowNumber != 3 || validRow.Locator.CSVStartRow != 9 || validRow.Locator.CSVEndRow != 9 ||
		validRow.ParseStatus != importing.PARSE_STATE_VALID || validRow.Normalized.Amount == nil || *validRow.Normalized.Amount != 100 ||
		eligibilities[2] != importing.SEMANTIC_ELIGIBILITY_POSTABLE {
		t.Fatalf("空记录后的有效逻辑行编号或语义错误: %+v eligibility=%s", validRow, eligibilities[2])
	}
}

func TestNormalizeAlipayEconomicEffectTreatsRepaymentFailureAsFailed(t *testing.T) {
	if actual := normalizeAlipayEconomicEffect("还款失败"); actual != importing.ECONOMIC_EFFECT_FAILED {
		t.Fatalf("还款失败不应进入人工性质判断: %s", actual)
	}
}

func TestAlipayEvidenceParserSafeFileErrors(t *testing.T) {
	tests := []struct {
		name     string
		parser   importing.ImportEvidenceParser
		content  []byte
		expected importing.IssueCode
	}{
		{
			name:     "utf16_encoding",
			parser:   AlipayAppImportEvidenceParser,
			content:  []byte{0xff, 0xfe, 'x', 0},
			expected: importing.ISSUE_CODE_FILE_ENCODING_INVALID,
		},
		{
			name:   "malformed_csv",
			parser: AlipayAppImportEvidenceParser,
			content: []byte("------------------------------------------------------------------------------------\n" +
				"支付宝账户：synthetic@example.test\n" +
				"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
				"交易时间,收/支,金额,交易状态\n" +
				"2026-08-01 00:00:00,支出,1.00,\"未闭合\n"),
			expected: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID,
		},
		{
			name:   "missing_required_header",
			parser: AlipayAppImportEvidenceParser,
			content: []byte("------------------------------------------------------------------------------------\n" +
				"支付宝账户：synthetic@example.test\n" +
				"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
				"交易时间,收/支,金额\n" +
				"2026-08-01 00:00:00,支出,1.00\n"),
			expected: importing.ISSUE_CODE_FILE_STRUCTURE_INVALID,
		},
		{
			name:     "wrong_format",
			parser:   AlipayAppImportEvidenceParser,
			content:  readAlipayEvidenceFixture(t, "testdata/alipay_web_utf8.csv"),
			expected: importing.ISSUE_CODE_FILE_FORMAT_INVALID,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.parser.Parse(context.Background(), importing.EvidenceFile{
				OriginalFileName: "synthetic-account-should-not-leak.csv",
				Content:          test.content,
			}, alipayEvidenceTestOptions)

			if err == nil {
				t.Fatal("无效文件未返回错误")
			}

			code := importing.NormalizeEvidenceParseError(test.parser.Descriptor(), err)

			if code != test.expected {
				t.Fatalf("安全错误码错误: got=%s want=%s err=%v", code, test.expected, err)
			}

			if strings.Contains(err.Error(), "synthetic-account") || strings.Contains(err.Error(), "synthetic@example.test") {
				t.Fatalf("文件级错误泄露原始值: %q", err.Error())
			}
		})
	}

	probe := AlipayAppImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: []byte{0xff, 0xfe, 'x', 0}})

	if err := probe.Validate(AlipayAppImportEvidenceParser.Descriptor()); err != nil {
		t.Fatalf("编码错误 probe 未通过中心校验: %v", err)
	}

	if probe.Confidence != importing.PROBE_CONFIDENCE_NONE || probe.IssueCode != importing.ISSUE_CODE_FILE_ENCODING_INVALID {
		t.Fatalf("编码错误 probe 不安全或不稳定: %+v", probe)
	}
}

func TestAlipayAppEvidenceParserLocksSourceColumnMapping(t *testing.T) {
	content := []byte("" +
		"------------------------------------------------------------------------------------\n" +
		"导出信息：\n" +
		"支付宝账户：mapping.user@example.test\n" +
		"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
		"交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,无关列\n" +
		"2026-08-17 10:11:12,MAP-TYPE,MAP-COUNTERPARTY,MAP-ITEM,支出,12.34,MAP-PAYMENT,MAP-STATUS,MAP-TX-ID,MAP-MERCHANT-ID,MAP-NOTE,MAP-EXTRA\n")
	assertAlipayUnifiedProjection(t, AlipayAppImportEvidenceParser, content, importing.CanonicalRawEvidence{
		TransactionTime: "2026-08-17 10:11:12",
		Amount:          "12.34",
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

func TestAlipayAppEvidenceParserLocksColumnAliases(t *testing.T) {
	content := []byte("" +
		"------------------------------------------------------------------------------------\n" +
		"导出信息：\n" +
		"支付宝账户：mapping.user@example.test\n" +
		"------------------------支付宝支付科技有限公司  电子客户回单------------------------\n" +
		"交易时间,类型,交易对方,商品名称,收/支,金额,资金渠道,交易状态,支付宝交易号,商户订单号,备注\n" +
		"2026-08-17 10:11:12,MAP-TYPE,MAP-COUNTERPARTY,MAP-ITEM,支出,12.34,MAP-PAYMENT,MAP-STATUS,MAP-TX-ID,MAP-MERCHANT-ID,MAP-NOTE\n")
	assertAlipayUnifiedProjection(t, AlipayAppImportEvidenceParser, content, importing.CanonicalRawEvidence{
		TransactionTime: "2026-08-17 10:11:12",
		Amount:          "12.34",
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

func TestAlipayWebEvidenceParserLocksSourceColumnMapping(t *testing.T) {
	content := []byte("" +
		"支付宝交易记录明细查询\n" +
		"账号:[***0000]\n" +
		"---------------------------------交易记录明细列表------------------------------------\n" +
		"交易号,商户订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,无关列\n" +
		"MAP-TX-ID,MAP-MERCHANT-ID,2026-08-17 10:11:12,MAP-PAY-TIME,MAP-MODIFY-TIME,MAP-SOURCE,MAP-TYPE,MAP-COUNTERPARTY,MAP-ITEM,12.34,支出,MAP-STATUS,MAP-FEE,MAP-REFUND,MAP-NOTE,MAP-EXTRA\n")
	assertAlipayUnifiedProjection(t, AlipayWebImportEvidenceParser, content, importing.CanonicalRawEvidence{
		TransactionTime: "2026-08-17 10:11:12",
		Amount:          "12.34",
		Direction:       "支出",
		Status:          "MAP-STATUS",
		TransactionType: "MAP-TYPE",
		Counterparty:    "MAP-COUNTERPARTY",
		Item:            "MAP-ITEM",
		Note:            "MAP-NOTE",
	}, importing.SourceIdentifiers{
		TransactionId:   "MAP-TX-ID",
		MerchantOrderId: "MAP-MERCHANT-ID",
	})
}

func TestAlipayEvidenceParserCancellationAndOptions(t *testing.T) {
	content := readAlipayEvidenceFixture(t, "testdata/alipay_app_utf8_bom.csv")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := AlipayAppImportEvidenceParser.Parse(ctx, importing.EvidenceFile{Content: content}, alipayEvidenceTestOptions); !errors.Is(err, context.Canceled) {
		t.Fatalf("解析未传播取消信号: %v", err)
	}

	invalidOptions := importing.ResolvedParseOptions{Currency: "cny", TimezoneUtcOffset: 480}
	_, err := AlipayAppImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, invalidOptions)

	if code := importing.NormalizeEvidenceParseError(AlipayAppImportEvidenceParser.Descriptor(), err); code != importing.ISSUE_CODE_FILE_FORMAT_INVALID {
		t.Fatalf("无效解析选项未收敛为安全错误码: %s (%v)", code, err)
	}
}

func assertAlipayUnifiedProjection(t *testing.T, parser importing.ImportEvidenceParser, content []byte, wantRaw importing.CanonicalRawEvidence, wantIDs importing.SourceIdentifiers) {
	t.Helper()

	document, err := parser.Parse(context.Background(), importing.EvidenceFile{
		OriginalFileName: "mapping.csv",
		Content:          content,
	}, alipayEvidenceTestOptions)
	if err != nil {
		t.Fatalf("解析映射夹具失败: %v", err)
	}
	if len(document.Rows) != 1 {
		t.Fatalf("映射夹具行数错误: %d", len(document.Rows))
	}

	row := document.Rows[0]
	if row.Raw != wantRaw {
		t.Fatalf("来源列未对到统一字段: raw=%+v want=%+v", row.Raw, wantRaw)
	}
	if row.Identifiers != wantIDs {
		t.Fatalf("来源单号未对到统一字段: ids=%+v want=%+v", row.Identifiers, wantIDs)
	}
	if strings.Contains(row.Raw.TransactionTime+row.Raw.Amount+row.Raw.Direction+row.Raw.Status+row.Raw.TransactionType+row.Raw.Counterparty+row.Raw.Item+row.Raw.PaymentMethod+row.Raw.Note+row.Identifiers.TransactionId+row.Identifiers.OrderId+row.Identifiers.MerchantOrderId, "MAP-EXTRA") {
		t.Fatalf("无关列泄漏进统一字段: raw=%+v ids=%+v", row.Raw, row.Identifiers)
	}
}

func readAlipayEvidenceFixture(t *testing.T, path string) []byte {
	t.Helper()

	content, err := os.ReadFile(path)

	if err != nil {
		t.Fatalf("读取合成金标夹具失败: %v", err)
	}

	return content
}

func hasAlipayEvidenceIssue(issues []importing.EvidenceIssue, code importing.IssueCode) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}

	return false
}
