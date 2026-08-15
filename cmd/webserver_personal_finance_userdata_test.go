package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestPersonalFinanceUserDataHooksAreRegisteredOnceAndStopStartupOnFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver startup: %v", err)
	}
	source := string(sourceBytes)
	cardCycleInit := strings.Index(source, "err = api.InitializePersonalFinanceCardCycleApi()")
	hookInitText := "err = api.RegisterPersonalFinanceUserDataHooks()"
	hookInit := strings.Index(source, hookInitText)
	requestId := strings.Index(source, "err = requestid.InitializeRequestIdGenerator")
	if cardCycleInit < 0 || hookInit < 0 || requestId < 0 || cardCycleInit > hookInit || hookInit > requestId ||
		strings.Count(source, hookInitText) != 1 {
		t.Fatal("personal finance user data hook composition order is invalid")
	}
	guard := source[hookInit:requestId]
	if !strings.Contains(guard, "if err != nil {") || !strings.Contains(guard, "return err") {
		t.Fatal("personal finance user data hook failure does not stop startup")
	}

	managementBytes, err := os.ReadFile("../pkg/api/data_managements.go")
	if err != nil {
		t.Fatalf("read data managements: %v", err)
	}
	if strings.Contains(string(managementBytes), "personalfinance") {
		t.Fatal("data_managements.go must not import personalfinance")
	}
}
