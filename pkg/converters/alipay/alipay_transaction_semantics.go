package alipay

import (
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type alipayProductAction uint8

const (
	alipayProductActionUnknown alipayProductAction = iota
	alipayProductActionEarning
	alipayProductActionPurchaseInvestment
	alipayProductActionPurchaseInvestmentRefund
	alipayProductActionSellInvestment
	alipayProductActionTransferToWallet
	alipayProductActionTransferFromWallet
	alipayProductActionTransferIn
	alipayProductActionTransferOut
	alipayProductActionTransfer
	alipayProductActionRepayment
)

// classifyAlipayProductAction 统一单文件导入与账单整理证据解析使用的支付宝具体产品动作。
// “收益发放”等具体动作必须优先于“投资理财”等宽泛交易分类。
func classifyAlipayProductAction(productName string) alipayProductAction {
	productName = normalizeAlipayText(productName)

	switch {
	case strings.HasSuffix(productName, alipayTransactionDataProductNameEarningText):
		return alipayProductActionEarning
	case strings.HasSuffix(productName, alipayTransactionDataProductNamePurchaseInvestmentRefundText):
		return alipayProductActionPurchaseInvestmentRefund
	case strings.HasSuffix(productName, alipayTransactionDataProductNamePurchaseInvestmentText):
		return alipayProductActionPurchaseInvestment
	case strings.Contains(productName, alipayTransactionDataProductNameSellInvestmentRefundText):
		return alipayProductActionSellInvestment
	case strings.HasPrefix(productName, alipayTransactionDataProductNameTransferToAlipayPrefix):
		return alipayProductActionTransferToWallet
	case strings.HasPrefix(productName, alipayTransactionDataProductNameTransferFromAlipayPrefix):
		return alipayProductActionTransferFromWallet
	case strings.Contains(productName, alipayTransactionDataProductNameTransferInText):
		return alipayProductActionTransferIn
	case strings.Contains(productName, alipayTransactionDataProductNameTransferOutText):
		return alipayProductActionTransferOut
	case strings.Contains(productName, alipayTransactionDataProductNameTransferText):
		return alipayProductActionTransfer
	case strings.Contains(productName, alipayTransactionDataProductNameRepaymentText):
		return alipayProductActionRepayment
	default:
		return alipayProductActionUnknown
	}
}

// ProjectSourceFunds 复用支付宝产品动作分类，给单文件导入和账单整理提供同一套账户方向。
func ProjectSourceFunds(productName string, paymentMethod string, counterparty string, refund bool) (importing.SourceFundsProjection, bool) {
	statement := importing.SourceFundsAccountReference{Kind: importing.SOURCE_FUNDS_ACCOUNT_STATEMENT}
	payment := importing.SourceFundsAccountReference{Kind: importing.SOURCE_FUNDS_ACCOUNT_PAYMENT, Raw: paymentMethod}
	target := importing.SourceFundsAccountReference{Kind: importing.SOURCE_FUNDS_ACCOUNT_PAYMENT, Raw: counterparty}
	projection := importing.SourceFundsProjection{
		Kind:        importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER,
		RuleVersion: importing.SOURCE_FUNDS_RULE_VERSION_V1,
	}

	action := classifyAlipayProductAction(productName)
	if refund {
		switch action {
		case alipayProductActionPurchaseInvestment:
			projection.From, projection.To = payment, target
		case alipayProductActionPurchaseInvestmentRefund:
			projection.From, projection.To = target, payment
		default:
			return importing.SourceFundsProjection{}, false
		}
		return projection, true
	}

	switch action {
	case alipayProductActionPurchaseInvestment:
		projection.From, projection.To = payment, target
	case alipayProductActionSellInvestment:
		projection.From, projection.To = target, payment
	case alipayProductActionTransferToWallet:
		projection.From, projection.To = payment, statement
	case alipayProductActionTransferFromWallet:
		projection.From, projection.To = statement, target
	case alipayProductActionTransferIn, alipayProductActionTransferOut, alipayProductActionTransfer:
		projection.From, projection.To = payment, target
	case alipayProductActionRepayment:
		projection.Kind = importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT
		projection.From, projection.To = payment, target
	default:
		return importing.SourceFundsProjection{}, false
	}
	return projection, true
}
