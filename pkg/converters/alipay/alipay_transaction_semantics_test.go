package alipay

import (
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestClassifyAlipayProductAction(t *testing.T) {
	tests := []struct {
		name        string
		productName string
		expected    alipayProductAction
	}{
		{name: "earning", productName: "余额宝-2026.07.02-收益发放", expected: alipayProductActionEarning},
		{name: "purchase refund precedes purchase", productName: "基金产品-买入退款", expected: alipayProductActionPurchaseInvestmentRefund},
		{name: "purchase", productName: "基金产品-买入", expected: alipayProductActionPurchaseInvestment},
		{name: "sell", productName: "基金产品-卖出至余额宝", expected: alipayProductActionSellInvestment},
		{name: "top up", productName: "充值-普通充值", expected: alipayProductActionTransferToWallet},
		{name: "withdrawal", productName: "提现-实时提现", expected: alipayProductActionTransferFromWallet},
		{name: "transfer in precedes transfer", productName: "余额宝-单次转入", expected: alipayProductActionTransferIn},
		{name: "transfer out precedes transfer", productName: "余额宝-转出到银行卡", expected: alipayProductActionTransferOut},
		{name: "transfer", productName: "转账给朋友", expected: alipayProductActionTransfer},
		{name: "repayment", productName: "信用卡还款", expected: alipayProductActionRepayment},
		{name: "unknown", productName: "普通商品", expected: alipayProductActionUnknown},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if actual := classifyAlipayProductAction(test.productName); actual != test.expected {
				t.Fatalf("支付宝产品动作识别错误: got=%d want=%d", actual, test.expected)
			}
		})
	}
}

func TestNormalizeAlipayTransactionSemanticsPrefersConcreteProductAction(t *testing.T) {
	direction, transactionType := normalizeAlipayTransactionSemantics(
		"投资理财",
		"余额宝-2026.07.02-收益发放",
		importing.NORMALIZED_DIRECTION_NEUTRAL,
	)

	if direction != importing.NORMALIZED_DIRECTION_INCOME || transactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER {
		t.Fatalf("收益发放不应被宽泛投资理财覆盖: direction=%s type=%s", direction, transactionType)
	}
}

func TestNormalizeAlipayTransactionSemanticsKeepsInvestmentMovementAsTransfer(t *testing.T) {
	direction, transactionType := normalizeAlipayTransactionSemantics(
		"投资理财",
		"基金产品-买入",
		importing.NORMALIZED_DIRECTION_NEUTRAL,
	)

	if direction != importing.NORMALIZED_DIRECTION_NEUTRAL || transactionType != importing.SOURCE_TRANSACTION_TYPE_TRANSFER {
		t.Fatalf("投资买入应继续作为账户关系核对: direction=%s type=%s", direction, transactionType)
	}
}
