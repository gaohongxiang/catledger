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
