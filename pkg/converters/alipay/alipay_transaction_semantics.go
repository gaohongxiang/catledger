package alipay

import "strings"

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
