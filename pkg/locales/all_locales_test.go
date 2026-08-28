package locales

import "testing"

func TestCatLedgerSupportedLanguages(t *testing.T) {
	if DefaultLanguage != zhHans {
		t.Fatalf("expected simplified Chinese to be the default locale")
	}

	if len(AllLanguages) != 2 || AllLanguages["zh-Hans"] == nil || AllLanguages["en"] == nil {
		t.Fatalf("expected only simplified Chinese and English to be registered")
	}
}
