package wechat

import (
	"strings"

	"github.com/gaohongxiang/catledger/pkg/converters/datatable"
	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/locales"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/utils"
)

const wechatPayTransactionDataCsvFileHeader = "微信支付账单明细"
const wechatPayTransactionDataHeaderStartContentBeginning = "----------------------微信支付账单明细列表--------------------"

const wechatPayTransactionTimeColumnName = "交易时间"
const wechatPayTransactionCategoryColumnName = "交易类型"
const wechatPayTransactionCounterpartyColumnName = "交易对方"
const wechatPayTransactionProductNameColumnName = "商品"
const wechatPayTransactionTypeColumnName = "收/支"
const wechatPayTransactionAmountColumnName = "金额(元)"
const wechatPayTransactionRelatedAccountColumnName = "支付方式"
const wechatPayTransactionStatusColumnName = "当前状态"
const wechatPayTransactionDescriptionColumnName = "备注"

var wechatPayTransactionSupportedColumns = map[datatable.TransactionDataTableColumn]bool{
	datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TIME:     true,
	datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TYPE:     true,
	datatable.TRANSACTION_DATA_TABLE_SUB_CATEGORY:         true,
	datatable.TRANSACTION_DATA_TABLE_ACCOUNT_NAME:         true,
	datatable.TRANSACTION_DATA_TABLE_AMOUNT:               true,
	datatable.TRANSACTION_DATA_TABLE_RELATED_ACCOUNT_NAME: true,
	datatable.TRANSACTION_DATA_TABLE_DESCRIPTION:          true,
}

var wechatPayTransactionTypeNameMapping = map[models.TransactionType]string{
	models.TRANSACTION_TYPE_INCOME:   "收入",
	models.TRANSACTION_TYPE_EXPENSE:  "支出",
	models.TRANSACTION_TYPE_TRANSFER: "/",
}

// weChatPayTransactionDataRowParser defines the structure of wechat pay transaction data row parser
type weChatPayTransactionDataRowParser struct {
	existedOriginalDataColumns map[string]bool
}

// Parse returns the converted transaction data row
func (p *weChatPayTransactionDataRowParser) Parse(ctx core.Context, user *models.User, dataRow datatable.CommonDataTableRow, rowId string) (rowData map[datatable.TransactionDataTableColumn]string, rowDataValid bool, err error) {
	if dataRow.GetData(wechatPayTransactionTypeColumnName) != wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_INCOME] &&
		dataRow.GetData(wechatPayTransactionTypeColumnName) != wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_EXPENSE] &&
		dataRow.GetData(wechatPayTransactionTypeColumnName) != wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_TRANSFER] {
		log.Warnf(ctx, "[wechat_pay_transaction_data_row_parser.Parse] skip parsing transaction in row \"%s\", because type is \"%s\"", rowId, dataRow.GetData(wechatPayTransactionTypeColumnName))
		return nil, false, nil
	}

	data := make(map[datatable.TransactionDataTableColumn]string, len(wechatPayTransactionSupportedColumns))

	if p.hasOriginalColumn(wechatPayTransactionTimeColumnName) {
		data[datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TIME] = dataRow.GetData(wechatPayTransactionTimeColumnName)
	}

	if p.hasOriginalColumn(wechatPayTransactionCategoryColumnName) {
		data[datatable.TRANSACTION_DATA_TABLE_SUB_CATEGORY] = dataRow.GetData(wechatPayTransactionCategoryColumnName)
	}

	if p.hasOriginalColumn(wechatPayTransactionAmountColumnName) {
		amount, success := utils.ParseFirstConsecutiveNumber(strings.ReplaceAll(dataRow.GetData(wechatPayTransactionAmountColumnName), ",", ""))

		if !success {
			log.Errorf(ctx, "[wechat_pay_transaction_data_row_parser.Parse] cannot parse amount \"%s\" of transaction in row \"%s\"", dataRow.GetData(wechatPayTransactionAmountColumnName), rowId)
			return nil, false, errs.ErrAmountInvalid
		}

		data[datatable.TRANSACTION_DATA_TABLE_AMOUNT] = amount
	}

	if p.hasOriginalColumn(wechatPayTransactionDescriptionColumnName) && dataRow.GetData(wechatPayTransactionDescriptionColumnName) != "" && dataRow.GetData(wechatPayTransactionDescriptionColumnName) != "/" {
		data[datatable.TRANSACTION_DATA_TABLE_DESCRIPTION] = dataRow.GetData(wechatPayTransactionDescriptionColumnName)
	} else if p.hasOriginalColumn(wechatPayTransactionProductNameColumnName) && dataRow.GetData(wechatPayTransactionProductNameColumnName) != "" && dataRow.GetData(wechatPayTransactionProductNameColumnName) != "/" {
		data[datatable.TRANSACTION_DATA_TABLE_DESCRIPTION] = dataRow.GetData(wechatPayTransactionProductNameColumnName)
	} else {
		data[datatable.TRANSACTION_DATA_TABLE_DESCRIPTION] = ""
	}

	relatedAccountName := ""

	if p.hasOriginalColumn(wechatPayTransactionRelatedAccountColumnName) {
		relatedAccountName = dataRow.GetData(wechatPayTransactionRelatedAccountColumnName)
	}

	statusName := ""

	if p.hasOriginalColumn(wechatPayTransactionStatusColumnName) {
		statusName = dataRow.GetData(wechatPayTransactionStatusColumnName)
	}

	economicEffect := classifyWechatEconomicEffect(dataRow.GetData(wechatPayTransactionCategoryColumnName), statusName)

	if economicEffect == importing.ECONOMIC_EFFECT_FAILED || economicEffect == importing.ECONOMIC_EFFECT_CLOSED {
		log.Warnf(ctx, "[wechat_pay_transaction_data_row_parser.Parse] skip parsing transaction in row \"%s\", because status has no economic effect", rowId)
		return nil, false, nil
	}

	locale := user.Language

	if locale == "" {
		locale = ctx.GetClientLocale()
	}

	localeTextItems := locales.GetLocaleTextItems(locale)

	if p.hasOriginalColumn(wechatPayTransactionTypeColumnName) {
		data[datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TYPE] = dataRow.GetData(wechatPayTransactionTypeColumnName)

		if dataRow.GetData(wechatPayTransactionTypeColumnName) == wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_INCOME] {
			if relatedAccountName == "" || relatedAccountName == "/" {
				data[datatable.TRANSACTION_DATA_TABLE_ACCOUNT_NAME] = localeTextItems.DataConverterTextItems.WeChatWallet
				data[datatable.TRANSACTION_DATA_TABLE_RELATED_ACCOUNT_NAME] = ""
			} else {
				data[datatable.TRANSACTION_DATA_TABLE_ACCOUNT_NAME] = relatedAccountName
			}
		} else if dataRow.GetData(wechatPayTransactionTypeColumnName) == wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_TRANSFER] {
			projection, projected := ProjectSourceFunds(
				data[datatable.TRANSACTION_DATA_TABLE_SUB_CATEGORY],
				relatedAccountName,
				dataRow.GetData(wechatPayTransactionCounterpartyColumnName),
			)
			if !projected {
				log.Warnf(ctx, "[wechat_pay_transaction_data_row_parser.Parse] skip parsing transaction in row \"%s\", because unknown transfer transaction category \"%s\"", rowId, data[datatable.TRANSACTION_DATA_TABLE_SUB_CATEGORY])
				return nil, false, nil
			}
			data[datatable.TRANSACTION_DATA_TABLE_ACCOUNT_NAME] = renderWechatFundsReference(projection.From, localeTextItems.DataConverterTextItems.WeChatWallet)
			data[datatable.TRANSACTION_DATA_TABLE_RELATED_ACCOUNT_NAME] = renderWechatFundsReference(projection.To, localeTextItems.DataConverterTextItems.WeChatWallet)
		} else {
			data[datatable.TRANSACTION_DATA_TABLE_ACCOUNT_NAME] = relatedAccountName
			data[datatable.TRANSACTION_DATA_TABLE_RELATED_ACCOUNT_NAME] = ""
		}
	}

	if data[datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TYPE] == wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_INCOME] && economicEffect == importing.ECONOMIC_EFFECT_REFUND {
		amount, err := utils.ParseAmount(data[datatable.TRANSACTION_DATA_TABLE_AMOUNT])

		if err == nil {
			data[datatable.TRANSACTION_DATA_TABLE_TRANSACTION_TYPE] = wechatPayTransactionTypeNameMapping[models.TRANSACTION_TYPE_EXPENSE]
			data[datatable.TRANSACTION_DATA_TABLE_AMOUNT] = utils.FormatAmount(-amount)
		}
	}

	return data, true, nil
}

func renderWechatFundsReference(reference importing.SourceFundsAccountReference, walletName string) string {
	if reference.Kind == importing.SOURCE_FUNDS_ACCOUNT_STATEMENT {
		return walletName
	}
	return reference.Raw
}

func (p *weChatPayTransactionDataRowParser) hasOriginalColumn(columnName string) bool {
	_, exists := p.existedOriginalDataColumns[columnName]
	return exists
}

// createWeChatPayTransactionDataRowParser returns wechat pay transaction data row parser
func createWeChatPayTransactionDataRowParser(headerColumnNames []string) datatable.CommonTransactionDataRowParser {
	existedOriginalDataColumns := make(map[string]bool, len(headerColumnNames))

	for i := 0; i < len(headerColumnNames); i++ {
		existedOriginalDataColumns[headerColumnNames[i]] = true
	}

	return &weChatPayTransactionDataRowParser{
		existedOriginalDataColumns: existedOriginalDataColumns,
	}
}
