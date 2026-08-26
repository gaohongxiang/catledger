package organizer

import (
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestIndexPaymentAccountMappingsKeepsCreditCardFamilyAmbiguous(t *testing.T) {
	firstAlias, firstOK := importing.BuildPaymentAccountAlias("兴业银行信用卡(6106)")
	secondAlias, secondOK := importing.BuildPaymentAccountAlias("兴业银行信用卡(7788)")
	if !firstOK || !secondOK {
		t.Fatal("build credit-card aliases")
	}
	lookup := indexPaymentAccountMappings([]*importing.PaymentAccountMapping{
		{Currency: "CNY", AliasKey: firstAlias.Key, AliasKeyVersion: firstAlias.Version, LedgerAccountId: 41, MaskedDisplayName: "兴业银行信用卡(6106)"},
		{Currency: "CNY", AliasKey: secondAlias.Key, AliasKeyVersion: secondAlias.Version, LedgerAccountId: 42, MaskedDisplayName: "兴业银行信用卡(7788)"},
	})
	family, ok := importing.CreditCardAccountFamilyAlias("兴业银行信用卡还款")
	if !ok {
		t.Fatal("build repayment credit-card family")
	}
	if accountId := lookup[creditCardFamilyMappingKey("CNY", family)]; accountId != 0 {
		t.Fatalf("ambiguous credit-card family must not select an account: %d", accountId)
	}
	if lookup["CNY\x00"+firstAlias.Key] != 41 || lookup["CNY\x00"+secondAlias.Key] != 42 {
		t.Fatal("exact credit-card mappings must remain available")
	}
}
