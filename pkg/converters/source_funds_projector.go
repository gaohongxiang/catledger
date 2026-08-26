package converters

import (
	"github.com/mayswind/ezbookkeeping/pkg/converters/alipay"
	"github.com/mayswind/ezbookkeeping/pkg/converters/wechat"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
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
		return wechat.ProjectSourceFunds(row.RawTransactionType, row.RawPaymentMethod)
	case importing.SOURCE_TYPE_ALIPAY:
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
