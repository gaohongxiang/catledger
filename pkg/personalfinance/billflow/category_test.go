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
