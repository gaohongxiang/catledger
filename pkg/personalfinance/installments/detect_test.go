package installments

import "testing"

func TestDetectInstallmentStablePatterns(t *testing.T) {
	period2, term12 := int64(2), int64(12)
	cases := []struct {
		name    string
		item    string
		note    string
		matched bool
		period  *int64
		term    *int64
		plan    string
	}{
		{name: "nth-over-term", item: "花呗月月付 第2/12期", matched: true, period: &period2, term: &term12, plan: "huabei_monthly"},
		{name: "bare-over-term", item: "信用卡分期 3/6期", matched: true, period: int64Ptr(3), term: int64Ptr(6), plan: "card_installment"},
		{name: "nth-period-only", item: "第4期还款", matched: true, period: int64Ptr(4)},
		{name: "full-width-slash", item: "第1／12期", matched: true, period: int64Ptr(1), term: int64Ptr(12)},
		{name: "huabei-monthly-without-period", item: "花呗月月付", matched: true, plan: "huabei_monthly"},
		{name: "single-term-skipped", item: "第1/1期", matched: false},
		{name: "generic-installment-word", item: "分期购买耳机", matched: false},
		{name: "date-like-without-qi", item: "2026/08 消费", matched: false},
		{name: "empty", matched: false},
	}

	for _, testCase := range cases {
		detection := detectInstallment(Evidence{RawItem: testCase.item, RawNote: testCase.note, RowId: 9})
		if detection.Matched != testCase.matched {
			t.Fatalf("%s matched=%t, expected %t", testCase.name, detection.Matched, testCase.matched)
		}
		if !sameOptionalInt(detection.PeriodNumber, testCase.period) || !sameOptionalInt(detection.TermCount, testCase.term) {
			t.Fatalf("%s period/term = %v/%v, expected %v/%v", testCase.name, detection.PeriodNumber, detection.TermCount, testCase.period, testCase.term)
		}
		if detection.PlanToken != testCase.plan {
			t.Fatalf("%s plan=%q, expected %q", testCase.name, detection.PlanToken, testCase.plan)
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
