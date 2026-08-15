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
	nthPeriodPattern      = regexp.MustCompile(`第\s*([0-9]{1,3})\s*期`)
	huabeiMonthlyPattern  = regexp.MustCompile(`花呗月月付`)
	huabeiInstallment     = regexp.MustCompile(`花呗分期`)
	cardInstallment       = regexp.MustCompile(`信用卡分期`)
)

// Detection 是 installment-detect-v1 从原始字段解析出的稳定分期信号。
// 未解析到的期次和总期数保持 nil，调用方不得改写成 0。
type Detection struct {
	Matched      bool
	PeriodNumber *int64
	TermCount    *int64
	PlanToken    string
}

// Evidence 是检测器只读的原始字段切片，不含金额和日期。
type Evidence struct {
	RowId              int64
	IdentityId         *int64
	SourceOrderId      string
	SourceMerchantId   string
	RawTransactionType string
	RawItem            string
	RawNote            string
	LedgerAccountId    *int64
}

func detectInstallment(evidence Evidence) Detection {
	haystack := normalizeDetectText(strings.Join([]string{
		evidence.RawTransactionType, evidence.RawItem, evidence.RawNote,
	}, " "))
	if haystack == "" {
		return Detection{}
	}

	detection := Detection{}
	singleTerm := false
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
	if plan := normalizeKeyPart(detection.PlanToken); plan != "" {
		tokens = append(tokens, "plan="+plan)
	}
	if order := normalizeKeyPart(evidence.SourceOrderId); order != "" {
		tokens = append(tokens, "order="+order)
	}
	if merchant := normalizeKeyPart(evidence.SourceMerchantId); merchant != "" {
		tokens = append(tokens, "merchant="+merchant)
	}
	if evidence.LedgerAccountId != nil && *evidence.LedgerAccountId > 0 {
		tokens = append(tokens, "liability="+strconv.FormatInt(*evidence.LedgerAccountId, 10))
	}
	if len(tokens) == 0 {
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
