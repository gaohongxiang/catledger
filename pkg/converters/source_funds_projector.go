package converters

import (
	"github.com/gaohongxiang/catledger/pkg/converters/alipay"
	"github.com/gaohongxiang/catledger/pkg/converters/wechat"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

// NewSourceFundsProjector 返回来源资金语义的统一注册入口。
// 来源细节仍由各转换器维护，调用方不复制第三方账单关键词或账户方向规则。
func NewSourceFundsProjector() importing.SourceFundsProjector {
	return sourceFundsProjector{}
}

type sourceFundsProjector struct{}

func (sourceFundsProjector) ProjectSourceFunds(sourceType importing.SourceType, row *importing.RawImportRow) (importing.SourceFundsProjection, bool) {
	if row == nil {
		return importing.SourceFundsProjection{}, false
	}
	switch sourceType {
	case importing.SOURCE_TYPE_WECHAT:
		return wechat.ProjectSourceFunds(row.RawTransactionType, row.RawPaymentMethod, row.RawCounterparty)
	case importing.SOURCE_TYPE_ALIPAY:
		// 明确收入或支出的普通对人转账已经由支付宝标准化器定为经济收支，
		// 不得再被商品说明里的宽泛“转账”投影成本人双边账户移动。
		if row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_PAYMENT {
			return importing.SourceFundsProjection{}, false
		}
		return alipay.ProjectSourceFunds(
			row.RawItem,
			row.RawPaymentMethod,
			row.RawCounterparty,
			row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND,
		)
	default:
		return importing.SourceFundsProjection{}, false
	}
}
