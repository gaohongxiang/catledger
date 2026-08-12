package datastore

import (
	"context"
	"fmt"
	"time"

	"xorm.io/xorm/log"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

// XOrmContextAdapter represents the context adapter for xorm
type XOrmContextAdapter struct {
	requestId       string
	disableQueryLog bool
	parent          context.Context
}

// Deadline forwards the caller's cancellation deadline.
func (c *XOrmContextAdapter) Deadline() (deadline time.Time, ok bool) {
	if c.parent == nil {
		return time.Time{}, false
	}

	return c.parent.Deadline()
}

// Done forwards caller cancellation to database drivers.
func (c *XOrmContextAdapter) Done() <-chan struct{} {
	if c.parent == nil {
		return nil
	}

	return c.parent.Done()
}

// Err returns the caller context error.
func (c *XOrmContextAdapter) Err() error {
	if c.parent == nil {
		return nil
	}

	return c.parent.Err()
}

// Value returns the value associated with this context for key, or nil
// if no value is associated with key.
func (c *XOrmContextAdapter) Value(key any) any {
	if key == log.SessionIDKey && c.requestId != "" {
		return fmt.Sprintf("%s", c.requestId)
	}

	if key == log.SessionShowSQLKey && c.disableQueryLog {
		return false
	}

	if c.parent != nil {
		return c.parent.Value(key)
	}

	return nil
}

// NewPrivacyXOrmContextAdapter disables SQL argument logging for sensitive data sessions.
func NewPrivacyXOrmContextAdapter(c core.Context) *XOrmContextAdapter {
	adapter := NewXOrmContextAdapter(c)
	adapter.disableQueryLog = true
	return adapter
}

func NewXOrmContextAdapter(c core.Context) *XOrmContextAdapter {
	if c != nil {
		return &XOrmContextAdapter{
			requestId: c.GetContextId(),
			parent:    c,
		}
	}

	return &XOrmContextAdapter{}
}
