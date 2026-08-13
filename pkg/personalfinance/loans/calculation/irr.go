package calculation

import (
	"fmt"
	"math/big"
)

// SolvePeriodicIRR 对一个正流入、随后均为非正流出的月度等间隔现金流求解。
// NPV 符号全程使用整数多项式计算，不使用二进制浮点。
func SolvePeriodicIRR(cashflows []int64) (IRRResult, error) {
	if len(cashflows) < 2 || cashflows[0] <= 0 {
		return emptyIRR(IRRStatusInsufficientFlows), nil
	}

	hasNegative := false
	for index := 1; index < len(cashflows); index++ {
		if cashflows[index] > 0 {
			return IRRResult{}, invalidCashflows("positive cashflow after initial disbursement")
		}
		if cashflows[index] < 0 {
			hasNegative = true
		}
	}
	if !hasNegative {
		return emptyIRR(IRRStatusInsufficientFlows), nil
	}

	zeroSign := periodicNPVSign(cashflows, 0, PPTRScale)
	if zeroSign == 0 {
		return solvedIRR(0)
	}
	if zeroSign > 0 {
		return emptyIRR(IRRStatusNoNonnegativeRoot), nil
	}

	upperSign := periodicNPVSign(cashflows, MaxIRRPPTR, PPTRScale)
	if upperSign < 0 {
		return emptyIRR(IRRStatusOutOfRange), nil
	}
	if upperSign == 0 {
		return solvedIRR(MaxIRRPPTR)
	}

	lower := int64(0)
	upper := MaxIRRPPTR
	for upper-lower > 1 {
		middle := lower + (upper-lower)/2
		sign := periodicNPVSign(cashflows, middle, PPTRScale)
		if sign == 0 {
			return solvedIRR(middle)
		}
		if sign < 0 {
			lower = middle
		} else {
			upper = middle
		}
	}

	// 在相邻 pptr 之间的半格点再次计算精确符号，实现 half-up。
	halfStepSign := periodicNPVSign(cashflows, lower*2+1, PPTRScale*2)
	monthly := lower
	if halfStepSign <= 0 {
		monthly = upper
	}
	return solvedIRR(monthly)
}

// periodicNPVSign 返回 rateNumerator/rateScale 下 NPV 的精确符号。
// 递推式把所有项归到 (rateScale+rateNumerator)^n 的共同分母。
func periodicNPVSign(cashflows []int64, rateNumerator, rateScale int64) int {
	denominatorBase := big.NewInt(rateScale + rateNumerator)
	scale := big.NewInt(rateScale)
	scalePower := big.NewInt(1)
	numerator := big.NewInt(cashflows[0])

	for index := 1; index < len(cashflows); index++ {
		numerator.Mul(numerator, denominatorBase)
		scalePower.Mul(scalePower, scale)
		term := new(big.Int).Mul(big.NewInt(cashflows[index]), scalePower)
		numerator.Add(numerator, term)
	}
	return numerator.Sign()
}

func emptyIRR(status IRRStatus) IRRResult {
	return IRRResult{Status: status}
}

func solvedIRR(monthly int64) (IRRResult, error) {
	if monthly < 0 || monthly > MaxIRRPPTR {
		return IRRResult{}, fmt.Errorf("%w: monthly IRR", ErrOverflow)
	}

	simple, err := checkedMultiply(monthly, 12, "simple APR")
	if err != nil {
		return IRRResult{}, err
	}
	onePlusMonthly := ratFromFraction(PPTRScale+monthly, PPTRScale)
	effectiveRatio := ratPower(onePlusMonthly, 12)
	effectiveRatio.Sub(effectiveRatio, new(big.Rat).SetInt64(1))
	effective, err := roundRatToPPTR(effectiveRatio, "effective APR")
	if err != nil {
		return IRRResult{}, err
	}

	status := IRRStatusSolved
	if monthly == 0 {
		status = IRRStatusSolvedZero
	}
	return IRRResult{
		Status:           status,
		MonthlyIRRPPTR:   int64Pointer(monthly),
		SimpleAPRPPTR:    int64Pointer(simple),
		EffectiveAPRPPTR: int64Pointer(effective),
	}, nil
}

func int64Pointer(value int64) *int64 {
	result := value
	return &result
}
