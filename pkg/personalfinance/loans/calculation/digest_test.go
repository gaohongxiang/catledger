package calculation

import (
	"errors"
	"testing"
)

func TestScheduleDigestIsCanonicalAndSensitive(t *testing.T) {
	input := matrixInput(RepaymentMethodFlat, InputModeRate)
	result, err := Calculate(input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}
	first, err := ScheduleDigest(result.Installments)
	if err != nil {
		t.Fatalf("ScheduleDigest() error = %v", err)
	}
	second, err := ScheduleDigest(append([]Installment(nil), result.Installments...))
	if err != nil {
		t.Fatalf("second ScheduleDigest() error = %v", err)
	}
	if first != second || first != result.ScheduleDigest || len(first) != 64 {
		t.Fatalf("digest mismatch: first=%q second=%q result=%q", first, second, result.ScheduleDigest)
	}

	tampered := append([]Installment(nil), result.Installments...)
	tampered[0].InterestAmount++
	changed, err := ScheduleDigest(tampered)
	if err != nil {
		t.Fatalf("tampered ScheduleDigest() error = %v", err)
	}
	if changed == first {
		t.Fatal("digest did not change after schedule mutation")
	}
}

func TestScheduleDigestRejectsInvalidSchedule(t *testing.T) {
	_, err := ScheduleDigest([]Installment{{
		InstallmentNumber: 1,
		DueDate:           "2026-01-01",
		InterestAmount:    -1,
	}})
	if !errors.Is(err, ErrInvalidResult) {
		t.Fatalf("ScheduleDigest() error = %v, want ErrInvalidResult", err)
	}
}
