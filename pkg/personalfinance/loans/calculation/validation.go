package calculation

import (
	"math/big"
)

// ValidateInput 强制执行 loan-calculation-v1 的互斥字段和数值边界。
func ValidateInput(input Input) error {
	if input.PrincipalAmount <= 0 {
		return invalidInput("principal_amount", "must be positive")
	}
	if input.UpfrontFeeAmount < 0 || input.UpfrontFeeAmount >= input.PrincipalAmount {
		return invalidInput("upfront_fee_amount", "must be nonnegative and less than principal")
	}
	if input.PerPeriodFeeAmount < 0 {
		return invalidInput("per_period_fee_amount", "must be nonnegative")
	}
	expectedDisbursement := input.PrincipalAmount - input.UpfrontFeeAmount
	if input.ActualDisbursementAmount != expectedDisbursement || input.ActualDisbursementAmount <= 0 {
		return invalidInput("actual_disbursement_amount", "must equal principal less upfront fee")
	}
	if input.TermCount <= 0 || input.TermCount > MaxTermCount {
		return invalidInput("term_count", "outside supported monthly range")
	}
	firstDueDate, err := ParseCivilDate(input.FirstDueDate)
	if err != nil {
		return invalidInput("first_due_date", "must be a valid YYYY-MM-DD civil date")
	}
	if _, err = firstDueDate.AddMonths(input.TermCount - 1); err != nil {
		return invalidInput("first_due_date", "schedule exceeds civil date range")
	}

	switch input.RepaymentMethod {
	case RepaymentMethodFlat, RepaymentMethodEqualPayment,
		RepaymentMethodEqualPrincipal, RepaymentMethodInterestOnly:
	default:
		return invalidInput("repayment_method", "unsupported value")
	}

	switch input.InputMode {
	case InputModeRate:
		if input.QuotedRatePPTR == nil || input.PaymentBasisAmount != nil {
			return invalidInput("input_mode", "rate basis requires only quoted rate")
		}
		if *input.QuotedRatePPTR < 0 {
			return invalidInput("quoted_rate_pptr", "must be nonnegative")
		}
		switch input.RateQuoteType {
		case RateQuoteTypeAnnual, RateQuoteTypeMonthly, RateQuoteTypeDaily:
		case RateQuoteTypeInstallment:
			if input.RepaymentMethod != RepaymentMethodFlat {
				return invalidInput("rate_quote_type", "installment quote requires flat repayment")
			}
		default:
			return invalidInput("rate_quote_type", "unsupported value")
		}
	case InputModeRepayment:
		if input.PaymentBasisAmount == nil || input.QuotedRatePPTR != nil {
			return invalidInput("input_mode", "repayment basis requires only payment amount")
		}
		if input.RateQuoteType != "" {
			return invalidInput("rate_quote_type", "must be empty for repayment basis")
		}
		if *input.PaymentBasisAmount < 0 {
			return invalidInput("payment_basis_amount", "must be nonnegative")
		}
		if err = validateRepaymentBasis(input); err != nil {
			return err
		}
	default:
		return invalidInput("input_mode", "unsupported value")
	}

	switch input.DiscountType {
	case DiscountTypeNone:
		if input.DiscountRatePPTR != nil || input.DiscountAmount != 0 {
			return invalidInput("discount_type", "none requires null rate and zero amount")
		}
	case DiscountTypeInterestRate:
		if input.DiscountRatePPTR == nil || input.DiscountAmount != 0 {
			return invalidInput("discount_type", "interest rate discount requires only a rate")
		}
		if *input.DiscountRatePPTR <= 0 || *input.DiscountRatePPTR > PPTRScale {
			return invalidInput("discount_rate_pptr", "must be within (0, 1.0]")
		}
	case DiscountTypePerPeriod, DiscountTypeTotal:
		if input.DiscountRatePPTR != nil || input.DiscountAmount <= 0 {
			return invalidInput("discount_type", "cash discount requires only a positive amount")
		}
	default:
		return invalidInput("discount_type", "unsupported value")
	}
	return nil
}

func validateRepaymentBasis(input Input) error {
	payment := *input.PaymentBasisAmount
	principalPerPeriod, err := roundRatHalfUp(
		ratFromFraction(input.PrincipalAmount, input.TermCount),
		"repayment principal per period",
	)
	if err != nil {
		return err
	}

	switch input.RepaymentMethod {
	case RepaymentMethodFlat, RepaymentMethodEqualPrincipal:
		if payment < principalPerPeriod {
			return invalidInput("payment_basis_amount", "must cover first-period principal")
		}
	case RepaymentMethodEqualPayment:
		if payment <= 0 {
			return invalidInput("payment_basis_amount", "must be positive")
		}
		total, err := checkedMultiply(payment, input.TermCount, "repayment basis total")
		if err != nil {
			return err
		}
		if total < input.PrincipalAmount {
			return invalidInput("payment_basis_amount", "has no nonnegative inferred rate")
		}
	case RepaymentMethodInterestOnly:
		// 零利息先息后本是 periodic-irr-v1 的合法 solved_zero 场景。
	}
	return nil
}

func quotedPeriodicRate(quoted int64, quoteType RateQuoteType) *big.Rat {
	rate := ratFromFraction(quoted, PPTRScale)
	switch quoteType {
	case RateQuoteTypeAnnual:
		return new(big.Rat).Quo(rate, new(big.Rat).SetInt64(12))
	case RateQuoteTypeDaily:
		return new(big.Rat).Mul(rate, new(big.Rat).SetInt64(30))
	default:
		return rate
	}
}

func derivePeriodicRate(input Input) (*big.Rat, int64, error) {
	if input.InputMode == InputModeRate {
		rate := quotedPeriodicRate(*input.QuotedRatePPTR, input.RateQuoteType)
		pptr, err := roundRatToPPTR(rate, "quoted periodic rate")
		return rate, pptr, err
	}

	payment := *input.PaymentBasisAmount
	var rate *big.Rat
	switch input.RepaymentMethod {
	case RepaymentMethodFlat:
		totalPayments, err := checkedMultiply(payment, input.TermCount, "flat repayment total")
		if err != nil {
			return nil, 0, err
		}
		totalInterest := totalPayments - input.PrincipalAmount
		denominator := new(big.Int).Mul(big.NewInt(input.PrincipalAmount), big.NewInt(input.TermCount))
		rate = new(big.Rat).SetFrac(big.NewInt(totalInterest), denominator)
	case RepaymentMethodEqualPayment:
		cashflows := make([]int64, input.TermCount+1)
		cashflows[0] = input.PrincipalAmount
		for index := 1; index < len(cashflows); index++ {
			cashflows[index] = -payment
		}
		inferred, err := SolvePeriodicIRR(cashflows)
		if err != nil {
			return nil, 0, err
		}
		if inferred.Status != IRRStatusSolved && inferred.Status != IRRStatusSolvedZero {
			reason := "has no nonnegative inferred rate"
			if inferred.Status == IRRStatusOutOfRange {
				reason = "inferred rate exceeds supported range"
			}
			return nil, 0, invalidInput("payment_basis_amount", reason)
		}
		rate = ratFromFraction(*inferred.MonthlyIRRPPTR, PPTRScale)
	case RepaymentMethodEqualPrincipal:
		principalPerPeriod, err := roundRatHalfUp(
			ratFromFraction(input.PrincipalAmount, input.TermCount),
			"equal principal repayment principal",
		)
		if err != nil {
			return nil, 0, err
		}
		rate = ratFromFraction(payment-principalPerPeriod, input.PrincipalAmount)
	case RepaymentMethodInterestOnly:
		rate = ratFromFraction(payment, input.PrincipalAmount)
	}

	if rate == nil || rate.Sign() < 0 {
		return nil, 0, invalidInput("payment_basis_amount", "has no nonnegative inferred rate")
	}
	pptr, err := roundRatToPPTR(rate, "inferred periodic rate")
	if err != nil {
		return nil, 0, err
	}
	return rate, pptr, nil
}
