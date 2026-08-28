package installments

import "testing"

func TestDetectInstallmentStablePatterns(t *testing.T) {
	period2, term12 := int64(2), int64(12)
	cases := []struct {
		name         string
		item         string
		note         string
		counterparty string
		matched      bool
		period       *int64
		term         *int64
		plan         string
		component    ComponentType
		funding      FundingType
	}{
		{name: "nth-over-term", item: "花呗月月付 第2/12期", matched: true, period: &period2, term: &term12, plan: "huabei_monthly", funding: FUNDING_TYPE_PURCHASE_INSTALLMENT},
		{name: "bare-over-term", item: "信用卡分期 3/6期", matched: true, period: int64Ptr(3), term: int64Ptr(6), plan: "card_installment", funding: FUNDING_TYPE_PURCHASE_INSTALLMENT},
		{name: "nth-period-only", item: "第4期还款", matched: true, period: int64Ptr(4)},
		{name: "full-width-slash", item: "第1／12期", matched: true, period: int64Ptr(1), term: int64Ptr(12)},
		{name: "huabei-monthly-without-period", item: "花呗月月付", matched: true, plan: "huabei_monthly", funding: FUNDING_TYPE_PURCHASE_INSTALLMENT},
		{name: "single-term-skipped", item: "第1/1期", matched: false},
		{name: "generic-installment-word", item: "分期购买耳机", matched: false},
		{name: "cash-principal-total", item: "电销现分按月收12期第7期共12期", matched: true, period: int64Ptr(7), term: int64Ptr(12), plan: "cash_installment", component: COMPONENT_TYPE_PRINCIPAL, funding: FUNDING_TYPE_CASH_DISBURSEMENT},
		{name: "cib-counterparty-cash-principal", counterparty: "电销现分按月收12期第7期共12期", matched: true, period: int64Ptr(7), term: int64Ptr(12), plan: "cash_installment", component: COMPONENT_TYPE_PRINCIPAL, funding: FUNDING_TYPE_CASH_DISBURSEMENT},
		{name: "cib-counterparty-interest", counterparty: "分期付款利息第11期共12期", matched: true, period: int64Ptr(11), term: int64Ptr(12), component: COMPONENT_TYPE_INTEREST},
		{name: "installment-interest-total", item: "分期付款利息第11期共12期", matched: true, period: int64Ptr(11), term: int64Ptr(12), component: COMPONENT_TYPE_INTEREST},
		{name: "purchase-principal", item: "花呗分期本金 第2/12期", matched: true, period: int64Ptr(2), term: int64Ptr(12), plan: "huabei_installment", component: COMPONENT_TYPE_PRINCIPAL, funding: FUNDING_TYPE_PURCHASE_INSTALLMENT},
		{name: "composite-needs-split", item: "现金分期本金及利息服务费 第2/12期", matched: true, period: int64Ptr(2), term: int64Ptr(12), plan: "cash_installment", funding: FUNDING_TYPE_CASH_DISBURSEMENT},
		{name: "date-like-without-qi", item: "2026/08 消费", matched: false},
		{name: "empty", matched: false},
	}

	for _, testCase := range cases {
		detection := detectInstallment(Evidence{RawCounterparty: testCase.counterparty, RawItem: testCase.item, RawNote: testCase.note, RowId: 9})
		if detection.Matched != testCase.matched {
			t.Fatalf("%s matched=%t, expected %t", testCase.name, detection.Matched, testCase.matched)
		}
		if !sameOptionalInt(detection.PeriodNumber, testCase.period) || !sameOptionalInt(detection.TermCount, testCase.term) {
			t.Fatalf("%s period/term = %v/%v, expected %v/%v", testCase.name, detection.PeriodNumber, detection.TermCount, testCase.period, testCase.term)
		}
		if detection.PlanToken != testCase.plan {
			t.Fatalf("%s plan=%q, expected %q", testCase.name, detection.PlanToken, testCase.plan)
		}
		if detection.Component != testCase.component || detection.Funding != testCase.funding {
			t.Fatalf("%s component/funding=%q/%q, expected %q/%q", testCase.name, detection.Component, detection.Funding, testCase.component, testCase.funding)
		}
		if detection.TermCount != nil && *detection.TermCount == 0 {
			t.Fatalf("%s wrote term count 0", testCase.name)
		}
	}
}

func TestCandidateKeyIgnoresAmountAndGroupsByOrder(t *testing.T) {
	liability := int64(11)
	first := candidateKey(Evidence{SourceOrderId: "20260815001", LedgerAccountId: &liability, RowId: 1}, Detection{PlanToken: "huabei_monthly"})
	second := candidateKey(Evidence{SourceOrderId: "20260815001", LedgerAccountId: &liability, RowId: 2}, Detection{PlanToken: "huabei_monthly"})
	if first == "" || first != second {
		t.Fatalf("same order did not share candidate key: %s vs %s", first, second)
	}

	otherOrder := candidateKey(Evidence{SourceOrderId: "20260815002", LedgerAccountId: &liability, RowId: 3}, Detection{PlanToken: "huabei_monthly"})
	if otherOrder == first {
		t.Fatal("different orders shared a candidate key")
	}

	withoutOrderFirst := candidateKey(Evidence{IdentityId: int64Ptr(101), RowId: 4}, Detection{PeriodNumber: int64Ptr(1)})
	withoutOrderSecond := candidateKey(Evidence{IdentityId: int64Ptr(202), RowId: 5}, Detection{PeriodNumber: int64Ptr(2)})
	if withoutOrderFirst == withoutOrderSecond {
		t.Fatal("orderless rows with different identities were merged")
	}

	sameCardDifferentLoanFirst := candidateKey(Evidence{IdentityId: int64Ptr(301), LedgerAccountId: &liability, RowId: 6}, Detection{PlanToken: "cash_installment", PeriodNumber: int64Ptr(7), TermCount: int64Ptr(12)})
	sameCardDifferentLoanSecond := candidateKey(Evidence{IdentityId: int64Ptr(302), LedgerAccountId: &liability, RowId: 7}, Detection{PlanToken: "cash_installment", PeriodNumber: int64Ptr(7), TermCount: int64Ptr(12)})
	if sameCardDifferentLoanFirst == sameCardDifferentLoanSecond {
		t.Fatal("orderless loans on the same account shared a candidate key")
	}
}

func int64Ptr(value int64) *int64 {
	return &value
}

func sameOptionalInt(left *int64, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
