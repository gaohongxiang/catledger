package calculation

import (
	"errors"
	"math"
	"reflect"
	"sync"
	"testing"
)

func TestCalculationMatrix(t *testing.T) {
	methods := []RepaymentMethod{
		RepaymentMethodFlat,
		RepaymentMethodEqualPayment,
		RepaymentMethodEqualPrincipal,
		RepaymentMethodInterestOnly,
	}
	modes := []InputMode{InputModeRate, InputModeRepayment}
	variants := []struct {
		name               string
		discountType       DiscountType
		discountRatePPTR   *int64
		discountAmount     int64
		upfrontFeeAmount   int64
		perPeriodFeeAmount int64
	}{
		{name: "plain", discountType: DiscountTypeNone},
		{name: "interest_rate", discountType: DiscountTypeInterestRate, discountRatePPTR: pointer(800_000_000_000)},
		{name: "per_period", discountType: DiscountTypePerPeriod, discountAmount: 500},
		{name: "total", discountType: DiscountTypeTotal, discountAmount: 2_500},
		{name: "upfront_fee", discountType: DiscountTypeNone, upfrontFeeAmount: 5_000},
		{name: "per_period_fee", discountType: DiscountTypeNone, perPeriodFeeAmount: 300},
		{
			name:               "discount_and_fees",
			discountType:       DiscountTypeInterestRate,
			discountRatePPTR:   pointer(700_000_000_000),
			upfrontFeeAmount:   5_000,
			perPeriodFeeAmount: 300,
		},
	}

	for _, mode := range modes {
		for _, method := range methods {
			for _, variant := range variants {
				name := string(mode) + "/" + string(method) + "/" + variant.name
				t.Run(name, func(t *testing.T) {
					input := matrixInput(method, mode)
					input.UpfrontFeeAmount = variant.upfrontFeeAmount
					input.ActualDisbursementAmount = input.PrincipalAmount - variant.upfrontFeeAmount
					input.PerPeriodFeeAmount = variant.perPeriodFeeAmount
					input.DiscountType = variant.discountType
					input.DiscountRatePPTR = variant.discountRatePPTR
					input.DiscountAmount = variant.discountAmount

					result, err := Calculate(input)
					if err != nil {
						t.Fatalf("Calculate() error = %v", err)
					}
					if err = ValidateResult(input, result); err != nil {
						t.Fatalf("ValidateResult() error = %v", err)
					}
					second, err := Calculate(input)
					if err != nil {
						t.Fatalf("second Calculate() error = %v", err)
					}
					if !reflect.DeepEqual(result, second) {
						t.Fatal("Calculate() is not deterministic")
					}
					if int64(len(result.Installments)) != input.TermCount {
						t.Fatalf("installment count = %d, want %d", len(result.Installments), input.TermCount)
					}
					if result.TotalPaymentAmount != input.PrincipalAmount+result.TotalCostAmount {
						t.Fatal("total payment does not reconcile to principal plus cost")
					}
					if result.PreDiscountTotalCostAmount-result.TotalCostAmount != result.TotalDiscountAmount {
						t.Fatal("discount total does not reconcile")
					}
					if result.IRR.Status != IRRStatusSolved && result.IRR.Status != IRRStatusSolvedZero {
						t.Fatalf("IRR status = %q, want solved status", result.IRR.Status)
					}
					if variant.discountType == DiscountTypeNone && result.TotalDiscountAmount != 0 {
						t.Fatalf("total discount = %d, want 0", result.TotalDiscountAmount)
					}
					if variant.discountType != DiscountTypeNone &&
						result.TotalCostAmount > result.PreDiscountTotalCostAmount {
						t.Fatal("discount raised total cost")
					}
				})
			}
		}
	}
}

func TestReferenceMethodGoldens(t *testing.T) {
	annualRate := int64(100_000_000_000)
	tests := []struct {
		name           string
		method         RepaymentMethod
		totalInterest  int64
		firstPrincipal int64
		firstInterest  int64
		lastPrincipal  int64
		lastInterest   int64
		firstPayment   int64
		lastPayment    int64
	}{
		{
			name: "flat", method: RepaymentMethodFlat, totalInterest: 100_000,
			firstPrincipal: 83_333, firstInterest: 8_333, lastPrincipal: 83_337,
			lastInterest: 8_337, firstPayment: 91_666, lastPayment: 91_674,
		},
		{
			name: "equal_payment", method: RepaymentMethodEqualPayment, totalInterest: 54_989,
			firstPrincipal: 79_583, firstInterest: 8_333, lastPrincipal: 87_186,
			lastInterest: 727, firstPayment: 87_916, lastPayment: 87_913,
		},
		{
			name: "equal_principal", method: RepaymentMethodEqualPrincipal, totalInterest: 54_166,
			firstPrincipal: 83_333, firstInterest: 8_333, lastPrincipal: 83_337,
			lastInterest: 694, firstPayment: 91_666, lastPayment: 84_031,
		},
		{
			name: "interest_only", method: RepaymentMethodInterestOnly, totalInterest: 100_000,
			firstPrincipal: 0, firstInterest: 8_333, lastPrincipal: 1_000_000,
			lastInterest: 8_337, firstPayment: 8_333, lastPayment: 1_008_337,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := Input{
				PrincipalAmount:          1_000_000,
				ActualDisbursementAmount: 1_000_000,
				TermCount:                12,
				FirstDueDate:             "2026-01-31",
				InputMode:                InputModeRate,
				RepaymentMethod:          test.method,
				RateQuoteType:            RateQuoteTypeAnnual,
				QuotedRatePPTR:           &annualRate,
				DiscountType:             DiscountTypeNone,
			}
			result, err := Calculate(input)
			if err != nil {
				t.Fatalf("Calculate() error = %v", err)
			}
			first := result.Installments[0]
			last := result.Installments[len(result.Installments)-1]
			if result.TotalInterestAmount != test.totalInterest ||
				first.PrincipalAmount != test.firstPrincipal || first.InterestAmount != test.firstInterest ||
				last.PrincipalAmount != test.lastPrincipal || last.InterestAmount != test.lastInterest ||
				first.PaymentAmount != test.firstPayment || last.PaymentAmount != test.lastPayment {
				t.Fatalf("reference result mismatch: total=%d first=%+v last=%+v", result.TotalInterestAmount, first, last)
			}
		})
	}
}

func TestReferenceRepaymentMethodGoldens(t *testing.T) {
	tests := []struct {
		name           string
		method         RepaymentMethod
		paymentBasis   int64
		totalInterest  int64
		firstPrincipal int64
		firstInterest  int64
		lastPrincipal  int64
		lastInterest   int64
		firstPayment   int64
		lastPayment    int64
	}{
		{
			name: "flat", method: RepaymentMethodFlat, paymentBasis: 90_000, totalInterest: 80_000,
			firstPrincipal: 83_333, firstInterest: 6_667, lastPrincipal: 83_337,
			lastInterest: 6_663, firstPayment: 90_000, lastPayment: 90_000,
		},
		{
			name: "equal_payment", method: RepaymentMethodEqualPayment, paymentBasis: 87_916, totalInterest: 54_992,
			firstPrincipal: 79_582, firstInterest: 8_334, lastPrincipal: 87_189,
			lastInterest: 727, firstPayment: 87_916, lastPayment: 87_916,
		},
		{
			name: "equal_principal", method: RepaymentMethodEqualPrincipal, paymentBasis: 91_667, totalInterest: 54_174,
			firstPrincipal: 83_333, firstInterest: 8_334, lastPrincipal: 83_337,
			lastInterest: 695, firstPayment: 91_667, lastPayment: 84_032,
		},
		{
			name: "interest_only", method: RepaymentMethodInterestOnly, paymentBasis: 8_333, totalInterest: 99_996,
			firstPrincipal: 0, firstInterest: 8_333, lastPrincipal: 1_000_000,
			lastInterest: 8_333, firstPayment: 8_333, lastPayment: 1_008_333,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := Input{
				PrincipalAmount:          1_000_000,
				ActualDisbursementAmount: 1_000_000,
				PaymentBasisAmount:       &test.paymentBasis,
				TermCount:                12,
				FirstDueDate:             "2026-01-31",
				InputMode:                InputModeRepayment,
				RepaymentMethod:          test.method,
				DiscountType:             DiscountTypeNone,
			}
			result, err := Calculate(input)
			if err != nil {
				t.Fatalf("Calculate() error = %v", err)
			}
			first := result.Installments[0]
			last := result.Installments[len(result.Installments)-1]
			if result.TotalInterestAmount != test.totalInterest ||
				first.PrincipalAmount != test.firstPrincipal || first.InterestAmount != test.firstInterest ||
				last.PrincipalAmount != test.lastPrincipal || last.InterestAmount != test.lastInterest ||
				first.PaymentAmount != test.firstPayment || last.PaymentAmount != test.lastPayment {
				t.Fatalf("reference result mismatch: total=%d first=%+v last=%+v", result.TotalInterestAmount, first, last)
			}
		})
	}
}

func TestDiscountSemantics(t *testing.T) {
	t.Run("cash discount reduces fee before interest", func(t *testing.T) {
		input := matrixInput(RepaymentMethodFlat, InputModeRate)
		input.PerPeriodFeeAmount = 300
		input.DiscountType = DiscountTypePerPeriod
		input.DiscountAmount = 500
		result, err := Calculate(input)
		if err != nil {
			t.Fatalf("Calculate() error = %v", err)
		}
		row := result.Installments[0]
		if row.PreDiscountFeeAmount != 300 || row.FeeAmount != 0 ||
			row.PreDiscountInterestAmount != 8_333 || row.InterestAmount != 8_133 ||
			row.DiscountAmount != 500 {
			t.Fatalf("fee-first discount mismatch: %+v", row)
		}
	})

	t.Run("total discount absorbs cent tail in final installment", func(t *testing.T) {
		input := matrixInput(RepaymentMethodFlat, InputModeRate)
		input.PerPeriodFeeAmount = 300
		input.DiscountType = DiscountTypeTotal
		input.DiscountAmount = 2_500
		result, err := Calculate(input)
		if err != nil {
			t.Fatalf("Calculate() error = %v", err)
		}
		if result.TotalDiscountAmount != 2_500 {
			t.Fatalf("total discount = %d, want 2500", result.TotalDiscountAmount)
		}
		for index, row := range result.Installments[:11] {
			if row.DiscountAmount != 208 {
				t.Fatalf("installment %d discount = %d, want 208", index+1, row.DiscountAmount)
			}
		}
		if got := result.Installments[11].DiscountAmount; got != 212 {
			t.Fatalf("final discount = %d, want 212", got)
		}
	})

	t.Run("interest discount re-amortizes equal payment", func(t *testing.T) {
		input := matrixInput(RepaymentMethodEqualPayment, InputModeRepayment)
		input.PrincipalAmount = 5_000_000
		input.ActualDisbursementAmount = 5_000_000
		input.PaymentBasisAmount = pointer(446_059)
		input.DiscountType = DiscountTypeInterestRate
		input.DiscountRatePPTR = pointer(700_000_000_000)
		result, err := Calculate(input)
		if err != nil {
			t.Fatalf("Calculate() error = %v", err)
		}
		first := result.Installments[0]
		if first.PaymentAmount >= first.PreDiscountPaymentAmount {
			t.Fatal("discounted equal payment was not reduced")
		}
		prePrincipal := first.PreDiscountPaymentAmount - first.PreDiscountInterestAmount - first.PreDiscountFeeAmount
		if first.PrincipalAmount == prePrincipal {
			t.Fatal("equal payment interest discount did not re-amortize principal")
		}
		if result.TotalCostAmount >= result.PreDiscountTotalCostAmount {
			t.Fatal("interest discount did not reduce total cost")
		}
	})

	t.Run("full-rate factor leaves schedule unchanged", func(t *testing.T) {
		input := matrixInput(RepaymentMethodEqualPayment, InputModeRepayment)
		input.DiscountType = DiscountTypeInterestRate
		input.DiscountRatePPTR = pointer(PPTRScale)
		result, err := Calculate(input)
		if err != nil {
			t.Fatalf("Calculate() error = %v", err)
		}
		if result.TotalDiscountAmount != 0 || result.TotalCostAmount != result.PreDiscountTotalCostAmount {
			t.Fatalf("full-rate factor changed totals: %+v", result)
		}
		for _, row := range result.Installments {
			if row.DiscountAmount != 0 || row.PaymentAmount != row.PreDiscountPaymentAmount ||
				row.InterestAmount != row.PreDiscountInterestAmount || row.FeeAmount != row.PreDiscountFeeAmount {
				t.Fatalf("full-rate factor changed installment: %+v", row)
			}
		}
	})
}

func TestRateQuoteConversions(t *testing.T) {
	tests := []struct {
		name      string
		quoteType RateQuoteType
		quoted    int64
		method    RepaymentMethod
	}{
		{name: "annual", quoteType: RateQuoteTypeAnnual, quoted: 120_000_000_000, method: RepaymentMethodEqualPayment},
		{name: "monthly", quoteType: RateQuoteTypeMonthly, quoted: 10_000_000_000, method: RepaymentMethodEqualPayment},
		{name: "daily", quoteType: RateQuoteTypeDaily, quoted: 333_333_333, method: RepaymentMethodEqualPayment},
		{name: "installment", quoteType: RateQuoteTypeInstallment, quoted: 10_000_000_000, method: RepaymentMethodFlat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := matrixInput(test.method, InputModeRate)
			input.RateQuoteType = test.quoteType
			input.QuotedRatePPTR = &test.quoted
			result, err := Calculate(input)
			if err != nil {
				t.Fatalf("Calculate() error = %v", err)
			}
			want := int64(10_000_000_000)
			if test.quoteType == RateQuoteTypeDaily {
				want = 9_999_999_990
			}
			if result.PeriodicRatePPTR != want {
				t.Fatalf("periodic rate = %d, want %d", result.PeriodicRatePPTR, want)
			}
		})
	}
}

func TestHalfUpAndFinalReconciliation(t *testing.T) {
	monthlyRate := int64(500_000_000_000)
	input := Input{
		PrincipalAmount:          3,
		ActualDisbursementAmount: 3,
		TermCount:                2,
		FirstDueDate:             "2024-01-31",
		InputMode:                InputModeRate,
		RepaymentMethod:          RepaymentMethodFlat,
		RateQuoteType:            RateQuoteTypeMonthly,
		QuotedRatePPTR:           &monthlyRate,
		DiscountType:             DiscountTypeNone,
	}
	result, err := Calculate(input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}
	if first := result.Installments[0]; first.PrincipalAmount != 2 || first.InterestAmount != 2 ||
		first.DueDate != "2024-01-31" {
		t.Fatalf("half-up first installment mismatch: %+v", first)
	}
	if last := result.Installments[1]; last.PrincipalAmount != 1 || last.InterestAmount != 1 ||
		last.EndingPrincipalAmount != 0 || last.DueDate != "2024-02-29" {
		t.Fatalf("final reconciliation mismatch: %+v", last)
	}
}

func TestTinyPrincipalStillProducesRequestedTerms(t *testing.T) {
	zeroRate := int64(0)
	for _, method := range []RepaymentMethod{RepaymentMethodFlat, RepaymentMethodEqualPrincipal} {
		t.Run(string(method), func(t *testing.T) {
			input := Input{
				PrincipalAmount:          4,
				ActualDisbursementAmount: 4,
				TermCount:                6,
				FirstDueDate:             "2026-01-31",
				InputMode:                InputModeRate,
				RepaymentMethod:          method,
				RateQuoteType:            RateQuoteTypeMonthly,
				QuotedRatePPTR:           &zeroRate,
				DiscountType:             DiscountTypeNone,
			}
			result, err := Calculate(input)
			if err != nil {
				t.Fatalf("Calculate() error = %v", err)
			}
			if len(result.Installments) != 6 || result.Installments[5].EndingPrincipalAmount != 0 {
				t.Fatalf("tiny schedule did not close: %+v", result.Installments)
			}
			principal := int64(0)
			for _, row := range result.Installments {
				principal += row.PrincipalAmount
			}
			if principal != 4 {
				t.Fatalf("principal total = %d, want 4", principal)
			}
		})
	}
}

func TestValidationRejectsInvalidInputsAndOverflow(t *testing.T) {
	valid := matrixInput(RepaymentMethodFlat, InputModeRate)
	tests := []struct {
		name   string
		mutate func(*Input)
		kind   error
	}{
		{name: "disbursement mismatch", mutate: func(input *Input) { input.ActualDisbursementAmount-- }, kind: ErrInvalidInput},
		{name: "invalid date", mutate: func(input *Input) { input.FirstDueDate = "2026-02-29" }, kind: ErrInvalidInput},
		{name: "zero terms", mutate: func(input *Input) { input.TermCount = 0 }, kind: ErrInvalidInput},
		{name: "too many terms", mutate: func(input *Input) { input.TermCount = MaxTermCount + 1 }, kind: ErrInvalidInput},
		{name: "rate missing", mutate: func(input *Input) { input.QuotedRatePPTR = nil }, kind: ErrInvalidInput},
		{name: "rate with payment", mutate: func(input *Input) { input.PaymentBasisAmount = pointer(1) }, kind: ErrInvalidInput},
		{name: "negative rate", mutate: func(input *Input) { input.QuotedRatePPTR = pointer(-1) }, kind: ErrInvalidInput},
		{name: "installment non-flat", mutate: func(input *Input) {
			input.RepaymentMethod = RepaymentMethodEqualPayment
			input.RateQuoteType = RateQuoteTypeInstallment
		}, kind: ErrInvalidInput},
		{name: "none discount with amount", mutate: func(input *Input) { input.DiscountAmount = 1 }, kind: ErrInvalidInput},
		{name: "cash discount with rate", mutate: func(input *Input) {
			input.DiscountType = DiscountTypeTotal
			input.DiscountAmount = 1
			input.DiscountRatePPTR = pointer(1)
		}, kind: ErrInvalidInput},
		{name: "rate discount over one", mutate: func(input *Input) {
			input.DiscountType = DiscountTypeInterestRate
			input.DiscountRatePPTR = pointer(PPTRScale + 1)
		}, kind: ErrInvalidInput},
		{name: "upfront consumes principal", mutate: func(input *Input) { input.UpfrontFeeAmount = input.PrincipalAmount; input.ActualDisbursementAmount = 0 }, kind: ErrInvalidInput},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			test.mutate(&input)
			_, err := Calculate(input)
			if !errors.Is(err, test.kind) {
				t.Fatalf("Calculate() error = %v, want %v", err, test.kind)
			}
		})
	}

	t.Run("repayment below principal", func(t *testing.T) {
		input := matrixInput(RepaymentMethodEqualPayment, InputModeRepayment)
		input.PaymentBasisAmount = pointer(1)
		_, err := Calculate(input)
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("Calculate() error = %v, want ErrInvalidInput", err)
		}
	})

	t.Run("quoted rate beyond IRR search returns out of range result", func(t *testing.T) {
		input := matrixInput(RepaymentMethodFlat, InputModeRate)
		input.RateQuoteType = RateQuoteTypeMonthly
		input.QuotedRatePPTR = pointer(MaxIRRPPTR + 1)
		result, err := Calculate(input)
		if err != nil {
			t.Fatalf("Calculate() error = %v", err)
		}
		if result.PeriodicRatePPTR != MaxIRRPPTR+1 || result.IRR.Status != IRRStatusOutOfRange ||
			result.IRR.MonthlyIRRPPTR != nil || result.IRR.SimpleAPRPPTR != nil || result.IRR.EffectiveAPRPPTR != nil {
			t.Fatalf("out-of-range result mismatch: %+v", result)
		}
	})

	t.Run("payment overflow", func(t *testing.T) {
		zeroRate := int64(0)
		input := Input{
			PrincipalAmount:          math.MaxInt64,
			ActualDisbursementAmount: math.MaxInt64,
			PerPeriodFeeAmount:       math.MaxInt64,
			TermCount:                1,
			FirstDueDate:             "2026-01-01",
			InputMode:                InputModeRate,
			RepaymentMethod:          RepaymentMethodFlat,
			RateQuoteType:            RateQuoteTypeMonthly,
			QuotedRatePPTR:           &zeroRate,
			DiscountType:             DiscountTypeNone,
		}
		_, err := Calculate(input)
		if !errors.Is(err, ErrOverflow) {
			t.Fatalf("Calculate() error = %v, want ErrOverflow", err)
		}
	})
}

func TestValidateResultRejectsTampering(t *testing.T) {
	input := matrixInput(RepaymentMethodEqualPrincipal, InputModeRate)
	result, err := Calculate(input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Result)
	}{
		{name: "version", mutate: func(value *Result) { value.CalculationVersion = "other" }},
		{name: "periodic rate", mutate: func(value *Result) { value.PeriodicRatePPTR++ }},
		{name: "due date", mutate: func(value *Result) { value.Installments[1].DueDate = "2026-03-10" }},
		{name: "principal", mutate: func(value *Result) { value.Installments[0].PrincipalAmount++ }},
		{name: "digest", mutate: func(value *Result) { value.ScheduleDigest = "00" }},
		{name: "IRR", mutate: func(value *Result) { (*value.IRR.MonthlyIRRPPTR)++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			copyValue := cloneResult(result)
			test.mutate(&copyValue)
			if err := ValidateResult(input, copyValue); !errors.Is(err, ErrInvalidResult) {
				t.Fatalf("ValidateResult() error = %v, want ErrInvalidResult", err)
			}
		})
	}
}

func TestCalculateConcurrentDeterministic(t *testing.T) {
	input := matrixInput(RepaymentMethodEqualPayment, InputModeRepayment)
	input.DiscountType = DiscountTypeInterestRate
	input.DiscountRatePPTR = pointer(700_000_000_000)
	input.UpfrontFeeAmount = 5_000
	input.ActualDisbursementAmount -= input.UpfrontFeeAmount
	input.PerPeriodFeeAmount = 300
	want, err := Calculate(input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}

	const workers = 32
	errorsChannel := make(chan error, workers)
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			got, err := Calculate(input)
			if err != nil {
				errorsChannel <- err
				return
			}
			if !reflect.DeepEqual(got, want) {
				errorsChannel <- errors.New("concurrent calculation differs")
			}
		}()
	}
	waitGroup.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		t.Fatal(err)
	}
}

func matrixInput(method RepaymentMethod, mode InputMode) Input {
	input := Input{
		PrincipalAmount:          1_000_000,
		ActualDisbursementAmount: 1_000_000,
		TermCount:                12,
		FirstDueDate:             "2026-09-10",
		InputMode:                mode,
		RepaymentMethod:          method,
		DiscountType:             DiscountTypeNone,
	}
	if mode == InputModeRate {
		input.RateQuoteType = RateQuoteTypeAnnual
		input.QuotedRatePPTR = pointer(100_000_000_000)
		return input
	}
	repayments := map[RepaymentMethod]int64{
		RepaymentMethodFlat:           90_000,
		RepaymentMethodEqualPayment:   87_916,
		RepaymentMethodEqualPrincipal: 91_667,
		RepaymentMethodInterestOnly:   8_333,
	}
	input.PaymentBasisAmount = pointer(repayments[method])
	return input
}

func pointer(value int64) *int64 {
	return &value
}

func cloneResult(source Result) Result {
	result := source
	result.Installments = append([]Installment(nil), source.Installments...)
	if source.IRR.MonthlyIRRPPTR != nil {
		result.IRR.MonthlyIRRPPTR = pointer(*source.IRR.MonthlyIRRPPTR)
	}
	if source.IRR.SimpleAPRPPTR != nil {
		result.IRR.SimpleAPRPPTR = pointer(*source.IRR.SimpleAPRPPTR)
	}
	if source.IRR.EffectiveAPRPPTR != nil {
		result.IRR.EffectiveAPRPPTR = pointer(*source.IRR.EffectiveAPRPPTR)
	}
	return result
}
