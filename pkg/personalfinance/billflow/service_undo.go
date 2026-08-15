package billflow

import (
	"strconv"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

type UndoTaskRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	IdempotencyKey  string
}

func (s *Service) GetUndoImpact(c core.Context, uid int64, taskId int64) (*UndoImpactView, error) {
	if s == nil || s.undo == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	batchIds := make([]int64, 0, len(members))
	for _, member := range members {
		if member != nil {
			batchIds = append(batchIds, member.BatchId)
		}
	}
	inspection, err := s.undo.Inspect(c, uid, batchIds)
	if err != nil || inspection == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return &UndoImpactView{
		CanReverse: inspection.CanReverse, AutoPostedCount: inspection.AutoPostedCount,
		ReusedLinkCount: inspection.ReusedLinkCount, ReasonCodes: inspection.ReasonCodes,
	}, nil
}

func (s *Service) UndoTask(c core.Context, request UndoTaskRequest) (*TaskView, error) {
	if s == nil || s.undo == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	if task.Status != TASK_STATUS_READY && task.Status != TASK_STATUS_AWAITING_CONFIRM {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	members, err := s.repository.ListMembers(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	batchIds := make([]int64, 0, len(members))
	for _, member := range members {
		if member != nil {
			batchIds = append(batchIds, member.BatchId)
		}
	}
	inspection, err := s.undo.Inspect(c, request.Uid, batchIds)
	if err != nil || inspection == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if !inspection.CanReverse {
		_ = s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_UNDO_POST, []string{
			"undo_blocked", strconv.FormatInt(request.TaskId, 10),
		}, func(next *Task) {
			next.Status = TASK_STATUS_FAILED
			next.ErrorCode = string(SERVICE_ERROR_ACTION_REQUIRED)
		})
		return nil, serviceError(ErrServiceActionRequired, SERVICE_ERROR_ACTION_REQUIRED)
	}
	if err := s.undo.Reverse(c, request.Uid, inspection); err != nil {
		return nil, serviceError(ErrServiceActionRequired, SERVICE_ERROR_ACTION_REQUIRED)
	}
	if err := s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_UNDO_POST, []string{
		"undo", strconv.FormatInt(request.TaskId, 10),
	}, func(next *Task) {
		next.Status = TASK_STATUS_RECEIVING
		next.AutoPostedCount = 0
		next.ErrorCode = ""
	}); err != nil {
		return nil, err
	}
	return s.GetTask(c, request.Uid, request.TaskId)
}
