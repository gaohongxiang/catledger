package calculation

import (
	"fmt"
	"math/big"
)

type scheduleRow struct {
	InstallmentNumber        int64
	DueDate                  string
	BeginningPrincipalAmount int64
	PrincipalAmount          int64
	InterestAmount           int64
	FeeAmount                int64
	PaymentAmount            int64
	EndingPrincipalAmount    int64
}

func buildSchedule(input Input, rate *big.Rat, honorRepayment bool) ([]scheduleRow, error) {
	anchor, err := ParseCivilDate(input.FirstDueDate)
	if err != nil {
		return nil, invalidInput("first_due_date", "must be a valid civil date")
	}

	balance := input.PrincipalAmount
	rows := make([]scheduleRow, 0, input.TermCount)
	principalPerPeriod, err := roundRatHalfUp(
		ratFromFraction(input.PrincipalAmount, input.TermCount),
		"principal per period",
	)
	if err != nil {
		return nil, err
	}
	equalPayment, err := annuityPayment(input.PrincipalAmount, input.TermCount, rate)
	if err != nil {
		return nil, err
	}
	totalFixedInterest, err := totalFixedInterest(input, rate, honorRepayment)
	if err != nil {
		return nil, err
	}
	interestPaid := int64(0)
	enteredPayment := int64(0)
	if honorRepayment && input.InputMode == InputModeRepayment {
		enteredPayment = *input.PaymentBasisAmount
		if input.RepaymentMethod == RepaymentMethodEqualPayment {
			equalPayment = enteredPayment
		}
	}

	for installmentNumber := int64(1); installmentNumber <= input.TermCount; installmentNumber++ {
		dueDate, err := anchor.AddMonths(installmentNumber - 1)
		if err != nil {
			return nil, invalidInput("first_due_date", "schedule exceeds civil date range")
		}
		last := installmentNumber == input.TermCount
		principalAmount, interestAmount, err := scheduleComponents(
			input,
			rate,
			balance,
			principalPerPeriod,
			equalPayment,
			totalFixedInterest,
			interestPaid,
			enteredPayment,
			installmentNumber,
			last,
			honorRepayment,
		)
		if err != nil {
			return nil, err
		}
		if principalAmount < 0 || principalAmount > balance || interestAmount < 0 {
			return nil, invalidInput("payment_basis_amount", "cannot generate a nonnegative schedule")
		}

		endingPrincipal := balance - principalAmount
		if last {
			endingPrincipal = 0
		}
		paymentAmount, err := sumAmounts(
			[]int64{principalAmount, interestAmount, input.PerPeriodFeeAmount},
			"installment payment",
		)
		if err != nil {
			return nil, err
		}
		rows = append(rows, scheduleRow{
			InstallmentNumber:        installmentNumber,
			DueDate:                  dueDate.String(),
			BeginningPrincipalAmount: balance,
			PrincipalAmount:          principalAmount,
			InterestAmount:           interestAmount,
			FeeAmount:                input.PerPeriodFeeAmount,
			PaymentAmount:            paymentAmount,
			EndingPrincipalAmount:    endingPrincipal,
		})

		interestPaid, err = checkedAdd(interestPaid, interestAmount, "fixed interest paid")
		if err != nil {
			return nil, err
		}
		balance = endingPrincipal
	}
	return rows, nil
}

func totalFixedInterest(input Input, rate *big.Rat, honorRepayment bool) (int64, error) {
	if input.RepaymentMethod != RepaymentMethodFlat && input.RepaymentMethod != RepaymentMethodInterestOnly {
		return 0, nil
	}
	if honorRepayment && input.InputMode == InputModeRepayment {
		totalEntered, err := checkedMultiply(*input.PaymentBasisAmount, input.TermCount, "fixed repayment total")
		if err != nil {
			return 0, err
		}
		if input.RepaymentMethod == RepaymentMethodFlat {
			return totalEntered - input.PrincipalAmount, nil
		}
		return totalEntered, nil
	}

	perPeriodInterest := new(big.Rat).Mul(ratFromInt64(input.PrincipalAmount), rate)
	total := new(big.Rat).Mul(perPeriodInterest, ratFromInt64(input.TermCount))
	return roundRatHalfUp(total, "fixed total interest")
}

func scheduleComponents(
	input Input,
	rate *big.Rat,
	balance int64,
	principalPerPeriod int64,
	equalPayment int64,
	totalFixedInterest int64,
	interestPaid int64,
	enteredPayment int64,
	installmentNumber int64,
	last bool,
	honorRepayment bool,
) (int64, int64, error) {
	var principalAmount int64
	var interestAmount int64
	var err error

	switch input.RepaymentMethod {
	case RepaymentMethodEqualPayment:
		interestAmount, err = amountTimesRate(balance, rate, "equal payment interest")
		if err != nil {
			return 0, 0, err
		}
		if last {
			principalAmount = balance
		} else {
			principalAmount = equalPayment - interestAmount
			if principalAmount < 0 || principalAmount > balance {
				return 0, 0, invalidInput("payment_basis_amount", "cannot amortize principal")
			}
		}
	case RepaymentMethodEqualPrincipal:
		principalAmount = principalPerPeriod
		if last {
			principalAmount = balance
		} else {
			principalAmount = minInt64(principalAmount, balance)
		}
		interestAmount, err = amountTimesRate(balance, rate, "equal principal interest")
		if err != nil {
			return 0, 0, err
		}
		if honorRepayment && input.InputMode == InputModeRepayment && installmentNumber == 1 {
			interestAmount = enteredPayment - principalAmount
		}
	case RepaymentMethodInterestOnly:
		if last {
			principalAmount = balance
			interestAmount = totalFixedInterest - interestPaid
		} else {
			interestAmount, err = amountTimesRate(input.PrincipalAmount, rate, "interest only interest")
			if err != nil {
				return 0, 0, err
			}
		}
	case RepaymentMethodFlat:
		principalAmount = principalPerPeriod
		if last {
			principalAmount = balance
			interestAmount = totalFixedInterest - interestPaid
		} else {
			principalAmount = minInt64(principalAmount, balance)
			interestAmount, err = amountTimesRate(input.PrincipalAmount, rate, "flat interest")
			if err != nil {
				return 0, 0, err
			}
		}
	default:
		return 0, 0, fmt.Errorf("%w: repayment method", ErrInvalidInput)
	}
	return principalAmount, interestAmount, nil
}

func applyDiscount(input Input, rate *big.Rat, preDiscount []scheduleRow) ([]Installment, error) {
	actual := preDiscount
	if input.DiscountType == DiscountTypeInterestRate && *input.DiscountRatePPTR != PPTRScale {
		discountRate := ratFromFraction(*input.DiscountRatePPTR, PPTRScale)
		actualRate := new(big.Rat).Mul(cloneRat(rate), discountRate)
		var err error
		actual, err = buildSchedule(input, actualRate, false)
		if err != nil {
			return nil, err
		}
	}
	if len(actual) != len(preDiscount) {
		return nil, invalidResult("installments", "discount schedule length differs")
	}

	allocations, err := cashDiscountAllocations(input, preDiscount)
	if err != nil {
		return nil, err
	}
	installments := make([]Installment, len(actual))
	for index := range actual {
		row := actual[index]
		pre := preDiscount[index]
		discountAmount := int64(0)
		if input.DiscountType == DiscountTypeInterestRate {
			preCost, err := checkedAdd(pre.InterestAmount, pre.FeeAmount, "pre-discount cost")
			if err != nil {
				return nil, err
			}
			actualCost, err := checkedAdd(row.InterestAmount, row.FeeAmount, "discounted cost")
			if err != nil {
				return nil, err
			}
			if actualCost > preCost {
				return nil, invalidResult("discount_amount", "interest rate discount raised cost")
			}
			discountAmount = preCost - actualCost
		} else if input.DiscountType == DiscountTypePerPeriod || input.DiscountType == DiscountTypeTotal {
			discountAmount = allocations[index]
			feeReduction := minInt64(row.FeeAmount, discountAmount)
			interestReduction := discountAmount - feeReduction
			row.FeeAmount -= feeReduction
			row.InterestAmount -= interestReduction
			row.PaymentAmount, err = sumAmounts(
				[]int64{row.PrincipalAmount, row.InterestAmount, row.FeeAmount},
				"discounted payment",
			)
			if err != nil {
				return nil, err
			}
		}

		installments[index] = Installment{
			InstallmentNumber:         row.InstallmentNumber,
			DueDate:                   row.DueDate,
			BeginningPrincipalAmount:  row.BeginningPrincipalAmount,
			PrincipalAmount:           row.PrincipalAmount,
			InterestAmount:            row.InterestAmount,
			FeeAmount:                 row.FeeAmount,
			DiscountAmount:            discountAmount,
			PaymentAmount:             row.PaymentAmount,
			EndingPrincipalAmount:     row.EndingPrincipalAmount,
			PreDiscountInterestAmount: pre.InterestAmount,
			PreDiscountFeeAmount:      pre.FeeAmount,
			PreDiscountPaymentAmount:  pre.PaymentAmount,
		}
	}
	return installments, nil
}

func cashDiscountAllocations(input Input, schedule []scheduleRow) ([]int64, error) {
	allocations := make([]int64, len(schedule))
	if input.DiscountType != DiscountTypePerPeriod && input.DiscountType != DiscountTypeTotal {
		return allocations, nil
	}

	costs := make([]int64, len(schedule))
	for index, row := range schedule {
		cost, err := checkedAdd(row.InterestAmount, row.FeeAmount, "pre-discount row cost")
		if err != nil {
			return nil, err
		}
		costs[index] = cost
	}
	if input.DiscountType == DiscountTypePerPeriod {
		for index, cost := range costs {
			allocations[index] = minInt64(cost, input.DiscountAmount)
		}
		return allocations, nil
	}

	totalCost, err := sumAmounts(costs, "pre-discount total cost")
	if err != nil {
		return nil, err
	}
	totalDiscount := minInt64(totalCost, input.DiscountAmount)
	if totalDiscount == 0 {
		return allocations, nil
	}

	remainingDiscount := totalDiscount
	for index, cost := range costs {
		if index == len(costs)-1 {
			break
		}
		allocation, err := roundRatHalfUp(
			ratFromFractionBig(
				new(big.Int).Mul(big.NewInt(totalDiscount), big.NewInt(cost)),
				big.NewInt(totalCost),
			),
			"total discount allocation",
		)
		if err != nil {
			return nil, err
		}
		allocation = minInt64(allocation, cost)
		allocation = minInt64(allocation, remainingDiscount)
		allocations[index] = allocation
		remainingDiscount -= allocation
	}

	last := len(costs) - 1
	allocations[last] = minInt64(remainingDiscount, costs[last])
	remainingDiscount -= allocations[last]
	// 极端小额矩阵中，前期比例项可能全部向下舍入，使尾差超过末期成本。
	// 这种情况下从后向前使用尚余成本容量，仍保证不减少本金且总额守恒。
	for index := last - 1; index >= 0 && remainingDiscount > 0; index-- {
		capacity := costs[index] - allocations[index]
		addition := minInt64(capacity, remainingDiscount)
		allocations[index] += addition
		remainingDiscount -= addition
	}
	if remainingDiscount != 0 {
		return nil, invalidResult("discount_amount", "cannot allocate total discount")
	}
	return allocations, nil
}

func ratFromFractionBig(numerator, denominator *big.Int) *big.Rat {
	return new(big.Rat).SetFrac(numerator, denominator)
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
