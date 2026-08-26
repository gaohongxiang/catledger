package importing_test

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestPaymentAccountAliasNormalizesFormattingAndMasksLongDigits(t *testing.T) {
	variants := []string{
		"兴业银行信用卡(6106)",
		"兴业银行信用卡（6106）",
		" 兴业银行信用卡 尾号 6106 ",
		"兴业银行信用卡6106",
	}
	var expectedKey string

	for _, variant := range variants {
		alias, ok := importing.BuildPaymentAccountAlias(variant)
		if !ok {
			t.Fatalf("expected reusable alias for %q", variant)
		}
		if expectedKey == "" {
			expectedKey = alias.Key
		} else if alias.Key != expectedKey {
			t.Fatalf("format variant produced another alias key: %q", variant)
		}
	}

	masked, ok := importing.BuildPaymentAccountAlias("兴业银行信用卡 6222600000006106")
	if !ok || strings.Contains(masked.DisplayName, "6222600000006106") || !strings.Contains(masked.DisplayName, "****6106") {
		t.Fatalf("long account digits were not safely masked: %+v", masked)
	}
	if len(masked.Key) != 64 || masked.Key != strings.ToLower(masked.Key) {
		t.Fatalf("alias key is not a lowercase SHA-256 digest: %q", masked.Key)
	}
	if masked.Key != expectedKey {
		t.Fatalf("full and masked card representations did not converge: %q != %q", masked.Key, expectedKey)
	}

	change, ok := importing.BuildPaymentAccountAlias("零钱")
	wechatChange, wechatOK := importing.BuildPaymentAccountAlias("微信零钱")
	if !ok || !wechatOK || change.Key != wechatChange.Key {
		t.Fatalf("wechat change variants must share an alias key: %+v %+v", change, wechatChange)
	}
	alipayBalance, alipayBalanceOK := importing.BuildPaymentAccountAlias("余额")
	alipayAccountBalance, alipayAccountBalanceOK := importing.BuildPaymentAccountAlias("账户余额")
	if !alipayBalanceOK || !alipayAccountBalanceOK || alipayBalance.Key != alipayAccountBalance.Key {
		t.Fatalf("alipay balance variants must share an alias key: %+v %+v", alipayBalance, alipayAccountBalance)
	}

	for _, generic := range []string{"", "银行卡", "信用卡", "储蓄卡", "未知", "付款方式"} {
		if _, ok := importing.BuildPaymentAccountAlias(generic); ok {
			t.Fatalf("generic payment method must not become a reusable mapping: %q", generic)
		}
	}
}

func TestComparablePaymentAccountTextComposesEverbrightLastFour(t *testing.T) {
	composed := importing.ComparablePaymentAccountText("末四位2690")
	alipay := importing.ComparablePaymentAccountText("光大银行信用卡(2690)")
	alipayCoupon := importing.ComparablePaymentAccountText("光大银行信用卡(2690)&两轮充电券")
	otherBank := importing.ComparablePaymentAccountText("兴业银行信用卡(2690)")
	otherLastFour := importing.ComparablePaymentAccountText("末四位1234")

	if composed == "" || composed != alipay || composed != alipayCoupon {
		t.Fatalf("everbright last-four did not match the composed card name: %q %q %q", composed, alipay, alipayCoupon)
	}
	if composed == otherBank {
		t.Fatalf("everbright last-four matched another bank with the same last four: %q", composed)
	}
	if composed == otherLastFour {
		t.Fatalf("different last-four values compared equal: %q", composed)
	}
}

func TestPaymentAccountAliasDropsCouponSuffixAndKeepsSplitTenders(t *testing.T) {
	card, ok := importing.BuildPaymentAccountAlias("光大银行信用卡(2690)")
	if !ok {
		t.Fatal("expected reusable alias for the card")
	}
	withCoupon, ok := importing.BuildPaymentAccountAlias("光大银行信用卡(2690)&两轮充电券")
	if !ok || withCoupon.Key != card.Key {
		t.Fatalf("coupon suffix must not create another account: %+v", withCoupon)
	}
	if withCoupon.DisplayName != "光大银行信用卡(2690)" || strings.Contains(withCoupon.DisplayName, "券") {
		t.Fatalf("coupon must not appear in the account display name: %q", withCoupon.DisplayName)
	}

	wallet, ok := importing.BuildPaymentAccountAlias("余额宝")
	hongbao, okHongbao := importing.BuildPaymentAccountAlias("余额宝&红包")
	if !ok || !okHongbao || hongbao.Key != wallet.Key || hongbao.DisplayName != "余额宝" {
		t.Fatalf("red-packet suffix must stay on the wallet: %+v", hongbao)
	}

	combined, ok := importing.BuildPaymentAccountAlias("花呗&余额宝")
	huabei, _ := importing.BuildPaymentAccountAlias("花呗")
	if !ok || combined.Key == card.Key || combined.Key == wallet.Key || combined.Key == huabei.Key {
		t.Fatalf("two real funding sources must not collapse: %+v", combined)
	}
}

func TestPaymentAccountServiceGroupsCouponSuffixWithTheSameCard(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	_, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7111)
	const fileId = int64(7211)
	const sourceAccountId = int64(7311)
	const batchId = int64(7411)
	defaultLedgerAccountId := int64(7511)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, &defaultLedgerAccountId, "7")

	batch := testImportBatch(uid, batchId, fileId, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	batch.SourceAccountId = int64Pointer(sourceAccountId)
	batch.LedgerAccountId = int64Pointer(defaultLedgerAccountId)
	batch.TotalRowCount = 2
	batch.ValidRowCount = 2
	batch.PendingRowCount = 2
	insertRepositoryBeans(t, database, batch,
		paymentAccountRow(uid, batchId, 7611, 1, "光大银行信用卡(2690)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7612, 2, "光大银行信用卡(2690)&两轮充电券", importing.PROCESSING_STATE_PENDING, nil),
	)

	service, err := importing.NewPaymentAccountService(repository, func() int64 { return 8001 })
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil || len(groups) != 1 {
		t.Fatalf("coupon suffix must stay in the same group: %d %v", len(groups), err)
	}
	if groups[0].DisplayName != "光大银行信用卡(2690)" || groups[0].RowCount != 2 || strings.Contains(groups[0].DisplayName, "券") {
		t.Fatalf("unexpected grouped payment account: %+v", groups[0])
	}
}

func TestPaymentAccountServiceGroupsBankCardLastFourDigits(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	_, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7131)
	const fileId = int64(7231)
	const sourceAccountId = int64(7331)
	const batchId = int64(7431)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "7")

	batch := testImportBatch(uid, batchId, fileId, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	batch.SourceTypeSnapshot = importing.SOURCE_TYPE_BANK
	batch.ParserName = "ceb_credit_pdf"
	batch.SourceAccountId = int64Pointer(sourceAccountId)
	batch.TotalRowCount = 3
	batch.ValidRowCount = 3
	batch.PendingRowCount = 3
	insertRepositoryBeans(t, database, batch,
		paymentAccountRow(uid, batchId, 7631, 1, "末四位1234", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7632, 2, "末四位1234", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7633, 3, "末四位5678", importing.PROCESSING_STATE_PENDING, nil),
	)

	nextId := int64(8100)
	service, err := importing.NewPaymentAccountService(repository, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil || len(groups) != 2 {
		t.Fatalf("bank last-four payment methods were not grouped: %d %v", len(groups), err)
	}
	first := findPaymentAccountGroup(t, groups, "光大银行信用卡(1234)")
	if first.RowCount != 2 || first.PendingRowCount != 2 || first.Mapped || first.SourceType != importing.SOURCE_TYPE_BANK {
		t.Fatalf("unexpected first CEB payment group: %+v", first)
	}

	confirmed, err := service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: first.SampleRowId,
		LedgerAccountId: 8201, LedgerAccountCurrency: "CNY",
	})
	if err != nil || confirmed == nil || !confirmed.Mapped || confirmed.LedgerAccountId == nil || *confirmed.LedgerAccountId != 8201 {
		t.Fatalf("confirm bank payment account: %+v %v", confirmed, err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, batchId, map[int64]*int64{
		7631: int64Pointer(8201), 7632: int64Pointer(8201), 7633: nil,
	})
	mappings, err := repository.ListPaymentAccountMappings(nil, uid, importing.SOURCE_TYPE_BANK)
	if err != nil || len(mappings) != 1 || mappings[0].LedgerAccountId != 8201 {
		t.Fatalf("bank payment mapping was not persisted: %+v %v", mappings, err)
	}

	excluded, err := service.ExcludePaymentAccount(nil, importing.PaymentAccountSkipRequest{
		Uid: uid, BatchId: batchId, RowId: findPaymentAccountGroup(t, groups, "光大银行信用卡(5678)").SampleRowId,
	})
	if err != nil || excluded == nil || !excluded.Excluded {
		t.Fatalf("exclude bank payment account: %+v %v", excluded, err)
	}
	exclusions, err := repository.ListPaymentAccountExclusions(nil, uid, importing.SOURCE_TYPE_BANK)
	if err != nil || len(exclusions) != 1 {
		t.Fatalf("bank payment exclusion was not persisted: %+v %v", exclusions, err)
	}
}

func TestPaymentAccountServiceConfirmsReusableAliasOutsideGroupedWorkbench(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	_, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7141)
	const fileId = int64(7241)
	const sourceAccountId = int64(7341)
	const batchId = int64(7441)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, nil, "7")

	batch := testImportBatch(uid, batchId, fileId, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	batch.SourceTypeSnapshot = importing.SOURCE_TYPE_BANK
	batch.ParserName = "generic_bank_xlsx"
	batch.SourceAccountId = int64Pointer(sourceAccountId)
	batch.TotalRowCount = 1
	batch.ValidRowCount = 1
	batch.PendingRowCount = 1
	row := paymentAccountRow(uid, batchId, 7641, 1, "兴业银行信用卡(6106)", importing.PROCESSING_STATE_PENDING, nil)
	insertRepositoryBeans(t, database, batch, row)

	service, err := importing.NewPaymentAccountService(repository, func() int64 { return 8141 })
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil || len(groups) != 0 {
		t.Fatalf("generic parser unexpectedly entered the grouped workbench: groups=%+v err=%v", groups, err)
	}
	confirmed, err := service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: row.RowId,
		LedgerAccountId: 8241, LedgerAccountCurrency: "CNY",
	})
	if err != nil || confirmed == nil || !confirmed.Mapped || confirmed.LedgerAccountId == nil || *confirmed.LedgerAccountId != 8241 {
		t.Fatalf("review flow could not persist a reusable generic-bank alias: confirmed=%+v err=%v", confirmed, err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, batchId, map[int64]*int64{row.RowId: int64Pointer(8241)})
}

func TestPaymentAccountServicePrefixesPlatformWallets(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	_, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7121)
	const fileId = int64(7221)
	const sourceAccountId = int64(7321)
	alipayBatchId := int64(7421)
	wechatBatchId := int64(7422)
	defaultLedgerAccountId := int64(7521)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, &defaultLedgerAccountId, "7")

	alipayBatch := testImportBatch(uid, alipayBatchId, fileId, 100)
	alipayBatch.Status = importing.IMPORT_BATCH_STATUS_READY
	alipayBatch.SourceAccountId = int64Pointer(sourceAccountId)
	alipayBatch.LedgerAccountId = int64Pointer(defaultLedgerAccountId)
	alipayBatch.TotalRowCount = 4
	alipayBatch.ValidRowCount = 4
	alipayBatch.PendingRowCount = 4
	legacyDigest := sha256.Sum256([]byte(string(importing.PAYMENT_ACCOUNT_ALIAS_VERSION_V1) + "\x00账户余额"))
	legacyBalanceMapping := &importing.PaymentAccountMapping{
		Uid: uid, SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", AliasKey: hex.EncodeToString(legacyDigest[:]),
		AliasKeyVersion: importing.PAYMENT_ACCOUNT_ALIAS_VERSION_V1, LedgerAccountId: 8701, MaskedDisplayName: "支付宝账户余额",
		CreatedUnixTime: 100, UpdatedUnixTime: 100, MappingId: 7627,
	}

	wechatFileId := int64(7222)
	wechatFile := testImportFile(uid, wechatFileId, "8", 101)
	wechatFile.ContentState = importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE
	wechatBatch := testImportBatch(uid, wechatBatchId, wechatFileId, 101)
	wechatBatch.Status = importing.IMPORT_BATCH_STATUS_READY
	wechatBatch.SourceTypeSnapshot = importing.SOURCE_TYPE_WECHAT
	wechatBatch.SourceAccountId = int64Pointer(sourceAccountId)
	wechatBatch.LedgerAccountId = int64Pointer(defaultLedgerAccountId)
	wechatBatch.TotalRowCount = 2
	wechatBatch.ValidRowCount = 2
	wechatBatch.PendingRowCount = 2

	insertRepositoryBeans(t, database, alipayBatch, wechatFile, wechatBatch, legacyBalanceMapping,
		paymentAccountRow(uid, alipayBatchId, 7621, 1, "余额", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, alipayBatchId, 7622, 2, "余额宝", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, alipayBatchId, 7623, 3, "账户余额", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, alipayBatchId, 7624, 4, "光大银行信用卡(2690)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, wechatBatchId, 7625, 1, "零钱", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, wechatBatchId, 7626, 2, "微信零钱", importing.PROCESSING_STATE_PENDING, nil),
	)

	service, err := importing.NewPaymentAccountService(repository, func() int64 { return 8001 })
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	alipayGroups, err := service.ListBatchPaymentAccounts(nil, uid, alipayBatchId)
	if err != nil {
		t.Fatalf("list alipay payment accounts: %v", err)
	}
	alipayNames := paymentAccountDisplayNames(alipayGroups)
	if alipayNames["支付宝账户余额"] != 1 || alipayNames["支付宝余额宝"] != 1 {
		t.Fatalf("alipay wallets were not normalized: %v", alipayNames)
	}
	alipayBalance := findPaymentAccountGroup(t, alipayGroups, "支付宝账户余额")
	if alipayBalance.RowCount != 2 || alipayBalance.PendingRowCount != 2 || !alipayBalance.Mapped ||
		alipayBalance.LedgerAccountId == nil || *alipayBalance.LedgerAccountId != 8701 {
		t.Fatalf("alipay balance variants were not grouped: %+v", alipayBalance)
	}
	currentBalanceAlias, ok := importing.BuildPaymentAccountAlias("余额")
	if !ok {
		t.Fatal("build current alipay balance alias")
	}
	insertRepositoryBeans(t, database, &importing.PaymentAccountMapping{
		Uid: uid, SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", AliasKey: currentBalanceAlias.Key,
		AliasKeyVersion: importing.PAYMENT_ACCOUNT_ALIAS_VERSION_V1, LedgerAccountId: 8702, MaskedDisplayName: "支付宝账户余额",
		CreatedUnixTime: 101, UpdatedUnixTime: 101, MappingId: 7628,
	})
	alipayGroups, err = service.ListBatchPaymentAccounts(nil, uid, alipayBatchId)
	if err != nil {
		t.Fatalf("list conflicting alipay payment accounts: %v", err)
	}
	alipayBalance = findPaymentAccountGroup(t, alipayGroups, "支付宝账户余额")
	if alipayBalance.Mapped || alipayBalance.LedgerAccountId != nil {
		t.Fatalf("conflicting legacy mappings must require confirmation: %+v", alipayBalance)
	}
	confirmed, err := service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: alipayBatchId, RowId: alipayBalance.SampleRowId,
		LedgerAccountId: 8801, LedgerAccountCurrency: "CNY",
	})
	if err != nil || confirmed == nil || !confirmed.Mapped || confirmed.RowCount != 2 || confirmed.LedgerAccountId == nil || *confirmed.LedgerAccountId != 8801 {
		t.Fatalf("confirm normalized alipay balance: %+v %v", confirmed, err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, alipayBatchId, map[int64]*int64{
		7621: int64Pointer(8801), 7622: nil, 7623: int64Pointer(8801), 7624: nil,
	})
	mappings, err := repository.ListPaymentAccountMappings(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(mappings) != 1 || mappings[0].LedgerAccountId != 8801 || mappings[0].MaskedDisplayName != "支付宝账户余额" {
		t.Fatalf("confirm should replace the legacy alipay balance mapping: %+v %v", mappings, err)
	}
	if alipayNames["光大银行信用卡(2690)"] != 1 || alipayNames["支付宝余额"] != 0 || alipayNames["余额宝"] != 0 {
		t.Fatalf("bank card must stay unprefixed: %v", alipayNames)
	}

	wechatGroups, err := service.ListBatchPaymentAccounts(nil, uid, wechatBatchId)
	if err != nil || len(wechatGroups) != 1 || wechatGroups[0].DisplayName != "微信零钱" || wechatGroups[0].RowCount != 2 {
		t.Fatalf("wechat change must be prefixed once and grouped: %+v %v", wechatGroups, err)
	}
}

func paymentAccountDisplayNames(groups []*importing.PaymentAccountGroup) map[string]int {
	names := map[string]int{}
	for _, group := range groups {
		if group != nil {
			names[group.DisplayName]++
		}
	}
	return names
}

func TestPaymentAccountServiceConfirmsOnceAndReusesMappingDuringFutureParse(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, accountKey := dedupSourceAccountEvidence(t)
	const uid = int64(7101)
	const fileId = int64(7201)
	const sourceAccountId = int64(7301)
	const batchId = int64(7401)
	defaultLedgerAccountId := int64(7501)
	insertDedupFixtures(t, database, uid, fileId, sourceAccountId, accountKey, &defaultLedgerAccountId, "7")

	batch := testImportBatch(uid, batchId, fileId, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	batch.SourceAccountId = int64Pointer(sourceAccountId)
	batch.LedgerAccountId = int64Pointer(defaultLedgerAccountId)
	batch.TotalRowCount = 4
	batch.ValidRowCount = 4
	batch.PendingRowCount = 3
	rows := []*importing.RawImportRow{
		paymentAccountRow(uid, batchId, 7601, 1, "兴业银行信用卡(6106)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7602, 2, "兴业银行信用卡 尾号6106", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7603, 3, "江苏银行信用购", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 7604, 4, "兴业银行信用卡（6106）", importing.PROCESSING_STATE_LINKED, int64Pointer(7999)),
	}
	insertRepositoryBeans(t, database, batch, rows[0], rows[1], rows[2], rows[3])

	nextId := int64(8000)
	service, err := importing.NewPaymentAccountService(repository, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}

	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil || len(groups) != 2 {
		t.Fatalf("list grouped payment accounts: %d %v", len(groups), err)
	}
	xingye := findPaymentAccountGroup(t, groups, "兴业银行信用卡")
	if xingye.RowCount != 3 || xingye.PendingRowCount != 2 || xingye.Mapped || xingye.LedgerAccountId != nil {
		t.Fatalf("unexpected unconfirmed group: %+v", xingye)
	}

	confirmed, err := service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId,
		LedgerAccountId: 8101, LedgerAccountCurrency: "CNY",
	})
	if err != nil || confirmed == nil || !confirmed.Mapped || confirmed.LedgerAccountId == nil || *confirmed.LedgerAccountId != 8101 {
		t.Fatalf("confirm grouped payment account: %+v %v", confirmed, err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, batchId, map[int64]*int64{
		7601: int64Pointer(8101), 7602: int64Pointer(8101), 7603: nil, 7604: int64Pointer(7999),
	})

	mappings, err := repository.ListPaymentAccountMappings(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(mappings) != 1 || mappings[0].LedgerAccountId != 8101 {
		t.Fatalf("unexpected persistent mapping: %+v %v", mappings, err)
	}

	_, err = service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId,
		LedgerAccountId: 8102, LedgerAccountCurrency: "CNY",
	})
	if err != nil {
		t.Fatalf("reassign grouped payment account: %v", err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, batchId, map[int64]*int64{
		7601: int64Pointer(8102), 7602: int64Pointer(8102), 7603: nil, 7604: int64Pointer(7999),
	})

	if _, err := service.ListBatchPaymentAccounts(nil, uid+1, batchId); !errors.Is(err, importing.ErrPaymentAccountBatchNotFound) {
		t.Fatalf("cross-user batch lookup was not rejected: %v", err)
	}
	if _, err := service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId,
		LedgerAccountId: 8102, LedgerAccountCurrency: "USD",
	}); !errors.Is(err, importing.ErrPaymentAccountLedgerUnavailable) {
		t.Fatalf("currency-mismatched account was not rejected: %v", err)
	}

	mapped := dedupValidRow(1, "future-mapped", 100, false)
	mapped.Raw.PaymentMethod = "兴业银行信用卡（6106）"
	unknown := dedupValidRow(2, "future-unknown", 200, false)
	unknown.Raw.PaymentMethod = "光大银行信用卡(2690)"
	empty := dedupValidRow(3, "future-empty", 300, false)
	empty.Raw.PaymentMethod = ""
	dedup := newDedupTestService(t, repository, 20000)
	futureBatch, err := dedup.PersistEvidenceDocument(nil, dedupPersistRequest(
		uid, fileId, sourceAccountId, "future_statement", dedupEvidenceDocument(candidate, []importing.EvidenceRow{mapped, unknown, empty}),
	))
	if err != nil {
		t.Fatalf("persist future statement: %v", err)
	}
	futureRows := listDedupRows(t, repository, uid, futureBatch.BatchId)
	if len(futureRows) != 3 || futureRows[0].LedgerAccountId == nil || *futureRows[0].LedgerAccountId != 8102 ||
		futureRows[1].LedgerAccountId != nil || futureRows[2].LedgerAccountId == nil || *futureRows[2].LedgerAccountId != defaultLedgerAccountId {
		t.Fatalf("future parse did not reuse only the confirmed payment mapping: %+v", futureRows)
	}
}

func assertPaymentAccountRepositoryContract(t *testing.T, repository *importing.Repository, database *datastore.Database, uid int64) {
	t.Helper()
	const batchId = int64(9001)
	batch := testImportBatch(uid, batchId, 101, 300)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	rows := []*importing.RawImportRow{
		paymentAccountRow(uid, batchId, 9101, 1, "兴业银行信用卡(6106)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 9102, 2, "兴业银行信用卡 尾号6106", importing.PROCESSING_STATE_PENDING, nil),
	}
	insertRepositoryBeans(t, database, batch, rows[0], rows[1])

	var nextId atomic.Int64
	nextId.Store(9200)
	service, err := importing.NewPaymentAccountService(repository, func() int64 {
		return nextId.Add(1)
	})
	if err != nil {
		t.Fatalf("create payment account repository contract service: %v", err)
	}
	if _, err = service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: 9101, LedgerAccountId: 9301, LedgerAccountCurrency: "CNY",
	}); err != nil {
		t.Fatalf("persist payment account mapping: %v", err)
	}
	if _, err = service.ConfirmBatchPaymentAccount(nil, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: batchId, RowId: 9102, LedgerAccountId: 9302, LedgerAccountCurrency: "CNY",
	}); err != nil {
		t.Fatalf("update payment account mapping: %v", err)
	}

	mappings, err := repository.ListPaymentAccountMappings(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(mappings) != 1 || mappings[0].LedgerAccountId != 9302 {
		t.Fatalf("payment account mapping did not converge on one row: %+v %v", mappings, err)
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, batchId, map[int64]*int64{
		9101: int64Pointer(9302), 9102: int64Pointer(9302),
	})

	concurrentBatches := []*importing.ImportBatch{
		testImportBatch(uid, 9002, 101, 301),
		testImportBatch(uid, 9003, 101, 302),
	}
	concurrentRows := []*importing.RawImportRow{
		paymentAccountRow(uid, 9002, 9103, 1, "光大银行信用卡(2690)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, 9003, 9104, 1, "光大银行信用卡（2690）", importing.PROCESSING_STATE_PENDING, nil),
	}
	insertRepositoryBeans(t, database, concurrentBatches[0], concurrentBatches[1], concurrentRows[0], concurrentRows[1])

	requests := []importing.PaymentAccountConfirmRequest{
		{Uid: uid, BatchId: 9002, RowId: 9103, LedgerAccountId: 9401, LedgerAccountCurrency: "CNY"},
		{Uid: uid, BatchId: 9003, RowId: 9104, LedgerAccountId: 9402, LedgerAccountCurrency: "CNY"},
	}
	errorsByRequest := make(chan error, len(requests))
	var wait sync.WaitGroup
	for _, request := range requests {
		request := request
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, confirmErr := service.ConfirmBatchPaymentAccount(nil, request)
			errorsByRequest <- confirmErr
		}()
	}
	wait.Wait()
	close(errorsByRequest)
	for confirmErr := range errorsByRequest {
		if confirmErr != nil {
			t.Fatalf("concurrent payment account confirmation failed: %v", confirmErr)
		}
	}
	assertPaymentRowLedgerAccounts(t, repository, uid, 9002, map[int64]*int64{9103: int64Pointer(9401)})
	assertPaymentRowLedgerAccounts(t, repository, uid, 9003, map[int64]*int64{9104: int64Pointer(9402)})

	mappings, err = repository.ListPaymentAccountMappings(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(mappings) != 2 {
		t.Fatalf("concurrent aliases did not converge on one mapping row per alias: %+v %v", mappings, err)
	}
	concurrentMappingCount := 0
	for _, mapping := range mappings {
		if strings.Contains(mapping.MaskedDisplayName, "光大银行信用卡") {
			concurrentMappingCount++
			if mapping.LedgerAccountId != 9401 && mapping.LedgerAccountId != 9402 {
				t.Fatalf("concurrent mapping has an unexpected ledger account: %+v", mapping)
			}
		}
	}
	if concurrentMappingCount != 1 {
		t.Fatalf("concurrent alias produced %d mapping rows", concurrentMappingCount)
	}
}

func TestPaymentAccountServiceExcludesGroupAppliesLaterAndRestores(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	const uid = int64(8101)
	const fileId = int64(8201)
	const batchId = int64(8401)
	batch := testImportBatch(uid, batchId, fileId, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	rows := []*importing.RawImportRow{
		paymentAccountRow(uid, batchId, 8501, 1, "兴业银行信用卡(6106)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 8502, 2, "兴业银行信用卡 尾号6106", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 8503, 3, "江苏银行信用购", importing.PROCESSING_STATE_PENDING, nil),
	}
	insertRepositoryBeans(t, database, batch, rows[0], rows[1], rows[2])

	nextId := int64(8600)
	service, err := importing.NewPaymentAccountService(repository, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil {
		t.Fatalf("list grouped payment accounts: %v", err)
	}
	xingye := findPaymentAccountGroup(t, groups, "兴业银行信用卡")
	excluded, err := service.ExcludePaymentAccount(nil, importing.PaymentAccountSkipRequest{Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId})
	if err != nil || excluded == nil || !excluded.Excluded || excluded.PendingRowCount != 0 {
		t.Fatalf("exclude grouped payment account: %+v %v", excluded, err)
	}
	exclusions, err := repository.ListPaymentAccountExclusions(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(exclusions) != 1 {
		t.Fatalf("expected one persisted exclusion: %+v %v", exclusions, err)
	}
	assertPaymentRowProcessing(t, repository, uid, batchId, map[int64]importing.ProcessingState{
		8501: importing.PROCESSING_STATE_IGNORED, 8502: importing.PROCESSING_STATE_IGNORED, 8503: importing.PROCESSING_STATE_PENDING,
	})

	later := testImportBatch(uid, 8402, fileId, 200)
	later.Status = importing.IMPORT_BATCH_STATUS_READY
	laterRow := paymentAccountRow(uid, 8402, 8504, 1, "兴业银行信用卡（6106）", importing.PROCESSING_STATE_PENDING, nil)
	insertRepositoryBeans(t, database, later, laterRow)
	if err := service.ApplyPersistedExclusions(nil, uid, 8402); err != nil {
		t.Fatalf("apply persisted exclusions: %v", err)
	}
	assertPaymentRowProcessing(t, repository, uid, 8402, map[int64]importing.ProcessingState{8504: importing.PROCESSING_STATE_IGNORED})
	laterGroups, err := service.ListBatchPaymentAccounts(nil, uid, 8402)
	if err != nil {
		t.Fatalf("list later payment accounts: %v", err)
	}
	laterXingye := findPaymentAccountGroup(t, laterGroups, "兴业银行信用卡")
	if laterXingye == nil || !laterXingye.Excluded {
		t.Fatalf("later batch did not reuse exclusion: %+v", laterXingye)
	}

	restored, err := service.RestorePaymentAccount(nil, importing.PaymentAccountSkipRequest{Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId})
	if err != nil || restored == nil || restored.Excluded || restored.PendingRowCount != 2 {
		t.Fatalf("restore grouped payment account: %+v %v", restored, err)
	}
	if _, err := service.RestorePaymentAccount(nil, importing.PaymentAccountSkipRequest{Uid: uid, BatchId: 8402, RowId: laterXingye.SampleRowId}); err != nil {
		t.Fatalf("restore later batch: %v", err)
	}
	remaining, err := repository.ListPaymentAccountExclusions(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("exclusion survived restore: %+v %v", remaining, err)
	}
	assertPaymentRowProcessing(t, repository, uid, batchId, map[int64]importing.ProcessingState{
		8501: importing.PROCESSING_STATE_PENDING, 8502: importing.PROCESSING_STATE_PENDING, 8503: importing.PROCESSING_STATE_PENDING,
	})
	assertPaymentRowProcessing(t, repository, uid, 8402, map[int64]importing.ProcessingState{8504: importing.PROCESSING_STATE_PENDING})
}

func TestPaymentAccountServiceSkipRowsDoesNotPersistExclusion(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	const uid = int64(9101)
	const batchId = int64(9401)
	batch := testImportBatch(uid, batchId, 9201, 100)
	batch.Status = importing.IMPORT_BATCH_STATUS_READY
	rows := []*importing.RawImportRow{
		paymentAccountRow(uid, batchId, 9501, 1, "兴业银行信用卡(6106)", importing.PROCESSING_STATE_PENDING, nil),
		paymentAccountRow(uid, batchId, 9502, 2, "兴业银行信用卡 尾号6106", importing.PROCESSING_STATE_PENDING, nil),
	}
	insertRepositoryBeans(t, database, batch, rows[0], rows[1])
	nextId := int64(9600)
	service, err := importing.NewPaymentAccountService(repository, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create payment account service: %v", err)
	}
	groups, err := service.ListBatchPaymentAccounts(nil, uid, batchId)
	if err != nil {
		t.Fatalf("list grouped payment accounts: %v", err)
	}
	xingye := findPaymentAccountGroup(t, groups, "兴业银行信用卡")
	skipped, err := service.SkipPaymentAccountRows(nil, importing.PaymentAccountSkipRequest{
		Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId, RowIds: []int64{9501},
	})
	if err != nil || skipped == nil || skipped.Excluded || skipped.PendingRowCount != 1 {
		t.Fatalf("skip one payment account row: %+v %v", skipped, err)
	}
	exclusions, err := repository.ListPaymentAccountExclusions(nil, uid, importing.SOURCE_TYPE_ALIPAY)
	if err != nil || len(exclusions) != 0 {
		t.Fatalf("partial skip persisted a whole-group exclusion: %+v %v", exclusions, err)
	}
	assertPaymentRowProcessing(t, repository, uid, batchId, map[int64]importing.ProcessingState{
		9501: importing.PROCESSING_STATE_IGNORED, 9502: importing.PROCESSING_STATE_PENDING,
	})
	restored, err := service.RestorePaymentAccountRows(nil, importing.PaymentAccountSkipRequest{
		Uid: uid, BatchId: batchId, RowId: xingye.SampleRowId, RowIds: []int64{9501},
	})
	if err != nil || restored == nil || restored.PendingRowCount != 2 {
		t.Fatalf("restore skipped payment account row: %+v %v", restored, err)
	}
}

func paymentAccountRow(uid int64, batchId int64, rowId int64, rowNumber int64, paymentMethod string, state importing.ProcessingState, ledgerAccountId *int64) *importing.RawImportRow {
	row := testRawImportRow(uid, rowId, batchId, rowNumber)
	row.ParseState = importing.PARSE_STATE_VALID
	row.IdentityState = importing.IDENTITY_STATE_NEW
	row.ProcessingState = state
	row.Disposition = importing.IMPORT_DISPOSITION_POSTABLE
	row.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_POSTABLE
	row.RawPaymentMethod = paymentMethod
	row.RawCounterparty = "测试商户"
	row.Currency = "CNY"
	row.LedgerAccountId = ledgerAccountId
	return row
}

func findPaymentAccountGroup(t *testing.T, groups []*importing.PaymentAccountGroup, displayFragment string) *importing.PaymentAccountGroup {
	t.Helper()
	for _, group := range groups {
		if group != nil && strings.Contains(group.DisplayName, displayFragment) {
			return group
		}
	}
	t.Fatalf("payment account group %q was not found", displayFragment)
	return nil
}

func assertPaymentRowLedgerAccounts(t *testing.T, repository *importing.Repository, uid int64, batchId int64, expected map[int64]*int64) {
	t.Helper()
	rows, err := repository.ListPaymentAccountRows(nil, uid, batchId)
	if err != nil {
		t.Fatalf("list payment account rows: %v", err)
	}
	for _, row := range rows {
		want, exists := expected[row.RowId]
		if !exists || (want == nil) != (row.LedgerAccountId == nil) || (want != nil && *want != *row.LedgerAccountId) {
			t.Fatalf("unexpected ledger account for row %d: got %v want %v", row.RowId, row.LedgerAccountId, want)
		}
	}
}

func assertPaymentRowProcessing(t *testing.T, repository *importing.Repository, uid int64, batchId int64, expected map[int64]importing.ProcessingState) {
	t.Helper()
	rows, err := repository.ListPaymentAccountRows(nil, uid, batchId)
	if err != nil {
		t.Fatalf("list payment account rows: %v", err)
	}
	for _, row := range rows {
		want, exists := expected[row.RowId]
		if !exists || row.ProcessingState != want {
			t.Fatalf("unexpected processing state for row %d: got %s want %s", row.RowId, row.ProcessingState, want)
		}
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}
