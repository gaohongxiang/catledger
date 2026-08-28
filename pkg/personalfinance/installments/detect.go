package installments

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

const (
	maximumInstallmentPeriod = int64(120)
	maximumInstallmentTerms  = int64(360)
)

var (
	periodOverTermPattern = regexp.MustCompile(`第\s*([0-9]{1,3})\s*[／/]\s*([0-9]{1,3})\s*期`)
	barePeriodOverTerm    = regexp.MustCompile(`(?:^|[^\d])([0-9]{1,3})\s*[／/]\s*([0-9]{1,3})\s*期`)
	periodTotalPattern    = regexp.MustCompile(`第\s*([0-9]{1,3})\s*期\s*共\s*([0-9]{1,3})\s*期`)
	nthPeriodPattern      = regexp.MustCompile(`第\s*([0-9]{1,3})\s*期`)
	huabeiMonthlyPattern  = regexp.MustCompile(`花呗月月付`)
	huabeiInstallment     = regexp.MustCompile(`花呗分期`)
	cardInstallment       = regexp.MustCompile(`信用卡分期`)
	interestComponent     = regexp.MustCompile(`利息|利率费用`)
	feeComponent          = regexp.MustCompile(`手续费|服务费|分期费`)
	principalComponent    = regexp.MustCompile(`本金|按月收|总账分月|现分分期款`)
	cashFunding           = regexp.MustCompile(`现分|现金分期|现金贷|随借|借款分期`)
	purchaseFunding       = regexp.MustCompile(`花呗|信用购|消费分期|商品分期|账单分期|信用卡分期`)
)

// Detection 是 installment-detect-v2 从原始字段解析出的稳定分期信号。
// 未解析到的期次和总期数保持 nil，调用方不得改写成 0。
type Detection struct {
	Matched      bool
	PeriodNumber *int64
	TermCount    *int64
	PlanToken    string
	Component    ComponentType
	Funding      FundingType
}

// Evidence 是检测器只读的原始字段切片，不含金额和日期。
type Evidence struct {
	RowId              int64
	IdentityId         *int64
	SourceOrderId      string
	SourceMerchantId   string
	RawTransactionType string
	RawCounterparty    string
	RawItem            string
	RawNote            string
	LedgerAccountId    *int64
}

// Detect 从不可变原始字段识别分期计划和组成，不依赖金额或时间近似。
func Detect(evidence Evidence) Detection {
	haystack := normalizeDetectText(strings.Join([]string{
		evidence.RawTransactionType, evidence.RawCounterparty, evidence.RawItem, evidence.RawNote,
	}, " "))
	if haystack == "" {
		return Detection{}
	}

	detection := Detection{}
	singleTerm := false
	if match := periodTotalPattern.FindStringSubmatch(haystack); len(match) == 3 {
		period, term, ok := parsePeriodAndTerm(match[1], match[2])
		if ok {
			detection.Matched = true
			detection.PeriodNumber = &period
			if term > 1 {
				detection.TermCount = &term
			} else {
				singleTerm = true
			}
		}
	}
	if !detection.Matched {
		if match := periodOverTermPattern.FindStringSubmatch(haystack); len(match) == 3 {
			period, term, ok := parsePeriodAndTerm(match[1], match[2])
			if ok {
				detection.Matched = true
				detection.PeriodNumber = &period
				if term > 1 {
					detection.TermCount = &term
				} else {
					singleTerm = true
				}
			}
		}
	}
	if !detection.Matched {
		if match := barePeriodOverTerm.FindStringSubmatch(haystack); len(match) == 3 {
			period, term, ok := parsePeriodAndTerm(match[1], match[2])
			if ok {
				detection.Matched = true
				detection.PeriodNumber = &period
				if term > 1 {
					detection.TermCount = &term
				} else {
					singleTerm = true
				}
			}
		}
	}
	if detection.PeriodNumber == nil {
		if match := nthPeriodPattern.FindStringSubmatch(haystack); len(match) == 2 {
			period, ok := parsePositiveBounded(match[1], maximumInstallmentPeriod)
			if ok {
				detection.Matched = true
				detection.PeriodNumber = &period
			}
		}
	}

	switch {
	case huabeiMonthlyPattern.MatchString(haystack):
		detection.Matched = true
		detection.PlanToken = "huabei_monthly"
	case huabeiInstallment.MatchString(haystack):
		detection.Matched = true
		detection.PlanToken = "huabei_installment"
	case cardInstallment.MatchString(haystack):
		detection.Matched = true
		detection.PlanToken = "card_installment"
	case cashFunding.MatchString(haystack):
		detection.Matched = true
		detection.PlanToken = "cash_installment"
	}

	componentMatches := 0
	if interestComponent.MatchString(haystack) {
		detection.Component = COMPONENT_TYPE_INTEREST
		componentMatches++
	}
	if feeComponent.MatchString(haystack) {
		detection.Component = COMPONENT_TYPE_FEE
		componentMatches++
	}
	if principalComponent.MatchString(haystack) {
		detection.Component = COMPONENT_TYPE_PRINCIPAL
		componentMatches++
	}
	// 单行同时出现本金、利息或费用时，原始账单没有给出各组成金额。
	// 保留未知并转人工拆分，不得按先后顺序猜成其中一种。
	if componentMatches > 1 {
		detection.Component = COMPONENT_TYPE_UNKNOWN
	}
	switch {
	case cashFunding.MatchString(haystack):
		detection.Funding = FUNDING_TYPE_CASH_DISBURSEMENT
	case purchaseFunding.MatchString(haystack):
		detection.Funding = FUNDING_TYPE_PURCHASE_INSTALLMENT
	}

	if (singleTerm || (detection.TermCount != nil && *detection.TermCount == 1)) && detection.PlanToken == "" {
		return Detection{}
	}
	if !detection.Matched {
		return Detection{}
	}
	if detection.PeriodNumber == nil && detection.PlanToken == "" {
		return Detection{}
	}

	return detection
}

func detectInstallment(evidence Evidence) Detection { return Detect(evidence) }

func parsePeriodAndTerm(periodText string, termText string) (int64, int64, bool) {
	period, periodOK := parsePositiveBounded(periodText, maximumInstallmentPeriod)
	term, termOK := parsePositiveBounded(termText, maximumInstallmentTerms)
	if !periodOK || !termOK || period > term {
		return 0, 0, false
	}
	return period, term, true
}

func parsePositiveBounded(text string, maximum int64) (int64, bool) {
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value < 1 || value > maximum {
		return 0, false
	}
	return value, true
}

func normalizeDetectText(value string) string {
	return strings.TrimSpace(norm.NFKC.String(value))
}

func normalizeKeyPart(value string) string {
	return strings.TrimSpace(norm.NFKC.String(value))
}

func candidateKey(evidence Evidence, detection Detection) string {
	tokens := make([]string, 0, 5)
	hasStableOrigin := false
	if plan := normalizeKeyPart(detection.PlanToken); plan != "" {
		tokens = append(tokens, "plan="+plan)
	}
	if order := normalizeKeyPart(evidence.SourceOrderId); order != "" {
		tokens = append(tokens, "order="+order)
		hasStableOrigin = true
	}
	if merchant := normalizeKeyPart(evidence.SourceMerchantId); merchant != "" {
		tokens = append(tokens, "merchant="+merchant)
		hasStableOrigin = true
	}
	if evidence.LedgerAccountId != nil && *evidence.LedgerAccountId > 0 {
		tokens = append(tokens, "liability="+strconv.FormatInt(*evidence.LedgerAccountId, 10))
	}
	// 计划名、负债账户和期次都不能唯一标识一笔贷款。缺少稳定订单时加入
	// 来源身份/原始行，宁可生成独立候选，也不把同卡同期的不同借款误并。
	if !hasStableOrigin {
		if evidence.IdentityId != nil && *evidence.IdentityId > 0 {
			tokens = append(tokens, "charge="+strconv.FormatInt(*evidence.IdentityId, 10))
		} else if evidence.RowId > 0 {
			tokens = append(tokens, "row="+strconv.FormatInt(evidence.RowId, 10))
		}
	}
	sort.Strings(tokens)
	payload := string(CANDIDATE_KEY_VERSION_V1) + "\n" + strings.Join(tokens, "\n")
	digest := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(digest[:])
}
