package billflow

import (
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestTodoPreviewUsesBankDescriptionAsCounterparty(t *testing.T) {
	row := &importing.RawImportRow{RawItem: "支付宝 拼多多平台商户"}
	if got := todoPreviewLabel(row); got != "支付宝 拼多多平台商户" {
		t.Fatalf("bank description should display as counterparty, got %q", got)
	}
	if got := todoPreviewItem(row); got != "" {
		t.Fatalf("duplicate bank description should not fill item, got %q", got)
	}
}

func TestTodoPreviewKeepsDistinctItem(t *testing.T) {
	row := &importing.RawImportRow{RawCounterparty: "星巴克", RawItem: "拿铁"}
	if got := todoPreviewLabel(row); got != "星巴克" {
		t.Fatalf("counterparty: %q", got)
	}
	if got := todoPreviewItem(row); got != "拿铁" {
		t.Fatalf("item: %q", got)
	}
}

func TestTodoPreviewOmitsMerchantOrderItem(t *testing.T) {
	row := &importing.RawImportRow{
		RawCounterparty:       "拼多多平台商户",
		RawItem:               "商户单号XPTESTORDER",
		SourceMerchantOrderId: "XPTESTORDER",
	}
	if got := todoPreviewLabel(row); got != "拼多多平台商户" {
		t.Fatalf("counterparty: %q", got)
	}
	if got := todoPreviewItem(row); got != "" {
		t.Fatalf("order-id style item should be omitted, got %q", got)
	}
}

func TestAlipayBroadCategoriesUseConservativeLedgerLeaves(t *testing.T) {
	for source, expected := range map[string]string{
		"餐饮美食": "食品",
		"交通出行": "公共交通",
		"医疗健康": "检查治疗",
	} {
		if got := sourceCategoryLeafFallback(importing.SOURCE_TYPE_ALIPAY, source); got != expected {
			t.Fatalf("fallback for %q: got %q want %q", source, got, expected)
		}
	}
	if got := sourceCategoryLeafFallback(importing.SOURCE_TYPE_WECHAT, "商户消费"); got != "" {
		t.Fatalf("generic WeChat action must not become a ledger category: %q", got)
	}
	index := &categoryIndex{leaves: map[string]int64{canonicalCategoryName("食品"): 51}, aliases: map[string]int64{}}
	if id, ok := index.lookup(importing.SOURCE_TYPE_ALIPAY, "餐饮美食"); !ok || id != 51 {
		t.Fatalf("Alipay category should resolve to the available conservative leaf: id=%d ok=%v", id, ok)
	}
}

func TestClearEvidenceKeywordsUseConservativeCategoriesAndTransfersStaySeparate(t *testing.T) {
	for _, test := range []struct {
		source   importing.SourceType
		row      *importing.RawImportRow
		expected string
	}{
		{source: importing.SOURCE_TYPE_WECHAT, row: &importing.RawImportRow{RawCounterparty: "美团平台商户"}, expected: "食品"},
		{source: importing.SOURCE_TYPE_WECHAT, row: &importing.RawImportRow{RawItem: "国内寄件"}, expected: "快递费"},
		{source: importing.SOURCE_TYPE_WECHAT, row: &importing.RawImportRow{RawCounterparty: "代收保费"}, expected: "保险支出"},
		{source: importing.SOURCE_TYPE_BANK, row: &importing.RawImportRow{RawCounterparty: "人民币购汇（电话）"}, expected: "电话费"},
	} {
		if got := evidenceCategoryLeafFallback(test.source, test.row); got != test.expected {
			t.Fatalf("evidence category fallback: got %q want %q", got, test.expected)
		}
	}
	if got := evidenceSemanticTodo(importing.SOURCE_TYPE_BANK, &importing.RawImportRow{RawCounterparty: "款项转入"}); got != TODO_KIND_REPAYMENT_UNCLEAR {
		t.Fatalf("credit-card payment should remain a repayment relation, got %q", got)
	}
}

func TestExplicitTransferDirectionIsPostableWithoutRelationshipGuess(t *testing.T) {
	service := new(Service)
	amount, unixTime, accountId := int64(1500), int64(1_700_000_000), int64(12)
	row := &importing.RawImportRow{
		LedgerAccountId: &accountId, ParseState: importing.PARSE_STATE_VALID,
		IdentityState: importing.IDENTITY_STATE_NEW, SemanticEligibility: importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		Disposition: importing.IMPORT_DISPOSITION_POSTABLE, EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL,
		NormalizedUnixTime: &unixTime, NormalizedAmount: &amount, Currency: "CNY",
		NormalizedDirection:       importing.NORMALIZED_DIRECTION_INCOME,
		NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_TRANSFER,
	}
	kind, postable := service.classifyRow(row, importing.SOURCE_TYPE_ALIPAY, false, &categoryIndex{})
	if kind != TODO_KIND_UNCATEGORIZED || !postable {
		t.Fatalf("explicit incoming transfer should be a postable uncategorized income: kind=%q postable=%t", kind, postable)
	}
	row.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_TOP_UP
	if kind, postable = service.classifyRow(row, importing.SOURCE_TYPE_ALIPAY, false, &categoryIndex{}); kind != TODO_KIND_TRANSFER_UNCLEAR || postable {
		t.Fatalf("top-up still needs an account relation: kind=%q postable=%t", kind, postable)
	}
}
