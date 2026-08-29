package exchangerates

import (
	"sort"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/settings"
	"github.com/gaohongxiang/catledger/pkg/validators"
)

const userDataSourceType = "user_custom"

// UserCustomExchangeRatesDataProvider defines the structure of user custom exchange rates data provider
type UserCustomExchangeRatesDataProvider struct {
	ExchangeRatesDataProvider
	users                   *services.UserService
	userCustomExchangeRates *services.UserCustomExchangeRatesService
}

func (e *UserCustomExchangeRatesDataProvider) GetLatestExchangeRates(c core.Context, uid int64, currentConfig *settings.Config) (*models.LatestExchangeRateResponse, error) {
	user, err := e.users.GetUserById(c, uid)

	if err != nil {
		log.Errorf(c, "[user_custom_data_provider.GetLatestExchangeRates] failed to get user \"uid:%d\", because %s", uid, err.Error())
		return nil, errs.Or(err, errs.ErrOperationFailed)
	}

	customExchangeRates, err := e.userCustomExchangeRates.GetAllCustomExchangeRatesByUid(c, uid)

	if err != nil {
		log.Errorf(c, "[user_custom_data_provider.GetLatestExchangeRates] failed to get user custom exchange rates for user \"uid:%d\", because %s", uid, err.Error())
		return nil, errs.Or(err, errs.ErrOperationFailed)
	}

	baseCurrencyRate := int64(0)
	hasDefaultCurrencyRate := false

	for i := 0; i < len(customExchangeRates); i++ {
		customExchangeRate := customExchangeRates[i]

		if customExchangeRate.Currency == user.DefaultCurrency {
			baseCurrencyRate = customExchangeRate.Rate
			hasDefaultCurrencyRate = true
			break
		}
	}

	allExchangeRates := make(models.LatestExchangeRateSlice, 0, len(customExchangeRates))
	latestUpdateTime := int64(0)

	for i := 0; i < len(customExchangeRates); i++ {
		customExchangeRate := customExchangeRates[i]

		if _, exists := validators.AllCurrencyNames[customExchangeRate.Currency]; !exists {
			continue
		}

		if customExchangeRate.UpdatedUnixTime > latestUpdateTime {
			latestUpdateTime = customExchangeRate.UpdatedUnixTime
		}

		if hasDefaultCurrencyRate && baseCurrencyRate > 0 {
			allExchangeRates = append(allExchangeRates, customExchangeRate.ToLatestExchangeRate(baseCurrencyRate))
		}
	}

	sort.Sort(allExchangeRates)

	if latestUpdateTime < 1 {
		latestUpdateTime = time.Now().Unix()
	}

	if !hasDefaultCurrencyRate {
		allExchangeRates = append(allExchangeRates, &models.LatestExchangeRate{
			Currency: user.DefaultCurrency,
			Rate:     "1",
		})
	}

	finalExchangeRateResponse := &models.LatestExchangeRateResponse{
		DataSource:    userDataSourceType,
		ReferenceUrl:  "",
		UpdateTime:    latestUpdateTime,
		BaseCurrency:  user.DefaultCurrency,
		ExchangeRates: allExchangeRates,
	}

	return finalExchangeRateResponse, nil
}

func newUserCustomExchangeRatesDataProvider() *UserCustomExchangeRatesDataProvider {
	return &UserCustomExchangeRatesDataProvider{
		users:                   services.Users,
		userCustomExchangeRates: services.UserCustomExchangeRates,
	}
}
