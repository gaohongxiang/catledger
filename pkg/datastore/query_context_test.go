package datastore

import (
	"context"
	"testing"

	"xorm.io/xorm/log"

	"github.com/gaohongxiang/catledger/pkg/core"
)

func TestPrivacyXOrmContextDisablesSQLLogging(t *testing.T) {
	regular := NewXOrmContextAdapter(nil)

	if value := regular.Value(log.SessionShowSQLKey); value != nil {
		t.Fatalf("regular context unexpectedly overrides SQL logging: %v", value)
	}

	privacy := NewPrivacyXOrmContextAdapter(nil)

	if value, ok := privacy.Value(log.SessionShowSQLKey).(bool); !ok || value {
		t.Fatalf("privacy context did not disable SQL logging: %v", privacy.Value(log.SessionShowSQLKey))
	}
}

func TestXOrmContextForwardsCancellationAndValues(t *testing.T) {
	type contextKey string
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey("key"), "value"))
	wrapped := &core.NullContext{Context: parent}
	adapter := NewXOrmContextAdapter(wrapped)

	if value := adapter.Value(contextKey("key")); value != "value" {
		t.Fatalf("parent context value was not forwarded: %v", value)
	}

	cancel()
	<-adapter.Done()

	if adapter.Err() != context.Canceled {
		t.Fatalf("parent cancellation was not forwarded: %v", adapter.Err())
	}
}
