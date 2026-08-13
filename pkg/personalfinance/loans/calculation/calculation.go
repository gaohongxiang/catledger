package calculation

// Calculate 执行完整的 loan-calculation-v1 纯计算流程。
func Calculate(input Input) (Result, error) {
	if err := ValidateInput(input); err != nil {
		return Result{}, err
	}

	periodicRate, periodicRatePPTR, err := derivePeriodicRate(input)
	if err != nil {
		return Result{}, err
	}
	preDiscountSchedule, err := buildSchedule(input, periodicRate, true)
	if err != nil {
		return Result{}, err
	}
	installments, err := applyDiscount(input, periodicRate, preDiscountSchedule)
	if err != nil {
		return Result{}, err
	}
	result, err := summarize(input, periodicRatePPTR, installments)
	if err != nil {
		return Result{}, err
	}
	if err = ValidateResult(input, result); err != nil {
		return Result{}, err
	}
	return result, nil
}

func summarize(input Input, periodicRatePPTR int64, installments []Installment) (Result, error) {
	preDiscountRowPayments := make([]int64, len(installments))
	interestAmounts := make([]int64, len(installments))
	feeAmounts := make([]int64, len(installments))
	discountAmounts := make([]int64, len(installments))
	rowPayments := make([]int64, len(installments))
	for index, installment := range installments {
		preDiscountRowPayments[index] = installment.PreDiscountPaymentAmount
		interestAmounts[index] = installment.InterestAmount
		feeAmounts[index] = installment.FeeAmount
		discountAmounts[index] = installment.DiscountAmount
		rowPayments[index] = installment.PaymentAmount
	}

	preDiscountRowsTotal, err := sumAmounts(preDiscountRowPayments, "pre-discount row payments")
	if err != nil {
		return Result{}, err
	}
	preDiscountTotalPayment, err := checkedAdd(input.UpfrontFeeAmount, preDiscountRowsTotal, "pre-discount total payment")
	if err != nil {
		return Result{}, err
	}
	if preDiscountTotalPayment < input.PrincipalAmount {
		return Result{}, invalidResult("pre_discount_total_payment_amount", "less than principal")
	}
	totalInterest, err := sumAmounts(interestAmounts, "total interest")
	if err != nil {
		return Result{}, err
	}
	periodicFees, err := sumAmounts(feeAmounts, "periodic fees")
	if err != nil {
		return Result{}, err
	}
	totalFees, err := checkedAdd(input.UpfrontFeeAmount, periodicFees, "total fees")
	if err != nil {
		return Result{}, err
	}
	totalDiscount, err := sumAmounts(discountAmounts, "total discount")
	if err != nil {
		return Result{}, err
	}
	rowPaymentsTotal, err := sumAmounts(rowPayments, "row payments")
	if err != nil {
		return Result{}, err
	}
	totalPayment, err := checkedAdd(input.UpfrontFeeAmount, rowPaymentsTotal, "total payment")
	if err != nil {
		return Result{}, err
	}
	totalCost, err := checkedAdd(totalInterest, totalFees, "total cost")
	if err != nil {
		return Result{}, err
	}
	preDiscountTotalCost := preDiscountTotalPayment - input.PrincipalAmount
	costRatioPPTR, err := ratioToPPTR(totalCost, input.PrincipalAmount, "cost ratio")
	if err != nil {
		return Result{}, err
	}
	digest, err := ScheduleDigest(installments)
	if err != nil {
		return Result{}, err
	}

	cashflows := make([]int64, len(installments)+1)
	cashflows[0] = input.ActualDisbursementAmount
	for index, installment := range installments {
		cashflows[index+1] = -installment.PaymentAmount
	}
	irr, err := SolvePeriodicIRR(cashflows)
	if err != nil {
		return Result{}, err
	}

	return Result{
		CalculationVersion:            CalculationVersion,
		RoundingVersion:               RoundingVersion,
		IRRVersion:                    IRRVersion,
		ActualDisbursementAmount:      input.ActualDisbursementAmount,
		PeriodicRatePPTR:              periodicRatePPTR,
		ScheduleDigest:                digest,
		Installments:                  installments,
		PreDiscountTotalPaymentAmount: preDiscountTotalPayment,
		PreDiscountTotalCostAmount:    preDiscountTotalCost,
		TotalPaymentAmount:            totalPayment,
		TotalInterestAmount:           totalInterest,
		TotalFeeAmount:                totalFees,
		TotalDiscountAmount:           totalDiscount,
		TotalCostAmount:               totalCost,
		CostRatioPPTR:                 costRatioPPTR,
		IRR:                           irr,
	}, nil
}

// ValidateResult 是服务持久化前可复用的强校验，覆盖逐期链、汇总、IRR 与摘要。
func ValidateResult(input Input, result Result) error {
	if err := ValidateInput(input); err != nil {
		return err
	}
	if result.CalculationVersion != CalculationVersion ||
		result.RoundingVersion != RoundingVersion ||
		result.IRRVersion != IRRVersion {
		return invalidResult("version", "unsupported calculation version")
	}
	if result.ActualDisbursementAmount != input.ActualDisbursementAmount {
		return invalidResult("actual_disbursement_amount", "does not match input")
	}
	if int64(len(result.Installments)) != input.TermCount {
		return invalidResult("installments", "term count mismatch")
	}
	expectedPeriodicRate, expectedPeriodicRatePPTR, err := derivePeriodicRate(input)
	if err != nil {
		return err
	}
	if result.PeriodicRatePPTR != expectedPeriodicRatePPTR {
		return invalidResult("periodic_rate_pptr", "does not match input basis")
	}
	expectedPreDiscountSchedule, err := buildSchedule(input, expectedPeriodicRate, true)
	if err != nil {
		return err
	}
	expectedInstallments, err := applyDiscount(input, expectedPeriodicRate, expectedPreDiscountSchedule)
	if err != nil {
		return err
	}
	for index := range expectedInstallments {
		if result.Installments[index] != expectedInstallments[index] {
			return invalidResult("installments", "does not match calculation input")
		}
	}
	anchor, err := ParseCivilDate(input.FirstDueDate)
	if err != nil {
		return err
	}

	principalTotal := int64(0)
	preDiscountPrincipalTotal := int64(0)
	interestTotal := int64(0)
	periodicFeeTotal := int64(0)
	discountTotal := int64(0)
	paymentTotal := int64(0)
	preDiscountPaymentTotal := int64(0)
	previousEnding := input.PrincipalAmount
	for index, installment := range result.Installments {
		if err := validateDigestInstallment(installment); err != nil {
			return err
		}
		if installment.InstallmentNumber != int64(index+1) {
			return invalidResult("installment_number", "must be contiguous")
		}
		expectedDueDate, err := anchor.AddMonths(int64(index))
		if err != nil || installment.DueDate != expectedDueDate.String() {
			return invalidResult("due_date", "does not follow monthly civil-date anchor")
		}
		if installment.BeginningPrincipalAmount != previousEnding {
			return invalidResult("beginning_principal_amount", "does not continue previous ending principal")
		}
		if installment.PrincipalAmount > installment.BeginningPrincipalAmount ||
			installment.EndingPrincipalAmount != installment.BeginningPrincipalAmount-installment.PrincipalAmount {
			return invalidResult("ending_principal_amount", "principal roll-forward mismatch")
		}
		actualCost, err := checkedAdd(installment.InterestAmount, installment.FeeAmount, "validated row cost")
		if err != nil {
			return err
		}
		expectedPayment, err := checkedAdd(installment.PrincipalAmount, actualCost, "validated row payment")
		if err != nil {
			return err
		}
		if installment.PaymentAmount != expectedPayment {
			return invalidResult("payment_amount", "component sum mismatch")
		}
		preDiscountCost, err := checkedAdd(
			installment.PreDiscountInterestAmount,
			installment.PreDiscountFeeAmount,
			"validated pre-discount row cost",
		)
		if err != nil {
			return err
		}
		if installment.PreDiscountPaymentAmount < preDiscountCost {
			return invalidResult("pre_discount_payment_amount", "less than pre-discount cost")
		}
		if actualCost > preDiscountCost || installment.DiscountAmount != preDiscountCost-actualCost {
			return invalidResult("discount_amount", "cost reconciliation mismatch")
		}
		preDiscountPrincipal := installment.PreDiscountPaymentAmount - preDiscountCost

		principalTotal, err = checkedAdd(principalTotal, installment.PrincipalAmount, "validated principal total")
		if err != nil {
			return err
		}
		preDiscountPrincipalTotal, err = checkedAdd(
			preDiscountPrincipalTotal,
			preDiscountPrincipal,
			"validated pre-discount principal total",
		)
		if err != nil {
			return err
		}
		interestTotal, err = checkedAdd(interestTotal, installment.InterestAmount, "validated interest total")
		if err != nil {
			return err
		}
		periodicFeeTotal, err = checkedAdd(periodicFeeTotal, installment.FeeAmount, "validated fee total")
		if err != nil {
			return err
		}
		discountTotal, err = checkedAdd(discountTotal, installment.DiscountAmount, "validated discount total")
		if err != nil {
			return err
		}
		paymentTotal, err = checkedAdd(paymentTotal, installment.PaymentAmount, "validated payment total")
		if err != nil {
			return err
		}
		preDiscountPaymentTotal, err = checkedAdd(
			preDiscountPaymentTotal,
			installment.PreDiscountPaymentAmount,
			"validated pre-discount payment total",
		)
		if err != nil {
			return err
		}
		previousEnding = installment.EndingPrincipalAmount
	}
	if principalTotal != input.PrincipalAmount || preDiscountPrincipalTotal != input.PrincipalAmount || previousEnding != 0 {
		return invalidResult("principal_amount", "principal conservation mismatch")
	}
	periodicAndUpfrontFees, err := checkedAdd(periodicFeeTotal, input.UpfrontFeeAmount, "validated total fees")
	if err != nil {
		return err
	}
	paymentWithUpfront, err := checkedAdd(paymentTotal, input.UpfrontFeeAmount, "validated total payment")
	if err != nil {
		return err
	}
	preDiscountWithUpfront, err := checkedAdd(
		preDiscountPaymentTotal,
		input.UpfrontFeeAmount,
		"validated pre-discount total payment",
	)
	if err != nil {
		return err
	}
	if result.TotalInterestAmount != interestTotal || result.TotalFeeAmount != periodicAndUpfrontFees ||
		result.TotalDiscountAmount != discountTotal || result.TotalPaymentAmount != paymentWithUpfront ||
		result.PreDiscountTotalPaymentAmount != preDiscountWithUpfront {
		return invalidResult("summary", "installment totals mismatch")
	}
	expectedTotalCost, err := checkedAdd(result.TotalInterestAmount, result.TotalFeeAmount, "validated total cost")
	if err != nil {
		return err
	}
	expectedTotalPayment, err := checkedAdd(input.PrincipalAmount, result.TotalCostAmount, "validated principal and cost")
	if err != nil {
		return err
	}
	if result.PreDiscountTotalPaymentAmount < input.PrincipalAmount ||
		result.PreDiscountTotalCostAmount < result.TotalCostAmount {
		return invalidResult("summary", "pre-discount totals are inconsistent")
	}
	if result.TotalCostAmount != expectedTotalCost ||
		result.TotalPaymentAmount != expectedTotalPayment ||
		result.PreDiscountTotalCostAmount != result.PreDiscountTotalPaymentAmount-input.PrincipalAmount ||
		result.PreDiscountTotalCostAmount-result.TotalCostAmount != result.TotalDiscountAmount {
		return invalidResult("summary", "cost reconciliation mismatch")
	}
	expectedCostRatio, err := ratioToPPTR(result.TotalCostAmount, input.PrincipalAmount, "validated cost ratio")
	if err != nil {
		return err
	}
	if result.CostRatioPPTR != expectedCostRatio {
		return invalidResult("cost_ratio_pptr", "does not match total cost")
	}
	expectedDigest, err := ScheduleDigest(result.Installments)
	if err != nil {
		return err
	}
	if result.ScheduleDigest != expectedDigest {
		return invalidResult("schedule_digest", "does not match schedule")
	}
	cashflows := make([]int64, len(result.Installments)+1)
	cashflows[0] = input.ActualDisbursementAmount
	for index, installment := range result.Installments {
		cashflows[index+1] = -installment.PaymentAmount
	}
	expectedIRR, err := SolvePeriodicIRR(cashflows)
	if err != nil {
		return err
	}
	if !equalIRR(expectedIRR, result.IRR) {
		return invalidResult("irr", "does not match actual cashflows")
	}
	return nil
}

func equalIRR(left, right IRRResult) bool {
	return left.Status == right.Status && equalOptionalInt64(left.MonthlyIRRPPTR, right.MonthlyIRRPPTR) &&
		equalOptionalInt64(left.SimpleAPRPPTR, right.SimpleAPRPPTR) &&
		equalOptionalInt64(left.EffectiveAPRPPTR, right.EffectiveAPRPPTR)
}

func equalOptionalInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
