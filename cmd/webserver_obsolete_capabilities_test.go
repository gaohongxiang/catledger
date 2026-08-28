package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestRemovedCapabilitiesAreNotRegistered(t *testing.T) {
	webserverBytes, err := os.ReadFile("webserver.go")
	if err != nil {
		t.Fatalf("read webserver routes: %v", err)
	}

	webserver := string(webserverBytes)
	removedRoutePrefixes := []string{
		`"/insights/explorers/`,
		`"/transaction/templates/`,
	}

	for _, prefix := range removedRoutePrefixes {
		if strings.Contains(webserver, prefix) {
			t.Fatalf("removed capability route %s is still registered", prefix)
		}
	}

	cronBytes, err := os.ReadFile("../pkg/cron/cron_container.go")
	if err != nil {
		t.Fatalf("read cron registration: %v", err)
	}

	if strings.Contains(string(cronBytes), "registerIntervalJob(ctx, CreateScheduledTransactionJob)") {
		t.Fatal("scheduled transaction cron job is still registered")
	}

	databaseBytes, err := os.ReadFile("database.go")
	if err != nil {
		t.Fatalf("read database setup: %v", err)
	}

	if strings.Contains(string(databaseBytes), "new(models.InsightsExplorer)") {
		t.Fatal("new databases still create the removed insights explorer table")
	}
}
