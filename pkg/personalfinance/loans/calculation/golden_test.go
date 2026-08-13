package calculation

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type referenceGolden struct {
	Name     string `json:"name"`
	Source   string `json:"source"`
	Input    Input  `json:"input"`
	Expected Result `json:"expected"`
}

func TestReferenceEqualPaymentRepaymentGolden(t *testing.T) {
	contents, err := os.ReadFile("testdata/reference_equal_payment_repayment.json")
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var golden referenceGolden
	if err = json.Unmarshal(contents, &golden); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if golden.Name == "" || golden.Source == "" {
		t.Fatal("reference golden provenance is missing")
	}

	result, err := Calculate(golden.Input)
	if err != nil {
		t.Fatalf("Calculate() error = %v", err)
	}
	if !reflect.DeepEqual(result, golden.Expected) {
		t.Fatalf("reference golden mismatch\ngot:  %#v\nwant: %#v", result, golden.Expected)
	}
}
