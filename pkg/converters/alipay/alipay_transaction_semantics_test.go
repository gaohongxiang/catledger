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
		{name: "activity reward", productName: "平台活动奖励", expected: alipayProductActionEarning},
		{name: "cash reward", productName: "任务现金奖励", expected: alipayProductActionEarning},
		{name: "reward money", productName: "会员奖励金", expected: alipayProductActionEarning},
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

func TestNormalizeAlipayTransactionSemanticsPrefersRewardOverTransferCategory(t *testing.T) {
	direction, transactionType := normalizeAlipayTransactionSemantics(
		"转账红包",
		"平台活动奖励",
		importing.NORMALIZED_DIRECTION_INCOME,
	)

	if direction != importing.NORMALIZED_DIRECTION_INCOME || transactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER {
		t.Fatalf("明确活动奖励不应被宽泛转账分类覆盖: direction=%s type=%s", direction, transactionType)
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

func TestNormalizeAlipayTransactionSemanticsKeepsPersonTransferDirection(t *testing.T) {
	tests := []struct {
		name      string
		direction importing.NormalizedDirection
		expected  importing.SourceTransactionType
	}{
		{name: "incoming", direction: importing.NORMALIZED_DIRECTION_INCOME, expected: importing.SOURCE_TRANSACTION_TYPE_PAYMENT},
		{name: "outgoing", direction: importing.NORMALIZED_DIRECTION_EXPENSE, expected: importing.SOURCE_TRANSACTION_TYPE_PAYMENT},
		{name: "neutral", direction: importing.NORMALIZED_DIRECTION_NEUTRAL, expected: importing.SOURCE_TRANSACTION_TYPE_TRANSFER},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			direction, transactionType := normalizeAlipayTransactionSemantics("转账红包", "转账", test.direction)
			if direction != test.direction || transactionType != test.expected {
				t.Fatalf("普通对人转账语义错误: direction=%s type=%s", direction, transactionType)
			}
		})
	}
}

func TestProjectSourceFundsReusesAlipayProductDirections(t *testing.T) {
	withdrawal, ok := ProjectSourceFunds("提现-实时提现", "余额", "合成银行卡(0000)", false)
	if !ok || withdrawal.Kind != importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER ||
		withdrawal.From.Kind != importing.SOURCE_FUNDS_ACCOUNT_STATEMENT ||
		withdrawal.From.Raw != "余额" ||
		withdrawal.To.Kind != importing.SOURCE_FUNDS_ACCOUNT_PAYMENT || withdrawal.To.Raw != "合成银行卡(0000)" {
		t.Fatalf("支付宝提现资金方向错误: %+v ok=%v", withdrawal, ok)
	}
	purchase, ok := ProjectSourceFunds("基金产品-买入", "余额", "基金账户", false)
	if !ok || purchase.From.Raw != "余额" || purchase.To.Raw != "基金账户" {
		t.Fatalf("支付宝投资买入资金方向错误: %+v ok=%v", purchase, ok)
	}
	topUp, ok := ProjectSourceFunds("充值-普通充值", "合成银行卡(0000)", "", false)
	if !ok || topUp.From.Raw != "合成银行卡(0000)" ||
		topUp.To.Kind != importing.SOURCE_FUNDS_ACCOUNT_STATEMENT || topUp.To.Raw != "余额" {
		t.Fatalf("支付宝充值资金方向错误: %+v ok=%v", topUp, ok)
	}
	repayment, ok := ProjectSourceFunds("自动还款-花呗账单", "余额", "花呗", false)
	if !ok || repayment.Kind != importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT ||
		repayment.From.Kind != importing.SOURCE_FUNDS_ACCOUNT_PAYMENT || repayment.From.Raw != "余额" ||
		repayment.To.Kind != importing.SOURCE_FUNDS_ACCOUNT_REPAYMENT_TARGET || repayment.To.Raw != "花呗" {
		t.Fatalf("支付宝还款资金方向错误: %+v ok=%v", repayment, ok)
	}
	yuEBaoOut, ok := ProjectSourceFunds("余额宝-转出到余额", "账户余额", "合成账户", false)
	if !ok || yuEBaoOut.From.Raw != "余额宝" || yuEBaoOut.To.Raw != "账户余额" {
		t.Fatalf("余额宝转出到余额资金方向错误: %+v ok=%v", yuEBaoOut, ok)
	}
	yuEBaoIn, ok := ProjectSourceFunds("余额宝-单次转入", "账户余额", "合成账户", false)
	if !ok || yuEBaoIn.From.Raw != "账户余额" || yuEBaoIn.To.Raw != "余额宝" {
		t.Fatalf("余额转入余额宝资金方向错误: %+v ok=%v", yuEBaoIn, ok)
	}
	if _, ok = ProjectSourceFunds("普通商品", "余额", "普通商户", false); ok {
		t.Fatal("普通支付宝消费不应产生双边资金投影")
	}
}
