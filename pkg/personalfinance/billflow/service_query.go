package billflow

import (
	"sort"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func (s *Service) GetTask(c core.Context, uid int64, taskId int64) (*TaskView, error) {
	if err := s.refreshAccountStatus(c, uid, taskId); err != nil {
		return nil, err
	}
	task, err := s.requireTask(c, uid, taskId)
	if err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return taskView(task, members), nil
}

func (s *Service) ListTasks(c core.Context, uid int64, status TaskStatus, cursor *TaskCursor, limit int) (*TaskListResult, error) {
	if s == nil || s.repository == nil || uid < 1 || !isTaskStatus(status) || !isValidPageLimit(limit) || !isValidTaskCursor(cursor) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	page, err := s.repository.ListTasks(c, uid, status, cursor, limit)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	result := &TaskListResult{NextCursor: page.NextCursor, Items: make([]*TaskView, 0, len(page.Items))}
	for _, task := range page.Items {
		members, memberErr := s.repository.ListMembers(c, uid, task.TaskId)
		if memberErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		result.Items = append(result.Items, taskView(task, members))
	}
	return result, nil
}

func (s *Service) ListTodos(c core.Context, uid int64, taskId int64, status TodoStatus, cursor *TodoCursor, limit int) (*TodoListResult, error) {
	if s == nil || s.repository == nil || uid < 1 || taskId < 1 || !isTodoStatus(status) || !isValidPageLimit(limit) || !isValidTodoCursor(cursor) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	page, err := s.repository.ListTodos(c, uid, taskId, status, cursor, limit)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	result := &TodoListResult{NextCursor: page.NextCursor, Items: make([]*TodoView, 0, len(page.Items))}
	for _, todo := range page.Items {
		if todo == nil {
			continue
		}
		result.Items = append(result.Items, s.todoView(c, uid, todo))
	}
	return result, nil
}

func (s *Service) ListClassifiedRows(c core.Context, uid int64, taskId int64) ([]*ClassifiedRowView, error) {
	if s == nil || s.repository == nil || s.evidence == nil || uid < 1 || taskId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	rowsByBatch := map[int64][]*importing.RawImportRow{}
	sourceByBatch := map[int64]importing.SourceType{}
	for _, member := range members {
		if member == nil {
			continue
		}
		batch, batchErr := s.evidence.FindImportBatchById(c, uid, member.BatchId)
		if batchErr != nil || batch == nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		sourceByBatch[member.BatchId] = batch.SourceTypeSnapshot
		rows, listErr := s.evidence.ListRawImportRows(c, uid, member.BatchId)
		if listErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		rowsByBatch[member.BatchId] = rows
	}
	categories, err := s.loadCategoryIndex(c, uid, sourceByBatch, rowsByBatch)
	if err != nil {
		return nil, err
	}
	openPage, err := s.listAllTodos(c, uid, taskId, TODO_STATUS_OPEN)
	if err != nil {
		return nil, err
	}
	resolvedPage, err := s.listAllTodos(c, uid, taskId, TODO_STATUS_RESOLVED)
	if err != nil {
		return nil, err
	}
	openByRow := assignableTodosByRow(openPage)
	resolvedByRow := assignableTodosByRow(resolvedPage)
	items := make([]*ClassifiedRowView, 0)
	for batchId, rows := range rowsByBatch {
		sourceType := sourceByBatch[batchId]
		for _, row := range rows {
			if row == nil || row.ProcessingState != importing.PROCESSING_STATE_PENDING {
				continue
			}
			if _, open := openByRow[row.RowId]; open {
				continue
			}
			categoryId, mapped := categories.mapped(sourceType, row)
			if !mapped {
				continue
			}
			view := classifiedRowFromImport(row, categoryId)
			if todo := resolvedByRow[row.RowId]; todo != nil {
				view.TodoId = todo.TodoId
				view.Version = todo.Version
			}
			items = append(items, view)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		left, right := classifiedUnixTime(items[i]), classifiedUnixTime(items[j])
		if left != right {
			return left > right
		}
		return items[i].RowId > items[j].RowId
	})
	if len(items) > 2000 {
		items = items[:2000]
	}
	return items, nil
}

func (s *Service) listAllTodos(c core.Context, uid int64, taskId int64, status TodoStatus) ([]*Todo, error) {
	items := make([]*Todo, 0)
	var cursor *TodoCursor
	for page := 0; page < 50; page++ {
		result, err := s.repository.ListTodos(c, uid, taskId, status, cursor, maximumRepositoryPageSize)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		items = append(items, todoPageItems(result)...)
		if result == nil || result.NextCursor == nil {
			return items, nil
		}
		cursor = result.NextCursor
	}
	return items, nil
}

func todoPageItems(page *TodoPage) []*Todo {
	if page == nil {
		return nil
	}
	return page.Items
}

func assignableTodosByRow(todos []*Todo) map[int64]*Todo {
	byRow := map[int64]*Todo{}
	for _, todo := range todos {
		if todo == nil || todo.SubjectKind != SUBJECT_KIND_RAW_ROW || !canAssignTodoCategory(todo.TodoKind) {
			continue
		}
		byRow[todo.SubjectId] = todo
	}
	return byRow
}

func classifiedRowFromImport(row *importing.RawImportRow, categoryId int64) *ClassifiedRowView {
	preview := &TodoView{}
	attachTodoPreview(preview, row)
	return &ClassifiedRowView{
		RowId: row.RowId, CategoryId: categoryId,
		Label: preview.Label, Item: preview.Item, BillType: preview.BillType,
		Amount: preview.Amount, Currency: preview.Currency, UnixTime: preview.UnixTime, Direction: preview.Direction,
	}
}

func classifiedUnixTime(view *ClassifiedRowView) int64 {
	if view == nil || view.UnixTime == nil {
		return 0
	}
	return *view.UnixTime
}
