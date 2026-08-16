package billflow_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/migrations"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

func TestRepositorySQLiteUIDIsolationPaginationCASAndRollback(t *testing.T) {
	repository, _ := newSQLiteBillflowRepository(t)
	const firstUid = int64(1001)
	const secondUid = int64(2002)

	if err := repository.DoTransaction(nil, firstUid, func(tx *billflow.RepositoryTransaction) error {
		if err := tx.InsertTask(testTask(firstUid, 101, 10)); err != nil {
			return err
		}
		if err := tx.InsertTask(testTask(firstUid, 102, 11)); err != nil {
			return err
		}
		if err := tx.InsertMember(testTaskMember(firstUid, 101, 201, 0, 301, 401, 10)); err != nil {
			return err
		}
		if err := tx.InsertTodo(testTodo(firstUid, 101, 501, billflow.TODO_KIND_UNCATEGORIZED, billflow.SUBJECT_KIND_TRANSACTION, 801, 10)); err != nil {
			return err
		}
		return tx.InsertTodo(testTodo(firstUid, 101, 502, billflow.TODO_KIND_TRANSFER_UNCLEAR, billflow.SUBJECT_KIND_RAW_ROW, 802, 11))
	}); err != nil {
		t.Fatalf("insert first-user billflow fixtures: %v", err)
	}

	if err := repository.DoTransaction(nil, secondUid, func(tx *billflow.RepositoryTransaction) error {
		return tx.InsertTask(testTask(secondUid, 201, 20))
	}); err != nil {
		t.Fatalf("insert second-user billflow fixture: %v", err)
	}

	firstPage, err := repository.ListTasks(nil, firstUid, billflow.TASK_STATUS_RECEIVING, nil, 1)
	if err != nil || len(firstPage.Items) != 1 || firstPage.Items[0].TaskId != 102 || firstPage.NextCursor == nil {
		t.Fatalf("first task page is not stable: page=%+v err=%v", firstPage, err)
	}

	secondPage, err := repository.ListTasks(nil, firstUid, billflow.TASK_STATUS_RECEIVING, firstPage.NextCursor, 1)
	if err != nil || len(secondPage.Items) != 1 || secondPage.Items[0].TaskId != 101 || secondPage.NextCursor != nil {
		t.Fatalf("second task page is not stable: page=%+v err=%v", secondPage, err)
	}

	if task, findErr := repository.FindTaskById(nil, firstUid, 201); findErr != nil || task != nil {
		t.Fatalf("cross-user task was visible: task=%+v err=%v", task, findErr)
	}

	members, err := repository.ListMembers(nil, firstUid, 101)
	if err != nil || len(members) != 1 || members[0].BatchId != 401 {
		t.Fatalf("owned members were not listed: members=%+v err=%v", members, err)
	}
	if members, findErr := repository.ListMembers(nil, secondUid, 101); findErr != nil || len(members) != 0 {
		t.Fatalf("cross-user members were visible: members=%+v err=%v", members, findErr)
	}

	todoPage, err := repository.ListTodos(nil, firstUid, 101, billflow.TODO_STATUS_OPEN, nil, 1)
	if err != nil || len(todoPage.Items) != 1 || todoPage.Items[0].TodoId != 502 || todoPage.NextCursor == nil {
		t.Fatalf("first todo page is not stable: page=%+v err=%v", todoPage, err)
	}
	todoPage, err = repository.ListTodos(nil, firstUid, 101, billflow.TODO_STATUS_OPEN, todoPage.NextCursor, 1)
	if err != nil || len(todoPage.Items) != 1 || todoPage.Items[0].TodoId != 501 || todoPage.NextCursor != nil {
		t.Fatalf("second todo page is not stable: page=%+v err=%v", todoPage, err)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *billflow.RepositoryTransaction) error {
		task, findErr := tx.FindTaskById(101)
		if findErr != nil || task == nil {
			return errors.New("owned task is missing in transaction")
		}

		next := *task
		next.Status = billflow.TASK_STATUS_PROCESSING
		next.Version = 2
		next.UpdatedUnixTime = 12
		updated, updateErr := tx.UpdateTaskCAS(1, &next)
		if updateErr != nil || !updated {
			return errors.New("owned task CAS failed")
		}

		updated, updateErr = tx.UpdateTaskCAS(1, &next)
		if updateErr != nil || updated {
			return errors.New("stale task CAS succeeded")
		}

		crossUser := *testTask(firstUid, 201, 100)
		crossUser.Version = 2
		updated, updateErr = tx.UpdateTaskCAS(1, &crossUser)
		if updateErr != nil || updated {
			return errors.New("cross-user task CAS succeeded")
		}

		todoNext := *testTodo(firstUid, 101, 501, billflow.TODO_KIND_UNCATEGORIZED, billflow.SUBJECT_KIND_TRANSACTION, 801, 10)
		todoNext.Status = billflow.TODO_STATUS_RESOLVED
		todoNext.Version = 2
		todoNext.UpdatedUnixTime = 13
		resolved := int64(13)
		todoNext.ResolvedUnixTime = &resolved
		updated, updateErr = tx.UpdateTodoCAS(1, &todoNext)
		if updateErr != nil || !updated {
			return errors.New("owned todo CAS failed")
		}
		return nil
	}); err != nil {
		t.Fatalf("exercise task and todo CAS: %v", err)
	}

	resolvedPage, err := repository.ListTodos(nil, firstUid, 101, billflow.TODO_STATUS_RESOLVED, nil, 10)
	if err != nil || len(resolvedPage.Items) != 1 || resolvedPage.Items[0].TodoId != 501 || resolvedPage.Items[0].ResolvedUnixTime == nil {
		t.Fatalf("resolved todo was not visible: page=%+v err=%v", resolvedPage, err)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *billflow.RepositoryTransaction) error {
		duplicateFile := testTaskMember(firstUid, 101, 202, 1, 301, 402, 12)
		if err := tx.InsertMember(duplicateFile); err == nil {
			return errors.New("duplicate task file member was accepted")
		}
		duplicateBatch := testTaskMember(firstUid, 102, 203, 0, 303, 401, 12)
		if err := tx.InsertMember(duplicateBatch); err == nil {
			return errors.New("duplicate batch member was accepted")
		}
		return nil
	}); err != nil {
		t.Fatalf("unique member constraints were not enforced: %v", err)
	}

	if err := repository.DoTransaction(nil, firstUid, func(tx *billflow.RepositoryTransaction) error {
		if err := tx.DeleteMembersByTask(101); err != nil {
			return err
		}
		if err := tx.InsertMember(testTaskMember(firstUid, 101, 204, 0, 304, 404, 13)); err != nil {
			return err
		}
		return tx.DeleteTodosByTask(101)
	}); err != nil {
		t.Fatalf("replace task members: %v", err)
	}
	replaced, err := repository.ListMembers(nil, firstUid, 101)
	if err != nil || len(replaced) != 1 || replaced[0].FileId != 304 || replaced[0].BatchId != 404 {
		t.Fatalf("replaced members: %+v err=%v", replaced, err)
	}

	rollbackErr := errors.New("rollback billflow repository transaction")
	err = repository.DoTransaction(nil, firstUid, func(tx *billflow.RepositoryTransaction) error {
		if err := tx.InsertTask(testTask(firstUid, 999, 200)); err != nil {
			return err
		}
		return rollbackErr
	})
	if !errors.Is(err, rollbackErr) {
		t.Fatalf("transaction did not return rollback cause: %v", err)
	}
	if task, findErr := repository.FindTaskById(nil, firstUid, 999); findErr != nil || task != nil {
		t.Fatalf("rolled-back task remained visible: task=%+v err=%v", task, findErr)
	}
}

func TestRepositorySQLiteConcurrentActionAndAliasAdjudication(t *testing.T) {
	repository, _ := newSQLiteBillflowRepositoryWithConnections(t, 8)
	const uid = int64(3003)
	if err := repository.DoTransaction(nil, uid, func(tx *billflow.RepositoryTransaction) error {
		return tx.InsertTask(testTask(uid, 100, 10))
	}); err != nil {
		t.Fatalf("insert concurrent action task: %v", err)
	}

	const workers = 8
	digest := strings.Repeat("8", 64)
	requestDigest := strings.Repeat("9", 64)
	type actionResult struct {
		actionId int64
		created  bool
		err      error
	}
	actionResults := make(chan actionResult, workers)
	start := make(chan struct{})
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			action, created, err := repository.CreateOrFindAction(nil, testAction(uid, 100, int64(1000+worker), digest, requestDigest, int64(100+worker)))
			result := actionResult{created: created, err: err}
			if action != nil {
				result.actionId = action.ActionId
			}
			actionResults <- result
		}()
	}
	close(start)
	group.Wait()
	close(actionResults)

	winnerActionId := int64(0)
	createdCount := 0
	for result := range actionResults {
		if result.err != nil || result.actionId < 1 {
			t.Fatalf("concurrent action persistence failed: %+v", result)
		}
		if winnerActionId == 0 {
			winnerActionId = result.actionId
		} else if result.actionId != winnerActionId {
			t.Fatalf("concurrent actions did not converge: first=%d result=%+v", winnerActionId, result)
		}
		if result.created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent action unique constraint produced %d creators", createdCount)
	}

	_, _, conflictErr := repository.CreateOrFindAction(nil, testAction(uid, 100, 2000, digest, strings.Repeat("a", 64), 200))
	if !errors.Is(conflictErr, billflow.ErrActionRequestConflict) {
		t.Fatalf("same key with a different request digest was accepted: %v", conflictErr)
	}

	aliasKey := strings.Repeat("b", 64)
	aliasResults := make(chan struct {
		mappingId int64
		created   bool
		err       error
	}, workers)
	start = make(chan struct{})
	group = sync.WaitGroup{}
	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			mapping, created, err := repository.CreateOrFindCategoryAlias(nil, testCategoryAlias(uid, int64(3000+worker), aliasKey, int64(10+worker)))
			result := struct {
				mappingId int64
				created   bool
				err       error
			}{created: created, err: err}
			if mapping != nil {
				result.mappingId = mapping.MappingId
			}
			aliasResults <- result
		}()
	}
	close(start)
	group.Wait()
	close(aliasResults)

	winnerMappingId := int64(0)
	aliasCreated := 0
	for result := range aliasResults {
		if result.err != nil || result.mappingId < 1 {
			t.Fatalf("concurrent category alias persistence failed: mappingId=%d created=%t err=%v", result.mappingId, result.created, result.err)
		}
		if winnerMappingId == 0 {
			winnerMappingId = result.mappingId
		} else if result.mappingId != winnerMappingId {
			t.Fatalf("concurrent category aliases did not converge: first=%d result=%+v", winnerMappingId, result)
		}
		if result.created {
			aliasCreated++
		}
	}
	if aliasCreated != 1 {
		t.Fatalf("concurrent category alias unique constraint produced %d creators", aliasCreated)
	}
}

func newSQLiteBillflowRepository(t *testing.T) (*billflow.Repository, *datastore.Database) {
	return newSQLiteBillflowRepositoryWithConnections(t, 1)
}

func newSQLiteBillflowRepositoryWithConnections(t *testing.T, maxOpenConnections uint16) (*billflow.Repository, *datastore.Database) {
	t.Helper()
	database, err := datastore.OpenDatabase(&settings.DatabaseConfig{
		DatabaseType:          settings.Sqlite3DbType,
		DatabasePath:          filepath.Join(t.TempDir(), "billflow.db"),
		MaxIdleConnection:     1,
		MaxOpenConnection:     maxOpenConnections,
		ConnectionMaxLifeTime: 60,
	})
	if err != nil {
		t.Fatalf("open SQLite billflow database: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close SQLite billflow database: %v", err)
		}
	})

	store, err := datastore.NewDataStore(database)
	if err != nil {
		t.Fatalf("create SQLite billflow store: %v", err)
	}
	if err := migrations.Upgrade(nil, store, migrations.ApplicationInfo{Version: "test", Commit: "billflow-db-701"}); err != nil {
		t.Fatalf("upgrade SQLite billflow schema: %v", err)
	}

	repository, err := billflow.NewRepository(store)
	if err != nil {
		t.Fatalf("create SQLite billflow repository: %v", err)
	}
	return repository, database
}

func testTask(uid int64, taskId int64, now int64) *billflow.Task {
	return &billflow.Task{
		Uid:             uid,
		Status:          billflow.TASK_STATUS_RECEIVING,
		ConfirmPolicy:   billflow.CONFIRM_POLICY_CONFIRM_THEN_POST,
		Version:         1,
		CreatedUnixTime: now,
		UpdatedUnixTime: now,
		TaskId:          taskId,
	}
}

func testTaskMember(uid int64, taskId int64, memberId int64, order int64, fileId int64, batchId int64, now int64) *billflow.TaskMember {
	return &billflow.TaskMember{
		Uid:             uid,
		TaskId:          taskId,
		MemberOrder:     order,
		FileId:          fileId,
		BatchId:         batchId,
		CreatedUnixTime: now,
		MemberId:        memberId,
	}
}

func testAction(uid int64, taskId int64, actionId int64, idempotencyDigest string, requestDigest string, now int64) *billflow.Action {
	return &billflow.Action{
		Uid:                   uid,
		TaskId:                taskId,
		ExpectedTaskVersion:   1,
		ActionType:            billflow.ACTION_TYPE_CREATE_TASK,
		IdempotencyKeyDigest:  idempotencyDigest,
		IdempotencyKeyVersion: billflow.IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest:         requestDigest,
		RequestDigestVersion:  billflow.ACTION_REQUEST_DIGEST_VERSION_V1,
		Status:                billflow.ACTION_STATUS_READY,
		ReasonCodesJson:       "[]",
		CreatedUnixTime:       now,
		UpdatedUnixTime:       now,
		ActionId:              actionId,
	}
}

func testTodo(uid int64, taskId int64, todoId int64, kind billflow.TodoKind, subjectKind billflow.SubjectKind, subjectId int64, now int64) *billflow.Todo {
	return &billflow.Todo{
		Uid:             uid,
		TaskId:          taskId,
		TodoKind:        kind,
		Status:          billflow.TODO_STATUS_OPEN,
		SubjectKind:     subjectKind,
		SubjectId:       subjectId,
		ReasonCodesJson: "[]",
		Version:         1,
		CreatedUnixTime: now,
		UpdatedUnixTime: now,
		TodoId:          todoId,
	}
}

func testCategoryAlias(uid int64, mappingId int64, aliasKey string, now int64) *billflow.CategoryAliasMapping {
	return &billflow.CategoryAliasMapping{
		Uid:               uid,
		SourceType:        importing.SOURCE_TYPE_ALIPAY,
		AliasKey:          aliasKey,
		AliasKeyVersion:   billflow.CATEGORY_ALIAS_VERSION_V1,
		LedgerCategoryId:  11,
		MaskedDisplayName: "餐饮美食",
		CreatedUnixTime:   now,
		UpdatedUnixTime:   now,
		MappingId:         mappingId,
	}
}
