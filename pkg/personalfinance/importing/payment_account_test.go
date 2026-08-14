package importing_test

import (
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

	for _, generic := range []string{"", "银行卡", "信用卡", "储蓄卡", "未知", "付款方式"} {
		if _, ok := importing.BuildPaymentAccountAlias(generic); ok {
			t.Fatalf("generic payment method must not become a reusable mapping: %q", generic)
		}
	}
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

func paymentAccountRow(uid int64, batchId int64, rowId int64, rowNumber int64, paymentMethod string, state importing.ProcessingState, ledgerAccountId *int64) *importing.RawImportRow {
	row := testRawImportRow(uid, rowId, batchId, rowNumber)
	row.ParseState = importing.PARSE_STATE_VALID
	row.IdentityState = importing.IDENTITY_STATE_NEW
	row.ProcessingState = state
	row.RawPaymentMethod = paymentMethod
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

func int64Pointer(value int64) *int64 {
	return &value
}
