package calculation

import (
	"fmt"
	"math"
	"math/big"
)

var (
	bigOne       = big.NewInt(1)
	bigTwo       = big.NewInt(2)
	bigPPTRScale = big.NewInt(PPTRScale)
)

func checkedAdd(left, right int64, operation string) (int64, error) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, fmt.Errorf("%w: %s", ErrOverflow, operation)
	}
	return left + right, nil
}

func checkedMultiply(left, right int64, operation string) (int64, error) {
	if left < 0 || right < 0 || (left != 0 && right > math.MaxInt64/left) {
		return 0, fmt.Errorf("%w: %s", ErrOverflow, operation)
	}
	return left * right, nil
}

func sumAmounts(values []int64, operation string) (int64, error) {
	total := int64(0)
	for _, value := range values {
		var err error
		total, err = checkedAdd(total, value, operation)
		if err != nil {
			return 0, err
		}
	}
	return total, nil
}

func ratFromInt64(value int64) *big.Rat {
	return new(big.Rat).SetInt64(value)
}

func ratFromFraction(numerator, denominator int64) *big.Rat {
	return new(big.Rat).SetFrac(big.NewInt(numerator), big.NewInt(denominator))
}

func cloneRat(value *big.Rat) *big.Rat {
	return new(big.Rat).Set(value)
}

// roundRatHalfUp 把非负有理数按 half-up 舍入为 int64。
func roundRatHalfUp(value *big.Rat, operation string) (int64, error) {
	if value == nil || value.Sign() < 0 {
		return 0, fmt.Errorf("%w: %s", ErrOverflow, operation)
	}

	numerator := new(big.Int).Set(value.Num())
	denominator := new(big.Int).Set(value.Denom())
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	if new(big.Int).Mul(remainder, bigTwo).Cmp(denominator) >= 0 {
		quotient.Add(quotient, bigOne)
	}
	if !quotient.IsInt64() {
		return 0, fmt.Errorf("%w: %s", ErrOverflow, operation)
	}
	return quotient.Int64(), nil
}

func roundRatToPPTR(value *big.Rat, operation string) (int64, error) {
	scaled := new(big.Rat).Mul(cloneRat(value), new(big.Rat).SetInt(bigPPTRScale))
	return roundRatHalfUp(scaled, operation)
}

func amountTimesRate(amount int64, rate *big.Rat, operation string) (int64, error) {
	product := new(big.Rat).Mul(ratFromInt64(amount), rate)
	return roundRatHalfUp(product, operation)
}

func ratioToPPTR(numerator, denominator int64, operation string) (int64, error) {
	if numerator < 0 || denominator <= 0 {
		return 0, fmt.Errorf("%w: %s", ErrOverflow, operation)
	}
	return roundRatToPPTR(ratFromFraction(numerator, denominator), operation)
}

func ratPower(base *big.Rat, exponent int64) *big.Rat {
	result := new(big.Rat).SetInt64(1)
	factor := cloneRat(base)
	for exponent > 0 {
		if exponent&1 == 1 {
			result.Mul(result, factor)
		}
		exponent >>= 1
		if exponent > 0 {
			factor.Mul(factor, factor)
		}
	}
	return result
}

func annuityPayment(principal, terms int64, rate *big.Rat) (int64, error) {
	if rate.Sign() == 0 {
		return roundRatHalfUp(ratFromFraction(principal, terms), "annuity payment")
	}

	onePlusRate := new(big.Rat).Add(new(big.Rat).SetInt64(1), rate)
	factor := ratPower(onePlusRate, terms)
	denominator := new(big.Rat).Sub(cloneRat(factor), new(big.Rat).SetInt64(1))
	if denominator.Sign() <= 0 {
		return 0, fmt.Errorf("%w: annuity denominator", ErrOverflow)
	}

	numerator := new(big.Rat).Mul(ratFromInt64(principal), rate)
	numerator.Mul(numerator, factor)
	return roundRatHalfUp(new(big.Rat).Quo(numerator, denominator), "annuity payment")
}
