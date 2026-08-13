package calculation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
)

// ScheduleDigest 对版本名和全部不可变逐期持久字段做长度前缀规范编码。
func ScheduleDigest(installments []Installment) (string, error) {
	hasher := sha256.New()
	writeDigestString(hasher, ScheduleDigestVersion)
	writeDigestInt64(hasher, int64(len(installments)))
	for _, installment := range installments {
		if err := validateDigestInstallment(installment); err != nil {
			return "", err
		}
		writeDigestInt64(hasher, installment.InstallmentNumber)
		writeDigestString(hasher, installment.DueDate)
		writeDigestInt64(hasher, installment.BeginningPrincipalAmount)
		writeDigestInt64(hasher, installment.PrincipalAmount)
		writeDigestInt64(hasher, installment.InterestAmount)
		writeDigestInt64(hasher, installment.FeeAmount)
		writeDigestInt64(hasher, installment.DiscountAmount)
		writeDigestInt64(hasher, installment.PaymentAmount)
		writeDigestInt64(hasher, installment.EndingPrincipalAmount)
		writeDigestInt64(hasher, installment.PreDiscountInterestAmount)
		writeDigestInt64(hasher, installment.PreDiscountFeeAmount)
		writeDigestInt64(hasher, installment.PreDiscountPaymentAmount)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func validateDigestInstallment(installment Installment) error {
	if installment.InstallmentNumber <= 0 {
		return invalidResult("installment_number", "must be positive")
	}
	if _, err := ParseCivilDate(installment.DueDate); err != nil {
		return invalidResult("due_date", "must be a valid civil date")
	}
	amounts := []int64{
		installment.BeginningPrincipalAmount,
		installment.PrincipalAmount,
		installment.InterestAmount,
		installment.FeeAmount,
		installment.DiscountAmount,
		installment.PaymentAmount,
		installment.EndingPrincipalAmount,
		installment.PreDiscountInterestAmount,
		installment.PreDiscountFeeAmount,
		installment.PreDiscountPaymentAmount,
	}
	for _, amount := range amounts {
		if amount < 0 {
			return invalidResult("installment_amount", "must be nonnegative")
		}
	}
	return nil
}

func writeDigestString(hasher hash.Hash, value string) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = hasher.Write(length[:])
	_, _ = hasher.Write([]byte(value))
}

func writeDigestInt64(hasher hash.Hash, value int64) {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	_, _ = hasher.Write(encoded[:])
}
