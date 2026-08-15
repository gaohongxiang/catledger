package billflow_test

import (
	"errors"
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

func TestServiceConfirmThenPostCategoryAndUndo(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	accountId := int64(61)
	identity := int64(201)
	leafId := int64(51)
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{
		postableRow(uid, 401, 801, identity, accountId, "商户消费"),
		postableRow(uid, 401, 802, 202, accountId, "餐饮美食"),
	})
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {mappedGroup(accountId, 801)},
	}}
	poster := &fakePoster{}
	undo := &fakeUndo{can: true}
	var nextId int64 = 9000
	service, err := billflow.NewService(repository, evidence, payments, poster, nil, nil, nil, &fakeCategories{leaves: []billflow.CategoryLeaf{
		{CategoryId: leafId, Name: "餐饮美食"},
	}}, undo, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}

	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-1"})
	if err != nil || created.ConfirmPolicy != billflow.CONFIRM_POLICY_CONFIRM_THEN_POST || created.Status != billflow.TASK_STATUS_RECEIVING {
		t.Fatalf("first task should confirm then post: %+v err=%v", created, err)
	}
	if created.ReusedMappingCount < 1 {
		t.Fatalf("confirmed mapping was not reused: %+v", created)
	}
	again, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-again"})
	if err != nil || again == nil || again.TaskId != created.TaskId {
		t.Fatalf("same batches should reopen existing task: %+v err=%v", again, err)
	}

	ran, err := service.RunTask(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, IdempotencyKey: "run-task-1", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || ran.Status != billflow.TASK_STATUS_AWAITING_CONFIRM || poster.calls != 0 {
		t.Fatalf("confirm_then_post run posted early: %+v calls=%d err=%v", ran, poster.calls, err)
	}
	todos, err := service.ListTodos(nil, uid, created.TaskId, billflow.TODO_STATUS_OPEN, nil, 20)
	if err != nil || !hasTodoKind(todos, billflow.TODO_KIND_UNCATEGORIZED) {
		t.Fatalf("forbidden category did not open uncategorized todo: %+v err=%v", todos, err)
	}

	posted, err := service.ConfirmPost(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: ran.Version, IdempotencyKey: "confirm-post-1", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || posted.Status != billflow.TASK_STATUS_READY || poster.calls != 1 {
		t.Fatalf("confirm_post did not write ledger: %+v calls=%d err=%v", posted, poster.calls, err)
	}
	if len(poster.last.Commands) != 2 {
		t.Fatalf("expected two auto-post commands, got %d", len(poster.last.Commands))
	}
	assertAutoPostedUncategorized(t, poster.last.Commands, 801)
	assertAutoPostedCategory(t, poster.last.Commands, 802, leafId)

	impact, err := service.GetUndoImpact(nil, uid, created.TaskId)
	if err != nil || impact == nil || !impact.CanReverse {
		t.Fatalf("undo impact should allow reverse: %+v err=%v", impact, err)
	}
	undone, err := service.UndoTask(nil, billflow.UndoTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: posted.Version, IdempotencyKey: "undo-task-1"})
	if err != nil || undone.Status != billflow.TASK_STATUS_RECEIVING || undo.reverse != 1 {
		t.Fatalf("undo did not restore receiving: %+v reverse=%d err=%v", undone, undo.reverse, err)
	}
}

func TestServiceAssignMerchantCategoryBeforeConfirm(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	accountId := int64(61)
	leafId := int64(51)
	row := postableRow(uid, 401, 801, 201, accountId, "商户消费")
	row.RawCounterparty = "星巴克"
	row.RawItem = "拿铁"
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{row})
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {mappedGroup(accountId, 801)},
	}}
	poster := &fakePoster{}
	var nextId int64 = 9000
	service, err := billflow.NewService(repository, evidence, payments, poster, nil, nil, nil, &fakeCategories{leaves: []billflow.CategoryLeaf{
		{CategoryId: leafId, Name: "餐饮美食"},
	}}, &fakeUndo{can: true}, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}

	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-1"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	ran, err := service.RunTask(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, IdempotencyKey: "run-task-1", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || ran.Status != billflow.TASK_STATUS_AWAITING_CONFIRM {
		t.Fatalf("run task: %+v err=%v", ran, err)
	}
	todos, err := service.ListTodos(nil, uid, created.TaskId, billflow.TODO_STATUS_OPEN, nil, 20)
	if err != nil || todos == nil || len(todos.Items) != 1 || todos.Items[0].TodoKind != billflow.TODO_KIND_UNCATEGORIZED ||
		todos.Items[0].Label != "星巴克" || todos.Items[0].Item != "拿铁" || todos.Items[0].BillType != "商户消费" ||
		todos.Items[0].Amount != "123" || todos.Items[0].Currency != "CNY" || todos.Items[0].Direction != string(importing.NORMALIZED_DIRECTION_EXPENSE) {
		t.Fatalf("uncategorized todo preview: %+v err=%v", todos, err)
	}

	assigned, err := service.AssignTodoCategories(nil, billflow.AssignTodoCategoryRequest{
		Uid: uid, CategoryId: leafId, IdempotencyKey: "assign-category-1",
		Items: []billflow.AssignTodoCategoryItem{{TodoId: todos.Items[0].TodoId, ExpectedVersion: todos.Items[0].Version}},
	})
	if err != nil || assigned == nil || assigned.TodoOpenCount != 0 {
		t.Fatalf("assign category: %+v err=%v", assigned, err)
	}
	open, err := service.ListTodos(nil, uid, created.TaskId, billflow.TODO_STATUS_OPEN, nil, 20)
	if err != nil || open == nil || len(open.Items) != 0 {
		t.Fatalf("assigned todo stayed open: %+v err=%v", open, err)
	}
	resolved, err := service.ListTodos(nil, uid, created.TaskId, billflow.TODO_STATUS_RESOLVED, nil, 20)
	if err != nil || resolved == nil || len(resolved.Items) != 1 || resolved.Items[0].CategoryId != leafId {
		t.Fatalf("classified todo preview: %+v err=%v", resolved, err)
	}
	restored, err := service.ResolveTodo(nil, billflow.ResolveTodoRequest{
		Uid: uid, TodoId: resolved.Items[0].TodoId, ExpectedVersion: resolved.Items[0].Version,
		Status: billflow.TODO_STATUS_OPEN, IdempotencyKey: "restore-todo-1",
	})
	if err != nil || restored == nil || restored.Status != billflow.TODO_STATUS_OPEN {
		t.Fatalf("restore classified todo: %+v err=%v", restored, err)
	}
	reopened, err := service.GetTask(nil, uid, created.TaskId)
	if err != nil || reopened == nil || reopened.TodoOpenCount != 1 {
		t.Fatalf("restore did not reopen count: %+v err=%v", reopened, err)
	}
	assigned, err = service.AssignTodoCategories(nil, billflow.AssignTodoCategoryRequest{
		Uid: uid, CategoryId: leafId, IdempotencyKey: "assign-category-2",
		Items: []billflow.AssignTodoCategoryItem{{TodoId: restored.TodoId, ExpectedVersion: restored.Version}},
	})
	if err != nil || assigned == nil || assigned.TodoOpenCount != 0 {
		t.Fatalf("reassign after restore: %+v err=%v", assigned, err)
	}

	posted, err := service.ConfirmPost(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: assigned.Version, IdempotencyKey: "confirm-post-1", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || posted.Status != billflow.TASK_STATUS_READY || poster.calls != 1 {
		t.Fatalf("confirm_post: %+v calls=%d err=%v", posted, poster.calls, err)
	}
	assertAutoPostedCategory(t, poster.last.Commands, 801, leafId)
}

func TestServiceAutoPostCrossSourceAndUndoGuard(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	if err := repository.DoTransaction(nil, uid, func(tx *billflow.RepositoryTransaction) error {
		ready := testTask(uid, 1, 10)
		ready.Status = billflow.TASK_STATUS_READY
		return tx.InsertTask(ready)
	}); err != nil {
		t.Fatalf("insert prior ready task: %v", err)
	}

	accountId := int64(61)
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{
		postableRow(uid, 401, 801, 201, accountId, "餐饮美食"),
	})
	evidence.addFile(uid, 302, 402, []*importing.RawImportRow{
		postableRow(uid, 402, 802, 202, accountId, "餐饮美食"),
	})
	amount := *evidence.rows[401][0].NormalizedAmount
	*evidence.rows[402][0].NormalizedAmount = amount
	*evidence.rows[402][0].NormalizedUnixTime = *evidence.rows[401][0].NormalizedUnixTime
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {mappedGroup(accountId, 801)},
		402: {mappedGroup(accountId, 802)},
	}}
	poster := &fakePoster{}
	undo := &fakeUndo{can: false, reasons: []string{"transaction_modified"}}
	reconciler := &fakeReconciler{detail: &reconciliation.CaseDetail{
		CaseSummary: &reconciliation.CaseSummary{
			CaseId: 77, Status: reconciliation.CASE_STATUS_OPEN, Version: 3,
			SuggestedRelationType: reconciliation.DECISION_TYPE_SAME_EVENT,
		},
		Members: []*reconciliation.CaseMemberDetail{
			{Evidence: []*reconciliation.CaseEvidenceSummary{{RowId: 801}}},
			{Evidence: []*reconciliation.CaseEvidenceSummary{{RowId: 802}}},
		},
	}}
	var nextId int64 = 7000
	service, err := billflow.NewService(repository, evidence, payments, poster, reconciler, nil, nil, &fakeCategories{leaves: []billflow.CategoryLeaf{
		{CategoryId: 51, Name: "餐饮美食"},
	}}, undo, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}

	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301, 302}, IdempotencyKey: "create-task-2"})
	if err != nil || created.ConfirmPolicy != billflow.CONFIRM_POLICY_AUTO_POST {
		t.Fatalf("daily task should auto post: %+v err=%v", created, err)
	}
	ran, err := service.RunTask(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, IdempotencyKey: "run-task-2", CreatedIp: "192.0.2.10"}, time.UTC)
	if err != nil || ran.Status != billflow.TASK_STATUS_READY || poster.calls != 2 {
		t.Fatalf("auto_post run did not post: %+v calls=%d err=%v", ran, poster.calls, err)
	}
	if len(reconciler.decided) != 1 || reconciler.decided[0].DecisionType != reconciliation.DECISION_TYPE_SAME_EVENT {
		t.Fatalf("unique high-confidence case was not auto decided: %+v", reconciler.decided)
	}

	_, err = service.UndoTask(nil, billflow.UndoTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: ran.Version, IdempotencyKey: "undo-task-2"})
	if !errors.Is(err, billflow.ErrServiceActionRequired) {
		t.Fatalf("blocked undo did not require action: %v", err)
	}
	failed, err := service.GetTask(nil, uid, created.TaskId)
	if err != nil || failed.Status != billflow.TASK_STATUS_FAILED {
		t.Fatalf("blocked undo did not mark task failed: %+v err=%v", failed, err)
	}
}

func TestServiceCreateAccountAndAmbiguousCrossSource(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{
		postableRow(uid, 401, 801, 201, 0, "餐饮美食"),
	})
	evidence.rows[401][0].LedgerAccountId = nil
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {{SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", DisplayName: "花呗", RowCount: 1, PendingRowCount: 1, SampleRowId: 801}},
	}}
	accounts := &fakeAccounts{nextID: 88}
	undo := &fakeUndo{can: true}
	reconciler := &fakeReconciler{detail: &reconciliation.CaseDetail{
		CaseSummary: &reconciliation.CaseSummary{
			CaseId: 91, Status: reconciliation.CASE_STATUS_OPEN, Version: 1,
			SuggestedRelationType: reconciliation.DECISION_TYPE_INTERNAL_TRANSFER,
		},
		Members: []*reconciliation.CaseMemberDetail{{Evidence: []*reconciliation.CaseEvidenceSummary{{RowId: 801}}}},
	}}
	var nextId int64 = 6000
	service, err := billflow.NewService(repository, evidence, payments, &fakePoster{}, reconciler, nil, accounts, &fakeCategories{}, undo, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}
	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-3"})
	if err != nil || created.Status != billflow.TASK_STATUS_ACCOUNTS_PENDING {
		t.Fatalf("unmapped payment should wait for account: %+v err=%v", created, err)
	}
	view, err := service.CreateTaskAccount(nil, billflow.CreateAccountRequest{
		Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, SampleRowId: 801,
		Name: "花呗", Category: models.ACCOUNT_CATEGORY_CREDIT_CARD, Currency: "CNY", IdempotencyKey: "create-account-1",
	})
	if err != nil || len(view.NeedsCreate) != 0 || len(view.Reused) != 1 {
		t.Fatalf("create account did not map group: %+v err=%v", view, err)
	}
	task, err := service.GetTask(nil, uid, created.TaskId)
	if err != nil || task.ConfirmPolicy != billflow.CONFIRM_POLICY_CONFIRM_THEN_POST {
		t.Fatalf("new account should force confirm_then_post: %+v err=%v", task, err)
	}
	evidence.rows[401][0].LedgerAccountId = int64Ptr(88)
	ran, err := service.RunTask(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: task.Version, IdempotencyKey: "run-task-3"}, time.UTC)
	if err != nil {
		t.Fatalf("run after account create: %v", err)
	}
	todos, err := service.ListTodos(nil, uid, created.TaskId, billflow.TODO_STATUS_OPEN, nil, 20)
	if err != nil || !hasTodoKind(todos, billflow.TODO_KIND_CROSS_SOURCE_AMBIGUOUS) {
		t.Fatalf("non-unique cross-source did not open todo: %+v err=%v", todos, err)
	}
	if len(reconciler.decided) != 0 {
		t.Fatalf("ambiguous case was auto decided: %+v", reconciler.decided)
	}
	_ = ran
}

func TestServiceExcludeAccountSkipsPostingAndCanRestore(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{
		postableRow(uid, 401, 801, 201, 0, "餐饮美食"),
	})
	evidence.rows[401][0].LedgerAccountId = nil
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {{SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", DisplayName: "花呗", RowCount: 1, PendingRowCount: 1, SampleRowId: 801}},
	}}
	poster := &fakePoster{}
	var nextId int64 = 7000
	service, err := billflow.NewService(repository, evidence, payments, poster, &fakeReconciler{}, nil, &fakeAccounts{nextID: 88}, &fakeCategories{}, &fakeUndo{can: true}, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}
	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-exclude"})
	if err != nil || created.Status != billflow.TASK_STATUS_ACCOUNTS_PENDING {
		t.Fatalf("unmapped payment should wait for account: %+v err=%v", created, err)
	}
	excluded, err := service.ExcludeTaskAccount(nil, billflow.ExcludeAccountRequest{
		Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, SampleRowId: 801, IdempotencyKey: "exclude-account-1",
	})
	if err != nil || len(excluded.NeedsCreate) != 0 || len(excluded.Excluded) != 1 || !excluded.Excluded[0].Excluded {
		t.Fatalf("exclude did not move group out of needs-create: %+v err=%v", excluded, err)
	}
	task, err := service.GetTask(nil, uid, created.TaskId)
	if err != nil || task.Status != billflow.TASK_STATUS_RECEIVING {
		t.Fatalf("excluded group should not keep accounts_pending: %+v err=%v", task, err)
	}
	ran, err := service.RunTask(nil, billflow.RunTaskRequest{Uid: uid, TaskId: created.TaskId, ExpectedVersion: task.Version, IdempotencyKey: "run-after-exclude"}, time.UTC)
	if err != nil {
		t.Fatalf("run after exclude: %v", err)
	}
	if poster.calls != 0 {
		t.Fatalf("excluded group was posted: %+v", poster.last)
	}
	_ = ran
	restored, err := service.RestoreTaskAccount(nil, billflow.ExcludeAccountRequest{
		Uid: uid, TaskId: created.TaskId, ExpectedVersion: ran.Version, SampleRowId: 801, IdempotencyKey: "restore-account-1",
	})
	if err != nil || len(restored.NeedsCreate) != 1 || len(restored.Excluded) != 0 {
		t.Fatalf("restore did not return group to needs-create: %+v err=%v", restored, err)
	}
}

func TestServiceSkipRowsDoesNotPersistWholeGroup(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	uid := int64(1001)
	evidence := newFakeEvidence(uid, 301, 401, []*importing.RawImportRow{
		postableRow(uid, 401, 801, 201, 0, "餐饮美食"),
		postableRow(uid, 401, 802, 202, 0, "餐饮美食"),
	})
	evidence.rows[401][0].LedgerAccountId = nil
	evidence.rows[401][1].LedgerAccountId = nil
	payments := &fakePayments{groups: map[int64][]*importing.PaymentAccountGroup{
		401: {{SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", DisplayName: "花呗", RowCount: 2, PendingRowCount: 2, SampleRowId: 801}},
	}}
	var nextId int64 = 8000
	service, err := billflow.NewService(repository, evidence, payments, &fakePoster{}, &fakeReconciler{}, nil, &fakeAccounts{nextID: 88}, &fakeCategories{}, &fakeUndo{can: true}, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create billflow service: %v", err)
	}
	created, err := service.CreateTask(nil, billflow.CreateTaskRequest{Uid: uid, FileIds: []int64{301}, IdempotencyKey: "create-task-skip-rows"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	skipped, err := service.SkipTaskAccountRows(nil, billflow.SkipAccountRowsRequest{
		Uid: uid, TaskId: created.TaskId, ExpectedVersion: created.Version, SampleRowId: 801, RowIds: []int64{801}, IdempotencyKey: "skip-rows-1",
	})
	if err != nil || len(skipped.NeedsCreate) != 1 || skipped.NeedsCreate[0].PendingRowCount != 1 || len(skipped.Excluded) != 0 {
		t.Fatalf("skipping one row persisted or hid the group: %+v err=%v", skipped, err)
	}
}

type fakeEvidence struct {
	files     map[int64]*importing.ImportFile
	batches   map[int64][]*importing.ImportBatch
	batchById map[int64]*importing.ImportBatch
	rows      map[int64][]*importing.RawImportRow
}

func newFakeEvidence(uid, fileId, batchId int64, rows []*importing.RawImportRow) *fakeEvidence {
	evidence := &fakeEvidence{
		files:     map[int64]*importing.ImportFile{},
		batches:   map[int64][]*importing.ImportBatch{},
		batchById: map[int64]*importing.ImportBatch{},
		rows:      map[int64][]*importing.RawImportRow{},
	}
	evidence.addFile(uid, fileId, batchId, rows)
	return evidence
}

func (f *fakeEvidence) addFile(uid, fileId, batchId int64, rows []*importing.RawImportRow) {
	f.files[fileId] = &importing.ImportFile{Uid: uid, FileId: fileId}
	batch := &importing.ImportBatch{Uid: uid, FileId: fileId, BatchId: batchId, Status: importing.IMPORT_BATCH_STATUS_READY, SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY}
	f.batches[fileId] = []*importing.ImportBatch{batch}
	f.batchById[batchId] = batch
	f.rows[batchId] = rows
}

func (f *fakeEvidence) FindImportFileById(_ core.Context, uid int64, fileId int64) (*importing.ImportFile, error) {
	file := f.files[fileId]
	if file == nil || file.Uid != uid {
		return nil, nil
	}
	return file, nil
}
func (f *fakeEvidence) FindLatestImportBatchByFileId(_ core.Context, uid int64, fileId int64) (*importing.ImportBatch, error) {
	batches := f.batches[fileId]
	if len(batches) == 0 || batches[0].Uid != uid {
		return nil, nil
	}
	return batches[0], nil
}
func (f *fakeEvidence) ListImportBatches(_ core.Context, uid int64, fileId int64, _ int, _ int) ([]*importing.ImportBatch, int64, error) {
	items := make([]*importing.ImportBatch, 0)
	for _, batch := range f.batches[fileId] {
		if batch != nil && batch.Uid == uid {
			items = append(items, batch)
		}
	}
	return items, int64(len(items)), nil
}
func (f *fakeEvidence) FindImportBatchById(_ core.Context, uid int64, batchId int64) (*importing.ImportBatch, error) {
	batch := f.batchById[batchId]
	if batch == nil || batch.Uid != uid {
		return nil, nil
	}
	return batch, nil
}
func (f *fakeEvidence) ListRawImportRows(_ core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error) {
	rows := make([]*importing.RawImportRow, 0)
	for _, row := range f.rows[batchId] {
		if row != nil && row.Uid == uid {
			rows = append(rows, row)
		}
	}
	return rows, nil
}
func (f *fakeEvidence) FindRawImportRowById(_ core.Context, uid int64, rowId int64) (*importing.RawImportRow, error) {
	for _, rows := range f.rows {
		for _, row := range rows {
			if row != nil && row.Uid == uid && row.RowId == rowId {
				return row, nil
			}
		}
	}
	return nil, nil
}

type fakePayments struct {
	groups map[int64][]*importing.PaymentAccountGroup
}

func (f *fakePayments) ListBatchPaymentAccounts(_ core.Context, _ int64, batchId int64) ([]*importing.PaymentAccountGroup, error) {
	return f.groups[batchId], nil
}
func (f *fakePayments) ConfirmBatchPaymentAccount(_ core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error) {
	for _, groups := range f.groups {
		for _, group := range groups {
			if group != nil && group.SampleRowId == request.RowId {
				id := request.LedgerAccountId
				group.LedgerAccountId = &id
				group.Mapped = true
				return group, nil
			}
		}
	}
	return nil, errors.New("payment group not found")
}
func (f *fakePayments) ApplyPersistedExclusions(_ core.Context, _ int64, _ int64) error {
	return nil
}
func (f *fakePayments) ExcludePaymentAccount(_ core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error) {
	return f.setGroupExcluded(request.RowId, true)
}
func (f *fakePayments) RestorePaymentAccount(_ core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error) {
	return f.setGroupExcluded(request.RowId, false)
}
func (f *fakePayments) SkipPaymentAccountRows(_ core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error) {
	group, err := f.findGroup(request.RowId)
	if err != nil {
		return nil, err
	}
	skipped := int64(len(request.RowIds))
	if skipped < 1 {
		return nil, errors.New("payment rows not found")
	}
	if group.PendingRowCount < skipped {
		group.PendingRowCount = 0
	} else {
		group.PendingRowCount -= skipped
	}
	group.SkippedRowCount += skipped
	return group, nil
}
func (f *fakePayments) RestorePaymentAccountRows(_ core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error) {
	group, err := f.findGroup(request.RowId)
	if err != nil {
		return nil, err
	}
	restored := int64(len(request.RowIds))
	group.PendingRowCount += restored
	if group.SkippedRowCount < restored {
		group.SkippedRowCount = 0
	} else {
		group.SkippedRowCount -= restored
	}
	return group, nil
}
func (f *fakePayments) ListPaymentAccountGroupRows(_ core.Context, _ int64, batchId int64, sampleRowId int64) ([]*importing.PaymentAccountRowView, error) {
	group, err := f.findGroup(sampleRowId)
	if err != nil {
		return nil, err
	}
	return []*importing.PaymentAccountRowView{{
		RowId: sampleRowId, BatchId: batchId, Currency: group.Currency, Direction: importing.NORMALIZED_DIRECTION_EXPENSE,
		Label: group.DisplayName, Skipped: group.Excluded || group.PendingRowCount == 0,
	}}, nil
}
func (f *fakePayments) setGroupExcluded(sampleRowId int64, excluded bool) (*importing.PaymentAccountGroup, error) {
	group, err := f.findGroup(sampleRowId)
	if err != nil {
		return nil, err
	}
	group.Excluded = excluded
	if excluded {
		group.SkippedRowCount += group.PendingRowCount
		group.PendingRowCount = 0
	} else {
		group.PendingRowCount += group.SkippedRowCount
		group.SkippedRowCount = 0
	}
	return group, nil
}
func (f *fakePayments) findGroup(sampleRowId int64) (*importing.PaymentAccountGroup, error) {
	for _, groups := range f.groups {
		for _, group := range groups {
			if group != nil && group.SampleRowId == sampleRowId {
				return group, nil
			}
		}
	}
	return nil, errors.New("payment group not found")
}

type fakePoster struct {
	calls int
	last  importing.PostImportBatchRequest
}

func (f *fakePoster) PostImportBatch(_ core.Context, request importing.PostImportBatchRequest, _ *time.Location) (*importing.ImportPostingResult, error) {
	f.calls++
	f.last = request
	return &importing.ImportPostingResult{Posting: &importing.ImportPosting{CreatedTransactionCount: int64(len(request.Commands))}}, nil
}

type fakeReconciler struct {
	detail  *reconciliation.CaseDetail
	decided []reconciliation.DecideCaseRequest
}

func (f *fakeReconciler) GenerateCandidates(_ core.Context, _ reconciliation.GenerateCandidatesRequest) (*reconciliation.GenerateCandidatesResult, error) {
	if f.detail == nil {
		return &reconciliation.GenerateCandidatesResult{}, nil
	}
	return &reconciliation.GenerateCandidatesResult{Cases: []*reconciliation.Case{{CaseId: f.detail.CaseId}}}, nil
}
func (f *fakeReconciler) GetCase(_ core.Context, _ int64, caseId int64) (*reconciliation.CaseDetail, error) {
	if f.detail == nil || f.detail.CaseId != caseId {
		return nil, nil
	}
	return f.detail, nil
}
func (f *fakeReconciler) DecideCase(_ core.Context, request reconciliation.DecideCaseRequest, _ *time.Location) (*reconciliation.DecisionResult, error) {
	f.decided = append(f.decided, request)
	return &reconciliation.DecisionResult{CaseId: request.CaseId, DecisionType: request.DecisionType}, nil
}

type fakeCategories struct {
	leaves []billflow.CategoryLeaf
}

func (f *fakeCategories) ListVisibleLeafCategories(_ core.Context, _ int64) ([]billflow.CategoryLeaf, error) {
	return f.leaves, nil
}

type fakeAccounts struct {
	nextID int64
}

func (f *fakeAccounts) CreateAccount(_ core.Context, _ int64, _ string, _ models.AccountCategory, _ string) (int64, error) {
	return f.nextID, nil
}
func (f *fakeAccounts) LoadAccount(_ core.Context, _ int64, accountId int64) (*billflow.AccountSnapshot, error) {
	return &billflow.AccountSnapshot{AccountId: accountId, Currency: "CNY"}, nil
}

type fakeUndo struct {
	can     bool
	reasons []string
	reverse int
}

func (f *fakeUndo) Inspect(_ core.Context, _ int64, _ []int64) (*billflow.UndoInspection, error) {
	return &billflow.UndoInspection{CanReverse: f.can, AutoPostedCount: 1, ReasonCodes: f.reasons}, nil
}
func (f *fakeUndo) Reverse(_ core.Context, _ int64, _ *billflow.UndoInspection) error {
	f.reverse++
	if !f.can {
		return errors.New("cannot reverse")
	}
	return nil
}

func postableRow(uid, batchId, rowId, identityId, accountId int64, category string) *importing.RawImportRow {
	now := int64(1_700_000_000)
	amount := int64(123)
	row := &importing.RawImportRow{
		Uid: uid, BatchId: batchId, RowId: rowId, IdentityId: int64Ptr(identityId),
		ParseState: importing.PARSE_STATE_VALID, IdentityState: importing.IDENTITY_STATE_NEW,
		ProcessingState: importing.PROCESSING_STATE_PENDING, SemanticEligibility: importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		Disposition: importing.IMPORT_DISPOSITION_POSTABLE, EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL,
		NormalizedUnixTime: &now, NormalizedAmount: &amount, Currency: "CNY",
		NormalizedDirection: importing.NORMALIZED_DIRECTION_EXPENSE, NormalizedTransactionType: importing.SOURCE_TRANSACTION_TYPE_PAYMENT,
		RawTransactionType: category,
	}
	if accountId > 0 {
		row.LedgerAccountId = int64Ptr(accountId)
	}
	return row
}

func mappedGroup(accountId, sampleRowId int64) *importing.PaymentAccountGroup {
	id := accountId
	return &importing.PaymentAccountGroup{
		SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", DisplayName: "余额宝",
		RowCount: 1, PendingRowCount: 1, SampleRowId: sampleRowId, LedgerAccountId: &id, Mapped: true,
	}
}

func hasTodoKind(page *billflow.TodoListResult, kind billflow.TodoKind) bool {
	if page == nil {
		return false
	}
	for _, todo := range page.Items {
		if todo != nil && todo.TodoKind == kind {
			return true
		}
	}
	return false
}

func assertAutoPostedUncategorized(t *testing.T, commands []importing.PostingIdentityCommand, rowId int64) {
	t.Helper()
	for _, command := range commands {
		if !containsRow(command.RowIds, rowId) {
			continue
		}
		if !command.AutoPosted || command.Draft == nil || command.Draft.CategoryId != 0 || !command.Draft.AllowUncategorized {
			t.Fatalf("row %d was not auto-posted uncategorized: %+v", rowId, command)
		}
		return
	}
	t.Fatalf("missing command for row %d", rowId)
}

func assertAutoPostedCategory(t *testing.T, commands []importing.PostingIdentityCommand, rowId int64, categoryId int64) {
	t.Helper()
	for _, command := range commands {
		if !containsRow(command.RowIds, rowId) {
			continue
		}
		if !command.AutoPosted || command.Draft == nil || command.Draft.CategoryId != categoryId {
			t.Fatalf("row %d category = %+v, want %d", rowId, command.Draft, categoryId)
		}
		return
	}
	t.Fatalf("missing command for row %d", rowId)
}

func containsRow(ids []int64, rowId int64) bool {
	for _, id := range ids {
		if id == rowId {
			return true
		}
	}
	return false
}

func int64Ptr(value int64) *int64 { return &value }
