package converters

import (
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func TestSourceFundsProjectorDoesNotTurnAlipayIncomeIntoInternalTransfer(t *testing.T) {
	row := &importing.RawImportRow{
		RawItem:                   "转账",
		RawPaymentMethod:          "账户余额",
		NormalizedDirection:       importing.NORMALIZED_DIRECTION_INCOME,
		NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
		EconomicEffect:            importing.ECONOMIC_EFFECT_NORMAL,
	}

	if projection, ok := NewSourceFundsProjector().ProjectSourceFunds(importing.SOURCE_TYPE_ALIPAY, row); ok {
		t.Fatalf("支付宝对人转入不应产生本人双边资金投影: %+v", projection)
	}
}
