package wechat

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestClassifyWechatTransactionAction(t *testing.T) {
	tests := []struct {
		name              string
		transactionType   string
		action            wechatTransactionAction
		sourceTransaction importing.SourceTransactionType
	}{
		{"payment", "商户消费", wechatTransactionActionPayment, importing.SOURCE_TRANSACTION_TYPE_PAYMENT},
		{"fee before withdrawal", "零钱提现手续费", wechatTransactionActionFee, importing.SOURCE_TRANSACTION_TYPE_FEE},
		{"top up", " 零钱充值 ", wechatTransactionActionTopUp, importing.SOURCE_TRANSACTION_TYPE_TOP_UP},
		{"top up alias", "余额充值", wechatTransactionActionTopUp, importing.SOURCE_TRANSACTION_TYPE_TOP_UP},
		{"withdrawal", "零钱提现", wechatTransactionActionWithdrawal, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL},
		{"repayment", "信用卡还款", wechatTransactionActionRepayment, importing.SOURCE_TRANSACTION_TYPE_TRANSFER},
		{"transfer", "转账", wechatTransactionActionTransfer, importing.SOURCE_TRANSACTION_TYPE_TRANSFER},
		{"red packet", "微信红包", wechatTransactionActionRedPacket, importing.SOURCE_TRANSACTION_TYPE_TRANSFER},
		{"group collection", "群收款", wechatTransactionActionGroupCollection, importing.SOURCE_TRANSACTION_TYPE_TRANSFER},
		{"investment", "零钱通收益", wechatTransactionActionInvestment, importing.SOURCE_TRANSACTION_TYPE_OTHER},
		{"unknown", "合成未知", wechatTransactionActionUnknown, importing.SOURCE_TRANSACTION_TYPE_UNKNOWN},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			action := classifyWechatTransactionAction(test.transactionType)
			assert.Equal(t, test.action, action)
			assert.Equal(t, test.sourceTransaction, action.sourceTransactionType())
		})
	}
}

func TestClassifyWechatEconomicEffect(t *testing.T) {
	tests := []struct {
		name            string
		transactionType string
		status          string
		effect          importing.EconomicEffect
	}{
		{"normal", "商户消费", "支付成功", importing.ECONOMIC_EFFECT_NORMAL},
		{"refund", "商户消费-退款", "已全额退款", importing.ECONOMIC_EFFECT_REFUND},
		{"refund by action", "商户消费-退款", "已到账", importing.ECONOMIC_EFFECT_REFUND},
		{"failed before refund", "商户消费-退款", "退款失败", importing.ECONOMIC_EFFECT_FAILED},
		{"closed", "商户消费", "交易已关闭", importing.ECONOMIC_EFFECT_CLOSED},
		{"unknown", "商户消费", "处理中", importing.ECONOMIC_EFFECT_UNKNOWN},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.effect, classifyWechatEconomicEffect(test.transactionType, test.status))
		})
	}
}

func TestProjectSourceFundsUsesStatementAccountForWechatWallet(t *testing.T) {
	withdrawal, ok := ProjectSourceFunds("零钱提现", "浙江农商联合银行储蓄卡(5564)")
	if !ok || withdrawal.Kind != importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER ||
		withdrawal.From.Kind != importing.SOURCE_FUNDS_ACCOUNT_STATEMENT ||
		withdrawal.To.Kind != importing.SOURCE_FUNDS_ACCOUNT_PAYMENT ||
		withdrawal.To.Raw != "浙江农商联合银行储蓄卡(5564)" {
		t.Fatalf("微信零钱提现资金方向错误: %+v ok=%v", withdrawal, ok)
	}
	topUp, ok := ProjectSourceFunds("零钱充值", "合成银行卡(0000)")
	if !ok || topUp.From.Kind != importing.SOURCE_FUNDS_ACCOUNT_PAYMENT || topUp.To.Kind != importing.SOURCE_FUNDS_ACCOUNT_STATEMENT {
		t.Fatalf("微信零钱充值资金方向错误: %+v ok=%v", topUp, ok)
	}
	if _, ok = ProjectSourceFunds("转账", "合成银行卡(0000)"); ok {
		t.Fatal("普通微信转账的另一方不明确，不应产生双边投影")
	}
}
