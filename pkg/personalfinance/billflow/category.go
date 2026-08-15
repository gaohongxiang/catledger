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
	if strings.Contains(name, "信用") || strings.Contains(name, "花呗") || strings.Contains(name, "白条") {
		return "credit_card"
	}
	return "virtual"
}
