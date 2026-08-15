package billflow

import (
	"github.com/mayswind/ezbookkeeping/pkg/core"
)

func (s *Service) requireTask(c core.Context, uid int64, taskId int64) (*Task, error) {
	if s == nil || s.repository == nil || uid < 1 || taskId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.repository.FindTaskById(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if task == nil {
		return nil, serviceError(ErrServiceTaskNotFound, SERVICE_ERROR_TASK_NOT_FOUND)
	}
	return task, nil
}

func (s *Service) beginAction(c core.Context, uid int64, taskId int64, expectedVersion int64, actionType ActionType, idempotencyKey string, parts []string) (*Action, bool, error) {
	if !isValidIdempotencyKey(idempotencyKey) {
		return nil, false, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	now := s.now().Unix()
	candidate := &Action{
		Uid: uid, TaskId: taskId, ExpectedTaskVersion: expectedVersion, ActionType: actionType,
		IdempotencyKeyDigest: digestKey(idempotencyKey), IdempotencyKeyVersion: IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest: digestRequest(parts...), RequestDigestVersion: ACTION_REQUEST_DIGEST_VERSION_V1,
		Status: ACTION_STATUS_READY, ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now,
		ActionId: s.generateId(),
	}
	if candidate.TaskId < 1 {
		return nil, false, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	action, created, err := s.repository.CreateOrFindAction(c, candidate)
	if err != nil {
		if err == ErrActionRequestConflict {
			return nil, false, serviceError(ErrServiceIdempotencyConflict, SERVICE_ERROR_IDEMPOTENCY_CONFLICT)
		}
		return nil, false, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return action, created, nil
}

func (s *Service) bumpTask(c core.Context, uid int64, taskId int64, expectedVersion int64, idempotencyKey string, actionType ActionType, parts []string, mutate func(*Task)) error {
	action, created, err := s.beginAction(c, uid, taskId, expectedVersion, actionType, idempotencyKey, parts)
	if err != nil {
		return err
	}
	if !created {
		if action.Status == ACTION_STATUS_APPLIED {
			return nil
		}
		return serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	return s.applyReadyAction(c, uid, taskId, expectedVersion, action, mutate)
}

func (s *Service) applyReadyAction(c core.Context, uid int64, taskId int64, expectedVersion int64, action *Action, mutate func(*Task)) error {
	task, err := s.requireTask(c, uid, taskId)
	if err != nil {
		return err
	}
	if task.Version != expectedVersion {
		return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	now := s.now().Unix()
	next := cloneTask(task)
	if mutate != nil {
		mutate(next)
	}
	next.Version = task.Version + 1
	next.UpdatedUnixTime = now
	next.CurrentActionId = &action.ActionId
	return s.repository.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		updated, err := tx.UpdateTaskCAS(expectedVersion, next)
		if err != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		applied := cloneAction(action)
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedTaskVersion = next.Version
		applied.UpdatedUnixTime = now
		completed := now
		applied.CompletedUnixTime = &completed
		ok, err := tx.UpdateAction(applied)
		if err != nil || !ok {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		return nil
	})
}
