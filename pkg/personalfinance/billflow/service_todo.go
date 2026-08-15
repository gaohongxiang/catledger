package billflow

import (
	"strconv"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

type ResolveTodoRequest struct {
	Uid             int64
	TodoId          int64
	ExpectedVersion int64
	Status          TodoStatus
	IdempotencyKey  string
}

func (s *Service) ResolveTodo(c core.Context, request ResolveTodoRequest) (*TodoView, error) {
	if s == nil || s.repository == nil || request.Uid < 1 || request.TodoId < 1 || request.ExpectedVersion < 1 ||
		(request.Status != TODO_STATUS_RESOLVED && request.Status != TODO_STATUS_DISMISSED) || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	todo, err := s.repository.FindTodoById(c, request.Uid, request.TodoId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if todo == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if todo.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	if todo.Status != TODO_STATUS_OPEN {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	task, err := s.requireTask(c, request.Uid, todo.TaskId)
	if err != nil {
		return nil, err
	}
	if err := s.bumpTask(c, request.Uid, todo.TaskId, task.Version, request.IdempotencyKey, ACTION_TYPE_RESOLVE_TODO, []string{
		"resolve_todo", strconv.FormatInt(request.TodoId, 10), string(request.Status),
	}, func(updated *Task) {
		if updated.TodoOpenCount > 0 {
			updated.TodoOpenCount--
		}
	}); err != nil {
		return nil, err
	}
	current, err := s.repository.FindTodoById(c, request.Uid, request.TodoId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if current != nil && current.Status == request.Status {
		return todoView(current), nil
	}
	now := s.now().Unix()
	next := *todo
	next.Status = request.Status
	next.Version = todo.Version + 1
	next.UpdatedUnixTime = now
	next.ResolvedUnixTime = &now
	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		updated, updateErr := tx.UpdateTodoCAS(request.ExpectedVersion, &next)
		if updateErr != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return todoView(&next), nil
}

func todoView(todo *Todo) *TodoView {
	if todo == nil {
		return nil
	}
	return &TodoView{
		TodoId: todo.TodoId, TodoKind: todo.TodoKind, Status: todo.Status, SubjectKind: todo.SubjectKind,
		SubjectId: todo.SubjectId, ReasonCodes: decodeReasonCodes(todo.ReasonCodesJson), Version: todo.Version,
		CreatedUnixTime: todo.CreatedUnixTime, UpdatedUnixTime: todo.UpdatedUnixTime,
	}
}
