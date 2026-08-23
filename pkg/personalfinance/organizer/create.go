package organizer

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrCreateUpdateRequestInvalid = errors.New("finance update create request is invalid")
	ErrCreateUpdateBatchNotFound  = errors.New("finance update source batch is not found")
	ErrCreateUpdateBatchNotReady  = errors.New("finance update source batch is not ready")
	ErrCreateUpdateStateConflict  = errors.New("finance update create state conflict")
)

const maximumUpdateSourceCount = 100

type CreateUpdateRequest struct {
	Uid            int64
	BatchIds       []int64
	IdempotencyKey string
}

type CreateUpdateResult struct {
	Update   *FinanceUpdate
	Sources  []*FinanceUpdateSource
	Action   *FinanceAction
	Replayed bool
}

// CreateEngine 在同一隐私事务内固定来源快照和创建动作，不依赖旧 billflow 任务。
type CreateEngine struct {
	repository *Repository
	evidence   EvidenceReader
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewCreateEngine(repository *Repository, evidence EvidenceReader, ids IdentifierGenerator) (*CreateEngine, error) {
	if repository == nil || evidence == nil || ids == nil {
		return nil, ErrCreateUpdateRequestInvalid
	}
	return &CreateEngine{repository: repository, evidence: evidence, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *CreateEngine) Create(c core.Context, request CreateUpdateRequest) (*CreateUpdateResult, error) {
	if !validCreateUpdateRequest(e, request) {
		return nil, ErrCreateUpdateRequestInvalid
	}
	release := e.locks.lock(request.Uid, request.BatchIds)
	defer release()
	batches := make([]*importing.ImportBatch, 0, len(request.BatchIds))
	for _, batchId := range request.BatchIds {
		batch, err := e.evidence.FindImportBatchById(c, request.Uid, batchId)
		if err != nil {
			return nil, err
		}
		if batch == nil {
			return nil, ErrCreateUpdateBatchNotFound
		}
		if batch.Status != importing.IMPORT_BATCH_STATUS_READY {
			return nil, ErrCreateUpdateBatchNotReady
		}
		batches = append(batches, batch)
	}

	now := e.now().Unix()
	updateId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if now < 1 || updateId < 1 || actionId < 1 {
		return nil, ErrCreateUpdateRequestInvalid
	}
	action := newCreateUpdateAction(request, updateId, actionId, now)
	replayed := false
	persistedActionId := int64(0)
	persistedUpdateId := int64(0)
	err := e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		persisted, created, persistErr := tx.CreateOrFindAction(action)
		if persistErr != nil {
			return persistErr
		}
		persistedActionId = persisted.ActionId
		persistedUpdateId = persisted.UpdateId
		if !created {
			if persisted.Status != ACTION_STATUS_APPLIED {
				return ErrCreateUpdateStateConflict
			}
			replayed = true
			return nil
		}
		claimed, claimErr := tx.ListSourcesByBatchIds(request.BatchIds)
		if claimErr != nil {
			return claimErr
		}
		for _, source := range claimed {
			claimedUpdate, findErr := tx.FindUpdateById(source.UpdateId)
			if findErr != nil {
				return findErr
			}
			if claimedUpdate != nil && claimedUpdate.Status != UPDATE_STATUS_FAILED && claimedUpdate.Status != UPDATE_STATUS_UNDONE &&
				claimedUpdate.Status != UPDATE_STATUS_ABANDONED {
				return ErrCreateUpdateStateConflict
			}
		}

		update := &FinanceUpdate{
			Uid: request.Uid, Status: UPDATE_STATUS_DRAFT, Version: 1, PlanVersion: PLAN_VERSION_V1,
			SourceCount: int64(len(batches)), CreatedUnixTime: now, UpdatedUnixTime: now, UpdateId: updateId,
		}
		if err := tx.InsertUpdate(update); err != nil {
			return err
		}
		for index, batch := range batches {
			sourceId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
			if sourceId < 1 {
				return ErrCreateUpdateRequestInvalid
			}
			source := &FinanceUpdateSource{
				Uid: request.Uid, UpdateId: updateId, SourceOrder: int64(index), FileId: batch.FileId, BatchId: batch.BatchId,
				SourceAccountId: batch.SourceAccountId, SourceTypeSnapshot: string(batch.SourceTypeSnapshot),
				ParserVersion: RuleVersion(batch.ParserVersion), NormalizationVersion: RuleVersion(batch.NormalizationVersion),
				IdentityKeyVersion: RuleVersion(batch.IdentityKeyVersion), CreatedUnixTime: now, SourceId: sourceId,
			}
			if err := tx.InsertSource(source); err != nil {
				return err
			}
		}
		applied := *persisted
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = 1
		applied.StartedUnixTime = &now
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applied)
		if updateErr != nil || !updated {
			return ErrCreateUpdateStateConflict
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	update, err := e.repository.FindUpdateById(c, request.Uid, persistedUpdateId)
	if err != nil || update == nil {
		if err == nil {
			err = ErrCreateUpdateStateConflict
		}
		return nil, err
	}
	sources, err := e.repository.ListSources(c, request.Uid, persistedUpdateId)
	if err != nil {
		return nil, err
	}
	persistedAction, err := e.repository.FindActionById(c, request.Uid, persistedActionId)
	if err != nil {
		return nil, err
	}
	return &CreateUpdateResult{Update: update, Sources: sources, Action: persistedAction, Replayed: replayed}, nil
}

func validCreateUpdateRequest(engine *CreateEngine, request CreateUpdateRequest) bool {
	if engine == nil || engine.repository == nil || engine.evidence == nil || engine.ids == nil || engine.now == nil || engine.locks == nil ||
		request.Uid < 1 || len(request.BatchIds) < 1 || len(request.BatchIds) > maximumUpdateSourceCount ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength {
		return false
	}
	seen := make(map[int64]struct{}, len(request.BatchIds))
	for _, batchId := range request.BatchIds {
		if batchId < 1 {
			return false
		}
		if _, exists := seen[batchId]; exists {
			return false
		}
		seen[batchId] = struct{}{}
	}
	return true
}

func newCreateUpdateAction(request CreateUpdateRequest, updateId int64, actionId int64, now int64) *FinanceAction {
	parts := make([]string, 0, len(request.BatchIds)+3)
	parts = append(parts, string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), string(ACTION_TYPE_CREATE_UPDATE))
	for _, batchId := range request.BatchIds {
		parts = append(parts, strconv.FormatInt(batchId, 10))
	}
	return &FinanceAction{
		Uid: request.Uid, UpdateId: updateId, ExpectedUpdateVersion: 0, ActionType: ACTION_TYPE_CREATE_UPDATE,
		IdempotencyKeyDigest:  digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1, RequestDigest: digestOrganizeValue(parts...),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func (r CreateUpdateRequest) String() string {
	return fmt.Sprintf("uid:%d batches:%d", r.Uid, len(r.BatchIds))
}
