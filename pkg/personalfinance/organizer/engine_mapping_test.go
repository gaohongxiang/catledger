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

func TestResolveRepaymentTargetUsesExactMappingBeforeUniqueCardFamily(t *testing.T) {
	row := &importing.RawImportRow{Currency: "CNY", RawPaymentMethod: "支付宝账户余额"}
	huaBeiAlias, ok := importing.BuildPaymentAccountAlias("花呗")
	if !ok {
		t.Fatal("build exact repayment target alias")
	}
	xingyeAlias, ok := importing.BuildPaymentAccountAlias("兴业银行信用卡(6106)")
	if !ok {
		t.Fatal("build credit-card repayment target alias")
	}
	mappings := indexPaymentAccountMappings([]*importing.PaymentAccountMapping{
		{Currency: "CNY", AliasKey: huaBeiAlias.Key, AliasKeyVersion: huaBeiAlias.Version, LedgerAccountId: 51, MaskedDisplayName: "花呗"},
		{Currency: "CNY", AliasKey: xingyeAlias.Key, AliasKeyVersion: xingyeAlias.Version, LedgerAccountId: 52, MaskedDisplayName: "兴业银行信用卡(6106)"},
	})

	exact := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_REPAYMENT_TARGET, Raw: "花呗",
	}, mappings)
	if exact == nil || *exact != 51 {
		t.Fatalf("exact repayment target mapping mismatch: %v", exact)
	}
	family := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_REPAYMENT_TARGET, Raw: "兴业银行信用卡还款",
	}, mappings)
	if family == nil || *family != 52 {
		t.Fatalf("unique credit-card family mapping mismatch: %v", family)
	}
	composite := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_REPAYMENT_TARGET, Raw: "花呗|信用购",
	}, mappings)
	if composite != nil {
		t.Fatalf("composite repayment target must remain unresolved: %d", *composite)
	}
}

func TestResolveStatementAccountFallsBackToLatestPaymentMapping(t *testing.T) {
	alias, ok := importing.BuildPaymentAccountAlias("兴业银行信用卡(6106)")
	if !ok {
		t.Fatal("build statement account alias")
	}
	row := &importing.RawImportRow{
		Currency:         "CNY",
		RawPaymentMethod: "兴业银行信用卡(主卡6106)",
	}
	mappings := map[string]int64{"CNY\x00" + alias.Key: 61}

	account := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_STATEMENT,
	}, mappings)
	if account == nil || *account != 61 {
		t.Fatalf("statement account should use latest payment mapping: %v", account)
	}

	batchAccountId := int64(62)
	account = resolveFundsAccountReference(row, &importing.ImportBatch{LedgerAccountId: &batchAccountId}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_STATEMENT,
	}, mappings)
	if account == nil || *account != batchAccountId {
		t.Fatalf("explicit batch account must keep priority: %v", account)
	}
}
