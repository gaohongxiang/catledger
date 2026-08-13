package calculation

import (
	"errors"
	"testing"
)

func TestSolvePeriodicIRRStatuses(t *testing.T) {
	tests := []struct {
		name      string
		cashflows []int64
		status    IRRStatus
		monthly   *int64
		simple    *int64
		effective *int64
	}{
		{
			name: "solved zero", cashflows: []int64{100, -100}, status: IRRStatusSolvedZero,
			monthly: pointer(0), simple: pointer(0), effective: pointer(0),
		},
		{
			name: "solved ten percent", cashflows: []int64{100, -110}, status: IRRStatusSolved,
			monthly: pointer(100_000_000_000), simple: pointer(1_200_000_000_000),
			effective: pointer(2_138_428_376_721),
		},
		{
			name: "solved upper bound", cashflows: []int64{100, -300}, status: IRRStatusSolved,
			monthly: pointer(MaxIRRPPTR), simple: pointer(24_000_000_000_000),
			effective: pointer(531_440_000_000_000_000),
		},
		{name: "no nonnegative root", cashflows: []int64{100, -90}, status: IRRStatusNoNonnegativeRoot},
		{name: "out of range", cashflows: []int64{100, -301}, status: IRRStatusOutOfRange},
		{name: "too short", cashflows: []int64{100}, status: IRRStatusInsufficientFlows},
		{name: "no repayment", cashflows: []int64{100, 0}, status: IRRStatusInsufficientFlows},
		{name: "invalid initial", cashflows: []int64{0, -1}, status: IRRStatusInsufficientFlows},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := SolvePeriodicIRR(test.cashflows)
			if err != nil {
				t.Fatalf("SolvePeriodicIRR() error = %v", err)
			}
			if result.Status != test.status ||
				!equalOptionalInt64(result.MonthlyIRRPPTR, test.monthly) ||
				!equalOptionalInt64(result.SimpleAPRPPTR, test.simple) ||
				!equalOptionalInt64(result.EffectiveAPRPPTR, test.effective) {
				t.Fatalf("SolvePeriodicIRR() = %+v, want status=%q monthly=%v simple=%v effective=%v",
					result, test.status, test.monthly, test.simple, test.effective)
			}
		})
	}
}

func TestSolvePeriodicIRRRejectsNonTraditionalCashflows(t *testing.T) {
	result, err := SolvePeriodicIRR([]int64{100, -120, 10})
	if !errors.Is(err, ErrInvalidCashflows) {
		t.Fatalf("SolvePeriodicIRR() error = %v, want ErrInvalidCashflows", err)
	}
	if result != (IRRResult{}) {
		t.Fatalf("SolvePeriodicIRR() result = %+v, want zero value", result)
	}
}

func TestUpfrontFeeAffectsIRROnceThroughNetDisbursement(t *testing.T) {
	zeroRate := int64(0)
	input := Input{
		PrincipalAmount:          100_000,
		ActualDisbursementAmount: 99_000,
		UpfrontFeeAmount:         1_000,
		TermCount:                10,
		FirstDueDate:             "2026-01-01",
		InputMode:                InputModeRate,
		RepaymentMethod:          RepaymentMethodFlat,
		RateQuoteType:            RateQuoteTypeMonthly,
		QuotedRatePPTR:           &zeroRate,
		DiscountType:             DiscountTypeNone,
	}
	result, err := Calculate(input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}
	if result.TotalFeeAmount != 1_000 || result.TotalCostAmount != 1_000 || result.TotalPaymentAmount != 101_000 {
		t.Fatalf("upfront fee totals mismatch: %+v", result)
	}
	if result.IRR.Status != IRRStatusSolved || result.IRR.MonthlyIRRPPTR == nil || *result.IRR.MonthlyIRRPPTR <= 0 {
		t.Fatalf("upfront fee IRR mismatch: %+v", result.IRR)
	}

	cashflows := make([]int64, len(result.Installments)+1)
	cashflows[0] = 99_000
	for index, row := range result.Installments {
		cashflows[index+1] = -row.PaymentAmount
	}
	expected, err := SolvePeriodicIRR(cashflows)
	if err != nil {
		t.Fatalf("SolvePeriodicIRR() error = %v", err)
	}
	if !equalIRR(result.IRR, expected) {
		t.Fatalf("IRR = %+v, want %+v", result.IRR, expected)
	}
}
