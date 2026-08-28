package locales

// DefaultLanguage represents the default language
var DefaultLanguage = zhHans

// AllLanguages represents all the supported language
// CatLedger targets Chinese users and keeps English as the fallback language.
// Other upstream locale sources remain in the repository but are not registered.
var AllLanguages = map[string]*LocaleInfo{
	"en": {
		Content: en,
	},
	"zh-Hans": {
		Content: zhHans,
	},
}
