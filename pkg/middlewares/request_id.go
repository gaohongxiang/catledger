package middlewares

import (
	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/requestid"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

const requestIdHeader = "X-Request-ID"

// RequestId generates a new request id and add it to context and response header
func RequestId(config *settings.Config) core.MiddlewareHandlerFunc {
	return func(c *core.WebContext) {
		requestId := requestid.Container.GenerateRequestId(c.ClientIP(), c.ClientPort())
		c.SetContextId(requestId)

		if config.EnableRequestIdHeader {
			c.Header(requestIdHeader, requestId)
		}

		c.Next()
	}
}
