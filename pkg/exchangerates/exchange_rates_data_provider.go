package exchangerates

import (
	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

// ExchangeRatesDataProvider defines the structure of exchange rates data provider
type ExchangeRatesDataProvider interface {
	// GetLatestExchangeRates returns the common response entities
	GetLatestExchangeRates(c core.Context, uid int64, currentConfig *settings.Config) (*models.LatestExchangeRateResponse, error)
}
