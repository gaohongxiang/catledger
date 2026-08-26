package organizer_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/converters"
	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

func TestEngineSQLiteProjectsWechatWithdrawalFromStatementAccountToPaymentAccount(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4051)
	const updateId = int64(5051)
	const batchId = int64(7051)
	const walletAccountId = int64(11)
	const bankAccountId = int64(22)
	source := testSource(uid, updateId, 6051, 7050, batchId, 10)
	source.SourceTypeSnapshot = string(importing.SOURCE_TYPE_WECHAT)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(source)
	}); err != nil {
		t.Fatalf("seed wechat withdrawal update: %v", err)
	}

	batch := engineBatch(uid, 7050, batchId)
	batch.SourceTypeSnapshot = importing.SOURCE_TYPE_WECHAT
	batch.LedgerAccountId = int64TestPointer(walletAccountId)
	row := plannerRow(uid, batchId, 8051, 9051, bankAccountId, 1001, 1783500000, importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL)
	row.LedgerAccountId = nil
	row.RawTransactionType = "零钱提现"
	row.RawPaymentMethod = "浙江农商联合银行储蓄卡(5564)"
	alias, ok := importing.BuildPaymentAccountAlias(row.RawPaymentMethod)
	if !ok {
		t.Fatal("build payment account alias")
	}
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: batch},
		rows:    map[int64][]*importing.RawImportRow{batchId: {row}},
		mappings: map[importing.SourceType][]*importing.PaymentAccountMapping{
			importing.SOURCE_TYPE_WECHAT: {{
				Uid: uid, SourceType: importing.SOURCE_TYPE_WECHAT, Currency: "CNY", AliasKey: alias.Key,
				AliasKeyVersion: alias.Version, LedgerAccountId: bankAccountId, MappingId: 1,
			}},
		},
	}
	accounts := &engineAccountStub{items: map[int64]*models.Account{
		walletAccountId: plannerAccount(uid, walletAccountId, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT),
		bankAccountId:   plannerAccount(uid, bankAccountId, models.ACCOUNT_CATEGORY_SAVINGS_ACCOUNT),
	}}
	engine, err := organizer.NewEngine(repository, evidence, accounts, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 9500})
	if err != nil {
		t.Fatalf("create projected organizer engine: %v", err)
	}
	result, err := engine.Organize(nil, organizer.OrganizeRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "wechat-withdrawal-5051-v1",
	})
	if err != nil || result == nil || len(result.Events) != 1 {
		t.Fatalf("organize projected withdrawal: result=%+v err=%v", result, err)
	}
	event := result.Events[0]
	if event.Status != organizer.EVENT_STATUS_READY || event.EconomicNature != organizer.ECONOMIC_NATURE_INTERNAL_TRANSFER ||
		event.FlowDirection != organizer.FLOW_DIRECTION_NEUTRAL || event.LedgerAccountId == nil || *event.LedgerAccountId != walletAccountId ||
		event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId != bankAccountId ||
		result.Update.ReadyEventCount != 1 || result.Update.NeedsActionEventCount != 0 {
		t.Fatalf("wechat withdrawal was not auto-confirmable: event=%+v update=%+v", event, result.Update)
	}
}

func TestEngineSQLiteProjectsWechatCreditCardRepaymentFromWalletToUniqueMappedCard(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4052)
	const updateId = int64(5052)
	const batchId = int64(7052)
	const walletAccountId = int64(31)
	const cardAccountId = int64(32)
	source := testSource(uid, updateId, 6052, 7053, batchId, 10)
	source.SourceTypeSnapshot = string(importing.SOURCE_TYPE_WECHAT)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(source)
	}); err != nil {
		t.Fatalf("seed wechat repayment update: %v", err)
	}

	batch := engineBatch(uid, 7053, batchId)
	batch.SourceTypeSnapshot = importing.SOURCE_TYPE_WECHAT
	row := plannerRow(uid, batchId, 8052, 9052, walletAccountId, 550550, 1783500000, importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_TRANSFER)
	row.RawTransactionType = "信用卡还款"
	row.RawCounterparty = "兴业银行信用卡还款"
	row.RawPaymentMethod = "零钱"
	cardAlias, ok := importing.BuildPaymentAccountAlias("兴业银行信用卡(6106)")
	if !ok {
		t.Fatal("build mapped credit-card alias")
	}
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: batch},
		rows:    map[int64][]*importing.RawImportRow{batchId: {row}},
		mappings: map[importing.SourceType][]*importing.PaymentAccountMapping{
			importing.SOURCE_TYPE_WECHAT: {{
				Uid: uid, SourceType: importing.SOURCE_TYPE_WECHAT, Currency: "CNY", AliasKey: cardAlias.Key,
				AliasKeyVersion: cardAlias.Version, LedgerAccountId: cardAccountId, MaskedDisplayName: "兴业银行信用卡(6106)", MappingId: 2,
			}},
		},
	}
	accounts := &engineAccountStub{items: map[int64]*models.Account{
		walletAccountId: plannerAccount(uid, walletAccountId, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT),
		cardAccountId:   plannerAccount(uid, cardAccountId, models.ACCOUNT_CATEGORY_CREDIT_CARD),
	}}
	engine, err := organizer.NewEngine(repository, evidence, accounts, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 9600})
	if err != nil {
		t.Fatalf("create projected organizer engine: %v", err)
	}
	result, err := engine.Organize(nil, organizer.OrganizeRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "wechat-repayment-5052-v1",
	})
	if err != nil || result == nil || len(result.Events) != 1 {
		t.Fatalf("organize projected repayment: result=%+v err=%v", result, err)
	}
	event := result.Events[0]
	if event.Status != organizer.EVENT_STATUS_READY || event.EconomicNature != organizer.ECONOMIC_NATURE_REPAYMENT ||
		event.FlowDirection != organizer.FLOW_DIRECTION_NEUTRAL || event.LedgerAccountId == nil || *event.LedgerAccountId != walletAccountId ||
		event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId != cardAccountId ||
		result.Update.ReadyEventCount != 1 || result.Update.NeedsActionEventCount != 0 {
		t.Fatalf("wechat repayment was not auto-confirmable: event=%+v update=%+v", event, result.Update)
	}
}

func TestEngineSQLiteMapsOrdinaryBankRowAndMergesWechatEvidence(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4053)
	const updateId = int64(5053)
	const bankBatchId = int64(7054)
	const wechatBatchId = int64(7055)
	const cardAccountId = int64(41)
	bankSource := testSource(uid, updateId, 6053, 7056, bankBatchId, 10)
	bankSource.SourceTypeSnapshot = string(importing.SOURCE_TYPE_BANK)
	wechatSource := testSource(uid, updateId, 6054, 7057, wechatBatchId, 10)
	wechatSource.SourceOrder = 1
	wechatSource.SourceTypeSnapshot = string(importing.SOURCE_TYPE_WECHAT)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		if err := tx.InsertSource(bankSource); err != nil {
			return err
		}
		return tx.InsertSource(wechatSource)
	}); err != nil {
		t.Fatalf("seed bank and wechat update: %v", err)
	}

	bankBatch := engineBatch(uid, 7056, bankBatchId)
	bankBatch.SourceTypeSnapshot = importing.SOURCE_TYPE_BANK
	wechatBatch := engineBatch(uid, 7057, wechatBatchId)
	wechatBatch.SourceTypeSnapshot = importing.SOURCE_TYPE_WECHAT
	bankRow := plannerRow(uid, bankBatchId, 8053, 9053, cardAccountId, 5777, 1783750972,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	bankRow.LedgerAccountId = nil
	bankRow.RawCounterparty = "财付通快捷--美团平台商户"
	bankRow.RawPaymentMethod = "兴业银行信用卡(主卡6106)"
	wechatRow := plannerRow(uid, wechatBatchId, 8054, 9054, cardAccountId, 5777, 1783750972,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	wechatRow.RawCounterparty = "美团平台商户"
	wechatRow.RawItem = "美团订单-渠道订单说明"
	wechatRow.RawPaymentMethod = "兴业银行信用卡(6106)"
	alias, ok := importing.BuildPaymentAccountAlias(wechatRow.RawPaymentMethod)
	if !ok {
		t.Fatal("build mapped bank account alias")
	}
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{bankBatchId: bankBatch, wechatBatchId: wechatBatch},
		rows: map[int64][]*importing.RawImportRow{
			bankBatchId:   {bankRow},
			wechatBatchId: {wechatRow},
		},
		mappings: map[importing.SourceType][]*importing.PaymentAccountMapping{
			importing.SOURCE_TYPE_WECHAT: {{
				Uid: uid, SourceType: importing.SOURCE_TYPE_WECHAT, Currency: "CNY", AliasKey: alias.Key,
				AliasKeyVersion: alias.Version, LedgerAccountId: cardAccountId,
				MaskedDisplayName: "兴业银行信用卡(6106)", MappingId: 3,
			}},
		},
	}
	accounts := &engineAccountStub{items: map[int64]*models.Account{
		cardAccountId: plannerAccount(uid, cardAccountId, models.ACCOUNT_CATEGORY_CREDIT_CARD),
	}}
	engine, err := organizer.NewEngine(repository, evidence, accounts, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 9700})
	if err != nil {
		t.Fatalf("create bank and wechat organizer engine: %v", err)
	}
	result, err := engine.Organize(nil, organizer.OrganizeRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "bank-wechat-5053-v1",
	})
	if err != nil || result == nil || len(result.Events) != 1 {
		t.Fatalf("organize bank and wechat evidence: result=%+v err=%v", result, err)
	}
	event := result.Events[0]
	if event.Status != organizer.EVENT_STATUS_READY || event.LedgerAccountId == nil || *event.LedgerAccountId != cardAccountId ||
		result.Update.ValidEvidenceCount != 2 || result.Update.FinalEventCount != 1 || result.Update.ReadyEventCount != 1 ||
		result.Update.NeedsActionEventCount != 0 {
		t.Fatalf("bank and wechat evidence did not converge: event=%+v update=%+v", event, result.Update)
	}
	rows, err := repository.ListEvidence(nil, uid, event.EventId)
	if err != nil || len(rows) != 2 {
		t.Fatalf("merged event evidence mismatch: rows=%+v err=%v", rows, err)
	}
}

func TestEngineSQLitePersistsPlanAndReplaysIdempotently(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4101)
	const updateId = int64(5101)
	const batchId = int64(7101)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6101, 7100, batchId, 10))
	}); err != nil {
		t.Fatalf("seed organizer update: %v", err)
	}

	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7100, batchId)},
		rows: map[int64][]*importing.RawImportRow{batchId: {
			plannerRow(uid, batchId, 8101, 9101, 11, 1234, 1701000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		}},
	}
	accounts := &engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}}
	ids := &engineIdGenerator{next: 10000}
	engine, err := organizer.NewEngine(repository, evidence, accounts, converters.NewSourceFundsProjector(), ids)
	if err != nil {
		t.Fatalf("create organizer engine: %v", err)
	}
	request := organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5101-v1"}
	result, err := engine.Organize(nil, request)
	if err != nil {
		t.Fatalf("organize update: %v", err)
	}
	if result.Replayed || result.Update == nil || result.Update.Status != organizer.UPDATE_STATUS_REVIEW || result.Update.Version != 3 ||
		result.Update.ReadyEventCount != 1 || result.Action == nil || result.Action.Status != organizer.ACTION_STATUS_APPLIED ||
		result.Action.AppliedUpdateVersion != 3 || len(result.Events) != 1 {
		t.Fatalf("unexpected organizer result: %+v", result)
	}
	evidenceRows, err := repository.ListEvidence(nil, uid, result.Events[0].EventId)
	if err != nil || len(evidenceRows) != 1 || evidenceRows[0].RowId != 8101 {
		t.Fatalf("persisted evidence mismatch: rows=%+v err=%v", evidenceRows, err)
	}

	replayed, err := engine.Organize(nil, request)
	if err != nil || replayed == nil || !replayed.Replayed || replayed.Action.ActionId != result.Action.ActionId || len(replayed.Events) != 1 {
		t.Fatalf("idempotent replay mismatch: result=%+v err=%v", replayed, err)
	}
	if _, err = engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5101-other"}); !errors.Is(err, organizer.ErrOrganizeVersionConflict) {
		t.Fatalf("stale version was accepted: %v", err)
	}
	sess := database.NewSession(nil)
	actionCount, countErr := sess.Where("uid=?", uid).Count(new(organizer.FinanceAction))
	sess.Close()
	if countErr != nil || actionCount != 1 {
		t.Fatalf("conflicting action was not rolled back: count=%d err=%v", actionCount, countErr)
	}
}

func TestEngineSQLiteRejectsReorganizationForAutomaticPlan(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4151)
	const updateId = int64(5151)
	const batchId = int64(7151)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6151, 7150, batchId, 10))
	}); err != nil {
		t.Fatalf("seed immutable organizer update: %v", err)
	}
	row := plannerRow(uid, batchId, 8151, 9151, 11, 1234, 1701500000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7150, batchId)},
		rows:    map[int64][]*importing.RawImportRow{batchId: {row}},
	}
	engine, err := organizer.NewEngine(repository, evidence,
		&engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}},
		converters.NewSourceFundsProjector(),
		&engineIdGenerator{next: 15000})
	if err != nil {
		t.Fatalf("create immutable organizer engine: %v", err)
	}
	first, err := engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5151-v1"})
	if err != nil || first == nil || len(first.Events) != 1 {
		t.Fatalf("create first organizer plan: result=%+v err=%v", first, err)
	}
	firstEventId := first.Events[0].EventId
	firstAmount := *first.Events[0].Amount
	newAmount := int64(2345)
	row.NormalizedAmount = &newAmount
	row.NormalizedTransactionType = importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
	row.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED
	row.Disposition = importing.IMPORT_DISPOSITION_REVIEW_REQUIRED

	_, err = engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 3, IdempotencyKey: "organize-5151-v3"})
	if !errors.Is(err, organizer.ErrOrganizeStateConflict) {
		t.Fatalf("automatic review plan was allowed to be reorganized: %v", err)
	}
	persisted, findErr := repository.FindEventById(nil, uid, firstEventId)
	if findErr != nil || persisted == nil || persisted.Amount == nil || *persisted.Amount != firstAmount {
		t.Fatalf("immutable automatic event changed: event=%+v err=%v", persisted, findErr)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_REVIEW || update.Version != 3 {
		t.Fatalf("rejected reorganization changed update: update=%+v err=%v", update, findErr)
	}
	sess := database.NewSession(nil)
	actionCount, actionErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.FinanceAction))
	eventCount, eventErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.EconomicEvent))
	sess.Close()
	if actionErr != nil || eventErr != nil || actionCount != 1 || eventCount != 1 {
		t.Fatalf("immutable plan audit mismatch: actions=%d events=%d errors=%v/%v", actionCount, eventCount, actionErr, eventErr)
	}
}

func TestEngineSQLiteMarksSnapshotFailureWithoutPartialPlan(t *testing.T) {
	repository, _ := newSQLiteOrganizerRepository(t)
	const uid = int64(4202)
	const updateId = int64(5202)
	const batchId = int64(7202)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6202, 7200, batchId, 10))
	}); err != nil {
		t.Fatalf("seed failing organizer update: %v", err)
	}
	batch := engineBatch(uid, 7200, batchId)
	batch.ParserVersion = "different-parser"
	engine, err := organizer.NewEngine(repository, &engineEvidenceStub{batches: map[int64]*importing.ImportBatch{batchId: batch}, rows: map[int64][]*importing.RawImportRow{batchId: {}}},
		&engineAccountStub{items: map[int64]*models.Account{}}, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 20000})
	if err != nil {
		t.Fatalf("create failing organizer engine: %v", err)
	}
	_, err = engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5202-v1"})
	if err == nil {
		t.Fatal("source snapshot mismatch was accepted")
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_FAILED || update.Version != 3 || update.ErrorCode != "source_snapshot_invalid" {
		t.Fatalf("failed update state mismatch: update=%+v err=%v", update, findErr)
	}
	events, listErr := repository.ListEvents(nil, uid, updateId)
	if listErr != nil || len(events) != 0 {
		t.Fatalf("snapshot failure left a partial plan: events=%+v err=%v", events, listErr)
	}
	if update.CurrentActionId == nil {
		t.Fatal("failed update lost its action audit")
	}
	action, actionErr := repository.FindActionById(nil, uid, *update.CurrentActionId)
	if actionErr != nil || action == nil || action.Status != organizer.ACTION_STATUS_FAILED || action.ErrorCode != "source_snapshot_invalid" {
		t.Fatalf("failed action mismatch: action=%+v err=%v", action, actionErr)
	}
	_, retryErr := engine.Organize(nil, organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: update.Version, IdempotencyKey: "retry-failed-5202"})
	if !errors.Is(retryErr, organizer.ErrOrganizeStateConflict) {
		t.Fatalf("failed round was allowed to be reorganized: %v", retryErr)
	}
}

func TestEngineSQLiteConcurrentReplayKeepsOnePlan(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4303)
	const updateId = int64(5303)
	const batchId = int64(7303)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		if err := tx.InsertUpdate(testUpdate(uid, updateId, 10)); err != nil {
			return err
		}
		return tx.InsertSource(testSource(uid, updateId, 6303, 7300, batchId, 10))
	}); err != nil {
		t.Fatalf("seed concurrent organizer update: %v", err)
	}
	evidence := &engineEvidenceStub{
		batches: map[int64]*importing.ImportBatch{batchId: engineBatch(uid, 7300, batchId)},
		rows: map[int64][]*importing.RawImportRow{batchId: {
			plannerRow(uid, batchId, 8303, 9303, 11, 4321, 1702000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		}},
		barrier: make(chan struct{}),
	}
	engine, err := organizer.NewEngine(repository, evidence,
		&engineAccountStub{items: map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}},
		converters.NewSourceFundsProjector(),
		&engineIdGenerator{next: 30000})
	if err != nil {
		t.Fatalf("create concurrent organizer engine: %v", err)
	}
	request := organizer.OrganizeRequest{Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 1, IdempotencyKey: "organize-5303-v1"}
	results := make([]*organizer.OrganizeResult, 2)
	errorsByCall := make([]error, 2)
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], errorsByCall[index] = engine.Organize(nil, request)
		}(index)
	}
	wait.Wait()
	for index := range results {
		if errorsByCall[index] != nil || results[index] == nil || results[index].Update.Status != organizer.UPDATE_STATUS_REVIEW || len(results[index].Events) != 1 {
			t.Fatalf("concurrent organize call %d failed: result=%+v err=%v", index, results[index], errorsByCall[index])
		}
	}
	if results[0].Action.ActionId != results[1].Action.ActionId {
		t.Fatalf("concurrent replay created different actions: %d %d", results[0].Action.ActionId, results[1].Action.ActionId)
	}
	sess := database.NewSession(nil)
	actionCount, actionErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.FinanceAction))
	eventCount, eventErr := sess.Where("uid=? AND update_id=?", uid, updateId).Count(new(organizer.EconomicEvent))
	sess.Close()
	if actionErr != nil || eventErr != nil || actionCount != 1 || eventCount != 1 {
		t.Fatalf("concurrent organizer duplicated state: actions=%d events=%d actionErr=%v eventErr=%v", actionCount, eventCount, actionErr, eventErr)
	}
}

func TestEngineSQLiteRejectsReorganizationBeforeStateTransitionWhenPlanHasManualFacts(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4351)
	const updateId = int64(5351)
	event := postingEvent(uid, updateId, 8351, organizer.EVENT_STATUS_READY, organizer.ECONOMIC_NATURE_EXPENSE)
	event.ManualFieldMask = organizer.MANUAL_FIELD_CATEGORY
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	engine, err := organizer.NewEngine(repository, &engineEvidenceStub{}, &engineAccountStub{}, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 31000})
	if err != nil {
		t.Fatalf("create manual-fact organizer engine: %v", err)
	}

	_, err = engine.Organize(nil, organizer.OrganizeRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "reject-manual-plan-rebuild",
	})
	if !errors.Is(err, organizer.ErrOrganizeStateConflict) {
		t.Fatalf("review round was allowed to be reorganized: %v", err)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_REVIEW || update.Version != 2 || update.CurrentActionId != nil {
		t.Fatalf("manual plan rejection changed update state: update=%+v err=%v", update, findErr)
	}
	sess := database.NewPrivacySession(nil)
	actionCount, countErr := sess.Where("uid=? AND update_id=? AND action_type=?", uid, updateId, organizer.ACTION_TYPE_ORGANIZE).Count(new(organizer.FinanceAction))
	sess.Close()
	if countErr != nil || actionCount != 0 {
		t.Fatalf("manual plan rejection persisted an action: count=%d err=%v", actionCount, countErr)
	}
}

func TestEngineSQLiteRejectsReorganizationBeforeStateTransitionAfterReviewDecision(t *testing.T) {
	repository, database := newSQLiteOrganizerRepository(t)
	const uid = int64(4352)
	const updateId = int64(5352)
	const issueId = int64(6352)
	event := postingEvent(uid, updateId, 8352, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.ECONOMIC_NATURE_UNKNOWN)
	seedPostingUpdate(t, repository, uid, updateId, []*organizer.EconomicEvent{event})
	seedReviewIssue(t, repository, uid, updateId, issueId, organizer.REVIEW_ISSUE_TYPE_SHARED_FIELDS, event)
	if err := repository.DoTransaction(nil, uid, func(tx *organizer.RepositoryTransaction) error {
		issue, err := tx.FindReviewIssueById(issueId)
		if err != nil {
			return err
		}
		actionId := int64(7352)
		next := *issue
		next.Status = organizer.REVIEW_ISSUE_STATUS_RESOLVED
		next.Version = issue.Version + 1
		next.Blocking = false
		next.ResolvedActionId = &actionId
		next.UpdatedUnixTime = issue.UpdatedUnixTime + 1
		updated, err := tx.UpdateReviewIssueCAS(issue.Version, &next)
		if err != nil || !updated {
			return errors.New("resolve review issue fixture")
		}
		return nil
	}); err != nil {
		t.Fatalf("seed resolved review issue: %v", err)
	}
	engine, err := organizer.NewEngine(repository, &engineEvidenceStub{}, &engineAccountStub{}, converters.NewSourceFundsProjector(), &engineIdGenerator{next: 32000})
	if err != nil {
		t.Fatalf("create decided-plan organizer engine: %v", err)
	}

	_, err = engine.Organize(nil, organizer.OrganizeRequest{
		Uid: uid, UpdateId: updateId, ExpectedUpdateVersion: 2, IdempotencyKey: "reject-decided-plan-rebuild",
	})
	if !errors.Is(err, organizer.ErrOrganizeStateConflict) {
		t.Fatalf("decided review round was allowed to be reorganized: %v", err)
	}
	update, findErr := repository.FindUpdateById(nil, uid, updateId)
	if findErr != nil || update == nil || update.Status != organizer.UPDATE_STATUS_REVIEW || update.Version != 2 || update.CurrentActionId != nil {
		t.Fatalf("decided plan rejection changed update state: update=%+v err=%v", update, findErr)
	}
	sess := database.NewPrivacySession(nil)
	actionCount, countErr := sess.Where("uid=? AND update_id=? AND action_type=?", uid, updateId, organizer.ACTION_TYPE_ORGANIZE).Count(new(organizer.FinanceAction))
	sess.Close()
	if countErr != nil || actionCount != 0 {
		t.Fatalf("decided plan rejection persisted an action: count=%d err=%v", actionCount, countErr)
	}
}

type engineEvidenceStub struct {
	batches  map[int64]*importing.ImportBatch
	rows     map[int64][]*importing.RawImportRow
	mappings map[importing.SourceType][]*importing.PaymentAccountMapping
	mu       sync.Mutex
	calls    int
	barrier  chan struct{}
}

func (s *engineEvidenceStub) ListPaymentAccountMappings(_ core.Context, uid int64, sourceType importing.SourceType) ([]*importing.PaymentAccountMapping, error) {
	result := make([]*importing.PaymentAccountMapping, 0, len(s.mappings[sourceType]))
	for _, mapping := range s.mappings[sourceType] {
		if mapping == nil || mapping.Uid != uid {
			continue
		}
		cloned := *mapping
		result = append(result, &cloned)
	}
	return result, nil
}

func (s *engineEvidenceStub) FindImportBatchById(_ core.Context, uid int64, batchId int64) (*importing.ImportBatch, error) {
	if s.barrier != nil {
		s.mu.Lock()
		s.calls++
		if s.calls == 2 {
			close(s.barrier)
		}
		barrier := s.barrier
		s.mu.Unlock()
		select {
		case <-barrier:
		case <-time.After(5 * time.Second):
		}
	}
	batch := s.batches[batchId]
	if batch == nil || batch.Uid != uid {
		return nil, nil
	}
	cloned := *batch
	return &cloned, nil
}

func (s *engineEvidenceStub) ListRawImportRows(_ core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error) {
	result := make([]*importing.RawImportRow, 0, len(s.rows[batchId]))
	for _, row := range s.rows[batchId] {
		if row.Uid != uid {
			continue
		}
		cloned := *row
		result = append(result, &cloned)
	}
	return result, nil
}

type engineAccountStub struct {
	items map[int64]*models.Account
}

func (s *engineAccountStub) GetAccountsByAccountIds(_ core.Context, uid int64, accountIds []int64) (map[int64]*models.Account, error) {
	result := make(map[int64]*models.Account)
	for _, accountId := range accountIds {
		if account := s.items[accountId]; account != nil && account.Uid == uid {
			cloned := *account
			result[accountId] = &cloned
		}
	}
	return result, nil
}

type engineIdGenerator struct {
	mu   sync.Mutex
	next int64
}

func (g *engineIdGenerator) GenerateUuid(_ uuid.UuidType) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.next++
	return g.next
}

func engineBatch(uid int64, fileId int64, batchId int64) *importing.ImportBatch {
	return &importing.ImportBatch{
		Uid: uid, FileId: fileId, Status: importing.IMPORT_BATCH_STATUS_READY, SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY,
		ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1", IdentityKeyVersion: "identity-v1", BatchId: batchId,
	}
}

func int64TestPointer(value int64) *int64 {
	return &value
}
