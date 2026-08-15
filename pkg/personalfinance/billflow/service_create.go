package billflow

import (
	"strconv"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type CreateTaskRequest struct {
	Uid            int64
	FileIds        []int64
	IdempotencyKey string
}

func (s *Service) CreateTask(c core.Context, request CreateTaskRequest) (*TaskView, error) {
	if s == nil || s.repository == nil || s.evidence == nil || request.Uid < 1 || len(request.FileIds) < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	fileIds := uniquePositiveIDs(request.FileIds)
	if len(fileIds) != len(request.FileIds) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}

	bindings := make([]struct {
		fileId  int64
		batchId int64
	}, 0, len(fileIds))
	for _, fileId := range fileIds {
		file, err := s.evidence.FindImportFileById(c, request.Uid, fileId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if file == nil || file.Uid != request.Uid {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		batch, err := s.latestSuccessfulBatch(c, request.Uid, fileId)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, struct {
			fileId  int64
			batchId int64
		}{fileId: fileId, batchId: batch.BatchId})
	}

	parts := []string{"create_task"}
	for _, binding := range bindings {
		parts = append(parts, strconv.FormatInt(binding.fileId, 10), strconv.FormatInt(binding.batchId, 10))
	}
	now := s.now().Unix()
	taskId := s.generateId()
	action, created, err := s.beginAction(c, request.Uid, taskId, 0, ACTION_TYPE_CREATE_TASK, request.IdempotencyKey, parts)
	if err != nil {
		return nil, err
	}
	if !created {
		return s.GetTask(c, request.Uid, action.TaskId)
	}

	policy := CONFIRM_POLICY_AUTO_POST
	if firstTime, firstErr := s.isFirstOrganize(c, request.Uid); firstErr != nil {
		return nil, firstErr
	} else if firstTime {
		policy = CONFIRM_POLICY_CONFIRM_THEN_POST
	}

	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		if err := tx.InsertTask(&Task{
			Uid: request.Uid, Status: TASK_STATUS_RECEIVING, ConfirmPolicy: policy, Version: 1,
			CreatedUnixTime: now, UpdatedUnixTime: now, TaskId: taskId,
		}); err != nil {
			return err
		}
		for index, binding := range bindings {
			if err := tx.InsertMember(&TaskMember{
				Uid: request.Uid, TaskId: taskId, MemberOrder: int64(index), FileId: binding.fileId,
				BatchId: binding.batchId, CreatedUnixTime: now, MemberId: s.generateId(),
			}); err != nil {
				return err
			}
		}
		next := cloneAction(action)
		next.Status = ACTION_STATUS_APPLIED
		next.AppliedTaskVersion = 1
		completed := now
		next.CompletedUnixTime = &completed
		next.UpdatedUnixTime = now
		updated, err := tx.UpdateAction(next)
		if err != nil || !updated {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		return nil
	})
	if err != nil {
		return nil, serviceError(err, SERVICE_ERROR_PERSISTENCE)
	}

	if err := s.refreshAccountStatus(c, request.Uid, taskId); err != nil {
		return nil, err
	}
	return s.GetTask(c, request.Uid, taskId)
}

func (s *Service) latestSuccessfulBatch(c core.Context, uid int64, fileId int64) (*importing.ImportBatch, error) {
	batches, _, err := s.evidence.ListImportBatches(c, uid, fileId, 0, 100)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, batch := range batches {
		if batch != nil && batch.Uid == uid && batch.FileId == fileId && batch.Status != importing.IMPORT_BATCH_STATUS_DISCARDED && isSuccessfulBatch(batch.Status) {
			return batch, nil
		}
	}
	return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
}

func (s *Service) isFirstOrganize(c core.Context, uid int64) (bool, error) {
	page, err := s.repository.ListTasks(c, uid, TASK_STATUS_READY, nil, 1)
	if err != nil {
		return false, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return page == nil || len(page.Items) == 0, nil
}

func uniquePositiveIDs(values []int64) []int64 {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value < 1 {
			return nil
		}
		if _, exists := seen[value]; exists {
			return nil
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
