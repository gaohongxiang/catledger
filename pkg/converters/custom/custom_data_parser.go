package custom

import "github.com/gaohongxiang/catledger/pkg/core"

// CustomTransactionDataParser represents the parser for custom transaction data files
type CustomTransactionDataParser interface {
	ParseDataLines(ctx core.Context, data []byte) ([][]string, error)
}
