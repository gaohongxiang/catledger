package api

import (
	"os"
	"strings"
	"testing"
)

func TestDataManagementsDoesNotImportPersonalFinance(t *testing.T) {
	sourceBytes, err := os.ReadFile("data_managements.go")
	if err != nil {
		t.Fatalf("read data managements: %v", err)
	}
	if strings.Contains(string(sourceBytes), "personalfinance") {
		t.Fatal("data_managements.go must not import personalfinance")
	}
}
