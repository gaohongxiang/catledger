package organizer

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

var (
	ErrAbandonRequestInvalid  = errors.New("finance update abandon request is invalid")
	ErrAbandonUpdateNotFound  = errors.New("finance update is not found")
	ErrAbandonVersionConflict = errors.New("finance update abandon version conflict")
	ErrAbandonStateConflict   = errors.New("finance update cannot be abandoned")
)

type AbandonRequest struct {
	Uid                   int64
	UpdateId              int64
	ExpectedUpdateVersion int64
	IdempotencyKey        string
}

type AbandonResult struct {
	Update   *FinanceUpdate
	Action   *FinanceAction
	Replayed bool
}

// AbandonEngine closes an unposted round without mutating its immutable source,
// evidence, event, issue or decision history. The released source batches can
// then be selected in a new draft update.
type AbandonEngine struct {
	repository *Repository
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewAbandonEngine(repository *Repository, ids IdentifierGenerator) (*AbandonEngine, error) {
	if repository == nil || ids == nil {
		return nil, ErrAbandonRequestInvalid
	}
	return &AbandonEngine{repository: repository, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *AbandonEngine) Abandon(c core.Context, request AbandonRequest) (*AbandonResult, error) {
	if e == nil || e.repository == nil || e.ids == nil || e.now == nil || e.locks == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.ExpectedUpdateVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength {
		return nil, ErrAbandonRequestInvalid
	}

	sources, err := e.repository.ListSources(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	batchIds := make([]int64, 0, len(sources))
	for _, source := range sources {
		if source != nil {
			batchIds = append(batchIds, source.BatchId)
		}
	}
	release := e.locks.lock(request.Uid, batchIds)
	defer release()

	now := e.now().Unix()
	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if now < 1 || actionId < 1 {
		return nil, ErrAbandonRequestInvalid
	}
	candidate := newAbandonAction(request, actionId, now)
	persistedActionId := int64(0)
	replayed := false

	err = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		action, created, persistErr := tx.CreateOrFindAction(candidate)
		if persistErr != nil {
			return persistErr
		}
		persistedActionId = action.ActionId
		if !created {
			if action.Status == ACTION_STATUS_APPLIED {
				replayed = true
				return nil
			}
			return ErrAbandonStateConflict
		}

		update, findErr := tx.FindUpdateById(request.UpdateId)
		if findErr != nil {
			return findErr
		}
		if update == nil {
			return ErrAbandonUpdateNotFound
		}
		if update.Version != request.ExpectedUpdateVersion {
			return ErrAbandonVersionConflict
		}
		if !abandonableUpdate(update) {
			return ErrAbandonStateConflict
		}
		linkedTransactions, countErr := tx.CountUpdateTransactionLinks(request.UpdateId)
		if countErr != nil {
			return fmt.Errorf("count abandoned update transaction links: %w", countErr)
		}
		if linkedTransactions != 0 {
			return ErrAbandonStateConflict
		}

		applying := *action
		applying.Status = ACTION_STATUS_APPLYING
		applying.StartedUnixTime = &now
		applying.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
		if updateErr != nil || !updated {
			return ErrAbandonStateConflict
		}

		nextUpdate := *update
		nextUpdate.Status = UPDATE_STATUS_ABANDONED
		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		nextUpdate.ErrorCode = ""
		nextUpdate.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrAbandonVersionConflict
		}

		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.ReasonCodesJson = reasonCodesJSON([]string{"round_abandoned"})
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
		if updateErr != nil || !updated {
			return ErrAbandonStateConflict
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	update, err := e.repository.FindUpdateById(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, request.Uid, persistedActionId)
	if err != nil {
		return nil, err
	}
	return &AbandonResult{Update: update, Action: action, Replayed: replayed}, nil
}

func abandonableUpdate(update *FinanceUpdate) bool {
	if update == nil || update.PostedEventCount != 0 {
		return false
	}
	switch update.Status {
	case UPDATE_STATUS_DRAFT, UPDATE_STATUS_REVIEW, UPDATE_STATUS_FAILED:
		return true
	default:
		return false
	}
}

func newAbandonAction(request AbandonRequest, actionId int64, now int64) *FinanceAction {
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion,
		ActionType: ACTION_TYPE_ABANDON_UPDATE,
		IdempotencyKeyDigest: digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1),
			strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest: digestOrganizeValue(string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10),
			strconv.FormatInt(request.UpdateId, 10), strconv.FormatInt(request.ExpectedUpdateVersion, 10), string(ACTION_TYPE_ABANDON_UPDATE)),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1,
		Status:               ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}
