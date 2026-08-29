package cmd

import (
	"encoding/json"
	"os"

	"github.com/gaohongxiang/catledger/pkg/avatars"
	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/duplicatechecker"
	"github.com/gaohongxiang/catledger/pkg/exchangerates"
	"github.com/gaohongxiang/catledger/pkg/llm"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/mail"
	"github.com/gaohongxiang/catledger/pkg/settings"
	"github.com/gaohongxiang/catledger/pkg/storage"
	"github.com/gaohongxiang/catledger/pkg/utils"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

func initializeSystem(c *core.CliContext) (*settings.Config, error) {
	var err error
	configFilePath := c.String("conf-path")
	isDisableBootLog := c.Bool("no-boot-log")

	if configFilePath != "" {
		if _, err = os.Stat(configFilePath); err != nil {
			if !isDisableBootLog {
				log.BootErrorf(c, "[initializer.initializeSystem] cannot load configuration from custom config path %s, because file not exists", configFilePath)
			}
			return nil, err
		}

		if !isDisableBootLog {
			log.BootInfof(c, "[initializer.initializeSystem] will loading configuration from custom config path %s", configFilePath)
		}
	} else {
		configFilePath, err = settings.GetDefaultConfigFilePath()

		if err != nil {
			if !isDisableBootLog {
				log.BootErrorf(c, "[initializer.initializeSystem] cannot get default configuration path, because %s", err.Error())
			}
			return nil, err
		}

		if !isDisableBootLog {
			log.BootInfof(c, "[initializer.initializeSystem] will load configuration from default config path %s", configFilePath)
		}
	}

	config, err := settings.LoadConfiguration(configFilePath)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] cannot load configuration, because %s", err.Error())
		}
		return nil, err
	}

	if config.SecretKeyNoSet {
		log.BootWarnf(c, "[initializer.initializeSystem] \"secret_key\" in config file is not set, please change it to keep your user data safe")
	}

	settings.SetCurrentConfig(config)

	err = datastore.InitializeDataStore(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes data store failed, because %s", err.Error())
		}
		return nil, err
	}

	err = log.SetLoggerConfiguration(config, isDisableBootLog)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] sets logger configuration failed, because %s", err.Error())
		}
		return nil, err
	}

	err = storage.InitializeStorageContainer(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes object storage failed, because %s", err.Error())
		}
		return nil, err
	}

	err = llm.InitializeLargeLanguageModelProvider(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes large language model provider failed, because %s", err.Error())
		}
		return nil, err
	}

	err = uuid.InitializeUuidGenerator(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes uuid generator failed, because %s", err.Error())
		}
		return nil, err
	}

	err = duplicatechecker.InitializeDuplicateChecker(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes duplicate checker failed, because %s", err.Error())
		}
		return nil, err
	}

	err = avatars.InitializeAvatarProvider(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes avatar provider failed, because %s", err.Error())
		}
		return nil, err
	}

	err = mail.InitializeMailer(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes mailer failed, because %s", err.Error())
		}
		return nil, err
	}

	err = exchangerates.InitializeExchangeRatesDataSource(config)

	if err != nil {
		if !isDisableBootLog {
			log.BootErrorf(c, "[initializer.initializeSystem] initializes exchange rates data source failed, because %s", err.Error())
		}
		return nil, err
	}

	cfgJson, _ := json.Marshal(getConfigWithoutSensitiveData(config))

	if !isDisableBootLog {
		log.BootInfof(c, "[initializer.initializeSystem] has loaded configuration %s", cfgJson)
	}

	return config, nil
}

func getConfigWithoutSensitiveData(config *settings.Config) *settings.Config {
	clonedConfig := &settings.Config{}
	err := utils.Clone(config, clonedConfig)

	if err != nil {
		return config
	}

	if clonedConfig.DatabaseConfig.DatabasePassword != "" {
		clonedConfig.DatabaseConfig.DatabasePassword = "****"
	}

	if clonedConfig.SMTPConfig.SMTPPasswd != "" {
		clonedConfig.SMTPConfig.SMTPPasswd = "****"
	}

	if clonedConfig.MinIOConfig.SecretAccessKey != "" {
		clonedConfig.MinIOConfig.SecretAccessKey = "****"
	}

	if clonedConfig.SecretKey != "" {
		clonedConfig.SecretKey = "****"
	}

	if clonedConfig.AmapApplicationSecret != "" {
		clonedConfig.AmapApplicationSecret = "****"
	}

	if clonedConfig.WebDAVConfig != nil && clonedConfig.WebDAVConfig.Password != "" {
		clonedConfig.WebDAVConfig.Password = "****"
	}

	if clonedConfig.TextRecognitionLLMConfig != nil {
		removeSensitiveDataFromLLMConfig(clonedConfig.TextRecognitionLLMConfig)
	}

	if clonedConfig.ReceiptImageRecognitionLLMConfig != nil {
		removeSensitiveDataFromLLMConfig(clonedConfig.ReceiptImageRecognitionLLMConfig)
	}

	if clonedConfig.OAuth2ClientSecret != "" {
		clonedConfig.OAuth2ClientSecret = "****"
	}

	return clonedConfig
}

func removeSensitiveDataFromLLMConfig(llmConfig *settings.LLMConfig) {
	if llmConfig != nil {
		if llmConfig.OpenAIAPIKey != "" {
			llmConfig.OpenAIAPIKey = "****"
		}

		if llmConfig.OpenAICompatibleAPIKey != "" {
			llmConfig.OpenAICompatibleAPIKey = "****"
		}

		if llmConfig.AnthropicCompatibleAPIKey != "" {
			llmConfig.AnthropicCompatibleAPIKey = "****"
		}

		if llmConfig.AnthropicAPIKey != "" {
			llmConfig.AnthropicAPIKey = "****"
		}

		if llmConfig.OpenRouterAPIKey != "" {
			llmConfig.OpenRouterAPIKey = "****"
		}

		if llmConfig.LMStudioToken != "" {
			llmConfig.LMStudioToken = "****"
		}

		if llmConfig.GoogleAIAPIKey != "" {
			llmConfig.GoogleAIAPIKey = "****"
		}
	}
}
