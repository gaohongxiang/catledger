package billflow

import "github.com/mayswind/ezbookkeeping/pkg/core"

func (s *Service) GetTask(c core.Context, uid int64, taskId int64) (*TaskView, error) {
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
		result.Items = append(result.Items, todoView(todo))
	}
	return result, nil
}
