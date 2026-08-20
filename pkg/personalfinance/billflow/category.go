package billflow

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

var forbiddenCategoryNames = map[string]struct{}{
	"商户消费": {}, "扫二维码付款": {}, "充值": {}, "提现": {}, "转账": {}, "红包": {},
	"微信红包": {}, "转账退款": {}, "零钱提现": {}, "零钱充值": {}, "信用卡还款": {},
	"不计收支": {}, "二维码收款": {},
}

var alipayCategoryLeafFallbacks = map[string]string{
	"餐饮美食": "食品",
	"交通出行": "公共交通",
	"医疗健康": "检查治疗",
}

func canonicalCategoryName(value string) string {
	normalized := strings.TrimSpace(norm.NFKC.String(value))
	var builder strings.Builder
	for _, char := range normalized {
		if unicode.IsSpace(char) || char == '-' || char == '—' {
			continue
		}
		builder.WriteRune(unicode.ToLower(char))
	}
	return builder.String()
}

func isForbiddenCategoryName(value string) bool {
	_, forbidden := forbiddenCategoryNames[canonicalCategoryName(value)]
	if forbidden {
		return true
	}
	_, forbidden = forbiddenCategoryNames[strings.TrimSpace(norm.NFKC.String(value))]
	return forbidden
}

func categoryAliasKey(value string) string {
	canonical := strings.TrimSpace(norm.NFKC.String(value))
	digest := sha256.Sum256([]byte(string(CATEGORY_ALIAS_VERSION_V1) + "\x00" + canonical))
	return hex.EncodeToString(digest[:])
}

func categoryAliasCandidates(row *importing.RawImportRow, sourceType importing.SourceType) []string {
	if row == nil {
		return nil
	}
	seen := map[string]struct{}{}
	names := make([]string, 0, 3)
	for _, name := range []string{sourceCategoryName(row, sourceType), strings.TrimSpace(row.RawCounterparty), strings.TrimSpace(row.RawItem)} {
		if name == "" || isForbiddenCategoryName(name) {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

func maskedCategoryAliasDisplay(value string) string {
	trimmed := strings.TrimSpace(value)
	runes := []rune(trimmed)
	if len(runes) > 128 {
		return string(runes[:128])
	}
	return trimmed
}

func todoPreviewLabel(row *importing.RawImportRow) string {
	if row == nil {
		return ""
	}
	if label := maskedCategoryAliasDisplay(row.RawCounterparty); label != "" {
		return label
	}
	return maskedCategoryAliasDisplay(row.RawItem)
}

func todoPreviewItem(row *importing.RawImportRow) string {
	if row == nil {
		return ""
	}
	item := maskedCategoryAliasDisplay(row.RawItem)
	if item == "" || item == todoPreviewLabel(row) {
		return ""
	}
	orderId := strings.TrimSpace(row.SourceMerchantOrderId)
	if orderId == "" {
		orderId = strings.TrimSpace(row.SourceOrderId)
	}
	if orderId != "" && itemLooksLikeOrderId(item, orderId) {
		return ""
	}
	return item
}

func itemLooksLikeOrderId(item, orderId string) bool {
	compactItem := compactPreviewText(item)
	compactOrder := compactPreviewText(orderId)
	if compactItem == "" || compactOrder == "" {
		return false
	}
	if compactItem == compactOrder {
		return true
	}
	for _, prefix := range []string{"商户单号", "商家订单号", "订单号"} {
		if strings.HasPrefix(item, prefix) && compactPreviewText(strings.TrimPrefix(item, prefix)) == compactOrder {
			return true
		}
	}
	return false
}

func compactPreviewText(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

func sourceCategoryName(row *importing.RawImportRow, sourceType importing.SourceType) string {
	if row == nil {
		return ""
	}
	if sourceType == importing.SOURCE_TYPE_WECHAT {
		return strings.TrimSpace(row.RawTransactionType)
	}
	if sourceType == importing.SOURCE_TYPE_ALIPAY {
		return strings.TrimSpace(row.RawTransactionType)
	}
	return ""
}

func sourceCategoryLeafFallback(sourceType importing.SourceType, name string) string {
	if sourceType != importing.SOURCE_TYPE_ALIPAY {
		return ""
	}
	return alipayCategoryLeafFallbacks[canonicalCategoryName(name)]
}

func evidenceCategoryLeafFallback(sourceType importing.SourceType, row *importing.RawImportRow) string {
	if row == nil {
		return ""
	}
	text := canonicalCategoryName(strings.TrimSpace(row.RawCounterparty) + " " + strings.TrimSpace(row.RawItem))
	switch sourceType {
	case importing.SOURCE_TYPE_WECHAT:
		switch {
		case strings.Contains(text, "美团"):
			return "食品"
		case strings.Contains(text, "寄件") || strings.Contains(text, "快递"):
			return "快递费"
		case strings.Contains(text, "保险") || strings.Contains(text, "保费"):
			return "保险支出"
		}
	case importing.SOURCE_TYPE_BANK:
		if strings.Contains(text, "电话") {
			return "电话费"
		}
	}
	return ""
}

func evidenceSemanticTodo(sourceType importing.SourceType, row *importing.RawImportRow) TodoKind {
	if sourceType != importing.SOURCE_TYPE_BANK || row == nil {
		return ""
	}
	text := canonicalCategoryName(strings.TrimSpace(row.RawCounterparty) + " " + strings.TrimSpace(row.RawItem))
	if strings.Contains(text, "款项转入") || strings.Contains(text, "还款") {
		return TODO_KIND_REPAYMENT_UNCLEAR
	}
	return ""
}

func transferLikeTodo(name string) TodoKind {
	if name == "" || !isForbiddenCategoryName(name) {
		return ""
	}
	canon := canonicalCategoryName(name)
	if canon == "商户消费" || canon == "扫二维码付款" {
		return ""
	}
	if strings.Contains(canon, "还款") {
		return TODO_KIND_REPAYMENT_UNCLEAR
	}
	return TODO_KIND_TRANSFER_UNCLEAR
}

func suggestedAccountType(displayName string) string {
	name := canonicalCategoryName(displayName)
	if strings.Contains(name, "信用") || strings.Contains(name, "花呗") || strings.Contains(name, "白条") || strings.Contains(name, "末四位") {
		return "credit_card"
	}
	return "virtual"
}
