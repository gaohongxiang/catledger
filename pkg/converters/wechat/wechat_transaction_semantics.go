package wechat

import (
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type wechatTransactionAction uint8

const (
	wechatTransactionActionUnknown wechatTransactionAction = iota
	wechatTransactionActionFee
	wechatTransactionActionTopUp
	wechatTransactionActionWithdrawal
	wechatTransactionActionRepayment
	wechatTransactionActionTransfer
	wechatTransactionActionRedPacket
	wechatTransactionActionGroupCollection
	wechatTransactionActionPayment
	wechatTransactionActionInvestment
)

// classifyWechatTransactionAction 统一单文件导入与账单整理证据解析使用的微信具体动作。
// 顺序很重要：手续费、充值、提现和还款必须先于“支付、收款”等宽泛文本。
func classifyWechatTransactionAction(transactionType string) wechatTransactionAction {
	transactionType = normalizeWechatSemanticText(transactionType)

	switch {
	case transactionType == "":
		return wechatTransactionActionUnknown
	case strings.Contains(transactionType, "手续费") || strings.Contains(transactionType, "服务费"):
		return wechatTransactionActionFee
	case strings.Contains(transactionType, "零钱充值") || strings.Contains(transactionType, "余额充值"):
		return wechatTransactionActionTopUp
	case strings.Contains(transactionType, "零钱提现") || strings.Contains(transactionType, "余额提现"):
		return wechatTransactionActionWithdrawal
	case strings.Contains(transactionType, "信用卡还款"):
		return wechatTransactionActionRepayment
	case strings.Contains(transactionType, "转账"):
		return wechatTransactionActionTransfer
	case strings.Contains(transactionType, "红包"):
		return wechatTransactionActionRedPacket
	case strings.Contains(transactionType, "群收款"):
		return wechatTransactionActionGroupCollection
	case strings.Contains(transactionType, "消费") || strings.Contains(transactionType, "付款") || strings.Contains(transactionType, "收款") || strings.Contains(transactionType, "支付") || strings.Contains(transactionType, "退款"):
		return wechatTransactionActionPayment
	case strings.Contains(transactionType, "零钱通") || strings.Contains(transactionType, "理财通"):
		return wechatTransactionActionInvestment
	default:
		return wechatTransactionActionUnknown
	}
}

func (action wechatTransactionAction) sourceTransactionType() importing.SourceTransactionType {
	switch action {
	case wechatTransactionActionFee:
		return importing.SOURCE_TRANSACTION_TYPE_FEE
	case wechatTransactionActionTopUp:
		return importing.SOURCE_TRANSACTION_TYPE_TOP_UP
	case wechatTransactionActionWithdrawal:
		return importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL
	case wechatTransactionActionRepayment, wechatTransactionActionTransfer, wechatTransactionActionRedPacket, wechatTransactionActionGroupCollection:
		return importing.SOURCE_TRANSACTION_TYPE_TRANSFER
	case wechatTransactionActionPayment:
		return importing.SOURCE_TRANSACTION_TYPE_PAYMENT
	case wechatTransactionActionInvestment:
		return importing.SOURCE_TRANSACTION_TYPE_OTHER
	default:
		return importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
	}
}

func classifyWechatEconomicEffect(transactionType string, status string) importing.EconomicEffect {
	transactionType = normalizeWechatSemanticText(transactionType)
	status = normalizeWechatSemanticText(status)

	switch {
	case strings.Contains(status, "失败") || strings.Contains(status, "未支付") || strings.Contains(status, "未收款"):
		return importing.ECONOMIC_EFFECT_FAILED
	case strings.Contains(status, "关闭") || strings.Contains(status, "撤销") || strings.Contains(status, "取消"):
		return importing.ECONOMIC_EFFECT_CLOSED
	case strings.Contains(status, "退款成功") || strings.Contains(status, "退款完成") || strings.Contains(status, "已退款") || strings.Contains(status, "已退还") || strings.Contains(status, "已全额退款") || strings.Contains(status, "已部分退款"):
		return importing.ECONOMIC_EFFECT_REFUND
	case strings.Contains(transactionType, "退款") && (strings.Contains(status, "成功") || strings.Contains(status, "完成") || strings.Contains(status, "到账")):
		return importing.ECONOMIC_EFFECT_REFUND
	case strings.Contains(status, "成功") || strings.Contains(status, "完成") || strings.Contains(status, "已收钱") || strings.Contains(status, "已到账") || strings.Contains(status, "已支付") || strings.Contains(status, "已存入") || strings.Contains(status, "已转账") || strings.Contains(status, "已领取"):
		return importing.ECONOMIC_EFFECT_NORMAL
	default:
		return importing.ECONOMIC_EFFECT_UNKNOWN
	}
}

func normalizeWechatSemanticText(value string) string {
	return strings.TrimSpace(norm.NFKC.String(value))
}
