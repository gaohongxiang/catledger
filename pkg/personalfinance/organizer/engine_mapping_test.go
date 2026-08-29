package organizer

import (
	"testing"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
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
	if composite == nil || *composite != 51 {
		t.Fatalf("unique consumer-credit family mapping mismatch: %v", composite)
	}
}

func TestResolveRepaymentTargetKeepsConsumerCreditFamilyAmbiguous(t *testing.T) {
	row := &importing.RawImportRow{Currency: "CNY"}
	huaBeiAlias, _ := importing.BuildPaymentAccountAlias("花呗")
	creditPurchaseAlias, _ := importing.BuildPaymentAccountAlias("信用购")
	mappings := indexPaymentAccountMappings([]*importing.PaymentAccountMapping{
		{Currency: "CNY", AliasKey: huaBeiAlias.Key, AliasKeyVersion: huaBeiAlias.Version, LedgerAccountId: 51, MaskedDisplayName: "花呗"},
		{Currency: "CNY", AliasKey: creditPurchaseAlias.Key, AliasKeyVersion: creditPurchaseAlias.Version, LedgerAccountId: 53, MaskedDisplayName: "信用购"},
	})
	composite := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_REPAYMENT_TARGET, Raw: "花呗|信用购",
	}, mappings)
	if composite != nil {
		t.Fatalf("conflicting consumer-credit accounts must remain unresolved: %d", *composite)
	}
}

func TestResolveAlipayIncomeFallsBackToMappedAccountBalance(t *testing.T) {
	balanceAlias, ok := importing.BuildPaymentAccountAlias("余额")
	if !ok {
		t.Fatal("build alipay balance alias")
	}
	row := &importing.RawImportRow{
		Currency: "CNY", RawPaymentMethod: "-", NormalizedDirection: importing.NORMALIZED_DIRECTION_INCOME,
		EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL,
	}
	account := resolvePlanningRowLedgerAccount(row, &importing.ImportBatch{}, importing.SOURCE_TYPE_ALIPAY,
		map[string]int64{"CNY\x00" + balanceAlias.Key: 71})
	if account == nil || *account != 71 {
		t.Fatalf("alipay income did not reuse account balance: %v", account)
	}
	row.NormalizedDirection = importing.NORMALIZED_DIRECTION_EXPENSE
	if account = resolvePlanningRowLedgerAccount(row, &importing.ImportBatch{}, importing.SOURCE_TYPE_ALIPAY,
		map[string]int64{"CNY\x00" + balanceAlias.Key: 71}); account != nil {
		t.Fatalf("alipay expense without payment method used income fallback: %d", *account)
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

func TestResolveStatementAccountPrefersExplicitPlatformWallet(t *testing.T) {
	bankAccountId := int64(41)
	walletAccountId := int64(42)
	row := &importing.RawImportRow{
		Currency:         "CNY",
		RawPaymentMethod: "合成银行卡(0000)",
		LedgerAccountId:  &bankAccountId,
	}
	bankAlias, bankOK := importing.BuildPaymentAccountAlias("合成银行卡(0000)")
	walletAlias, walletOK := importing.BuildPaymentAccountAlias("零钱")
	if !bankOK || !walletOK {
		t.Fatal("build platform wallet mappings")
	}
	mappings := map[string]int64{
		"CNY\x00" + bankAlias.Key:   bankAccountId,
		"CNY\x00" + walletAlias.Key: walletAccountId,
	}

	account := resolveFundsAccountReference(row, &importing.ImportBatch{}, importing.SourceFundsAccountReference{
		Kind: importing.SOURCE_FUNDS_ACCOUNT_STATEMENT,
		Raw:  "零钱",
	}, mappings)
	if account == nil || *account != walletAccountId {
		t.Fatalf("explicit platform wallet must not fall back to row payment account: %v", account)
	}
}
