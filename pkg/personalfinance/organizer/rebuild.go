package organizer

import (
	"errors"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrRebuildRequestInvalid = errors.New("posted event rebuild request is invalid")
	ErrRebuildStateConflict  = errors.New("posted event rebuild conflict")
	ErrRebuildActionRequired = errors.New("posted event rebuild requires manual impact handling")
)

type LedgerSessionEditor interface {
	LedgerSessionWriter
	LedgerSessionDeleter
}

type RebuildResult struct {
	Update   *FinanceUpdate
	Event    *EconomicEvent
	Action   *FinanceAction
	Impact   *UndoImpact
	Replayed bool
}

type RebuildEngine struct {
	repository *Repository
	ledger     LedgerSessionEditor
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewRebuildEngine(repository *Repository, ledger LedgerSessionEditor, ids IdentifierGenerator) (*RebuildEngine, error) {
	if repository == nil || ledger == nil || ids == nil {
		return nil, ErrRebuildRequestInvalid
	}
	return &RebuildEngine{repository: repository, ledger: ledger, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *RebuildEngine) Inspect(c core.Context, uid int64, updateId int64, eventId int64) (*UndoImpact, error) {
	if e == nil || e.repository == nil || uid < 1 || updateId < 1 || eventId < 1 {
		return nil, ErrRebuildRequestInvalid
	}
	var inspection *undoInspection
	err := e.repository.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		var err error
		inspection, err = inspectPostedEventInSession(tx, updateId, eventId)
		return err
	})
	if err != nil {
		return nil, err
	}
	return inspection.impact, nil
}

func (e *RebuildEngine) Rebuild(c core.Context, request CorrectEventRequest) (*RebuildResult, error) {
	if e == nil || e.repository == nil || e.ledger == nil || e.ids == nil || e.now == nil || e.locks == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.EventId < 1 || request.ExpectedUpdateVersion < 1 || request.ExpectedEventVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength ||
		request.Correction.FieldMask < 1 || request.Correction.FieldMask&^MANUAL_FIELD_ALL != 0 {
		return nil, ErrRebuildRequestInvalid
	}
	sources, err := e.repository.ListSources(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	batchIds := make([]int64, 0, len(sources))
	for _, source := range sources {
		batchIds = append(batchIds, source.BatchId)
	}
	release := e.locks.lock(request.Uid, batchIds)
	defer release()
	now := e.now().Unix()
	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if now < 1 || actionId < 1 {
		return nil, ErrRebuildRequestInvalid
	}
	candidate := newCorrectionAction(request, actionId, now)
	var impact *UndoImpact
	var persistedActionId int64
	replayed, actionRequired := false, false
	err = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		action, created, persistErr := tx.CreateOrFindAction(candidate)
		if persistErr != nil {
			return persistErr
		}
		persistedActionId = action.ActionId
		if !created {
			switch action.Status {
			case ACTION_STATUS_APPLIED:
				replayed = true
				return nil
			case ACTION_STATUS_ACTION_REQUIRED:
				actionRequired = true
				return nil
			default:
				return ErrRebuildStateConflict
			}
		}
		update, findErr := tx.FindUpdateById(request.UpdateId)
		if findErr != nil {
			return findErr
		}
		if update == nil || update.Version != request.ExpectedUpdateVersion ||
			(update.Status != UPDATE_STATUS_POSTED && update.Status != UPDATE_STATUS_PARTIALLY_POSTED) {
			return ErrRebuildStateConflict
		}
		event, findErr := tx.FindEventById(request.EventId)
		if findErr != nil {
			return findErr
		}
		if event == nil || event.UpdateId != request.UpdateId || event.Status != EVENT_STATUS_POSTED || event.Version != request.ExpectedEventVersion {
			return ErrRebuildStateConflict
		}
		inspection, inspectErr := inspectPostedEventInSession(tx, request.UpdateId, request.EventId)
		if inspectErr != nil {
			return inspectErr
		}
		impact = inspection.impact
		if !impact.CanUndo {
			required := *action
			required.Status = ACTION_STATUS_ACTION_REQUIRED
			required.ReasonCodesJson = reasonCodesJSON(impact.ReasonCodes)
			required.CompletedUnixTime = &now
			required.UpdatedUnixTime = now
			updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &required)
			if updateErr != nil || !updated {
				return ErrRebuildStateConflict
			}
			actionRequired = true
			return nil
		}
		applying := *action
		applying.Status = ACTION_STATUS_APPLYING
		applying.StartedUnixTime = &now
		applying.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
		if updateErr != nil || !updated {
			return ErrRebuildStateConflict
		}
		links := inspection.linksByEvent[event.EventId]
		primary, counterpart := undoPair(links, inspection.transactions)
		if primary == nil {
			return ErrRebuildStateConflict
		}
		for _, link := range links {
			historical, ok := historicalEventTransactionRole(link.Role)
			if !ok {
				return ErrRebuildStateConflict
			}
			updated, updateErr = tx.UpdateEventTransactionRole(link.LinkId, link.Role, historical)
			if updateErr != nil || !updated {
				return ErrRebuildStateConflict
			}
		}
		var counterpartId, counterpartVersion int64
		if counterpart != nil {
			counterpartId, counterpartVersion = counterpart.TransactionId, counterpart.UpdatedUnixTime
		}
		if _, _, deleteErr := e.ledger.DeleteTransactionInSession(c, tx.database, tx.session, request.Uid,
			primary.TransactionId, primary.UpdatedUnixTime, counterpartId, counterpartVersion, now); deleteErr != nil {
			return deleteErr
		}
		working := *event
		working.Status = EVENT_STATUS_READY
		relations, relationErr := tx.ListRelations(event.EventId)
if relationErr != nil {
    return relationErr
}
nextEvent, applyErr := applyEventCorrection(&working, request.Correction, relations, action.ActionId, now)
		if applyErr != nil {
			return applyErr
		}
		if nextEvent.Status == EVENT_STATUS_READY {
			if createErr := e.createReplacement(c, tx, nextEvent, now); createErr != nil {
				return createErr
			}
			nextEvent.Status = EVENT_STATUS_POSTED
		}
		updated, updateErr = tx.UpdateEventCAS(event.Version, nextEvent)
		if updateErr != nil || !updated {
			return ErrRebuildStateConflict
		}
		nextUpdate := *update
		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		if nextEvent.Status != EVENT_STATUS_POSTED && !moveEventCount(&nextUpdate, EVENT_STATUS_POSTED, nextEvent.Status) {
			return ErrRebuildStateConflict
		}
		if nextUpdate.ReadyEventCount == 0 && nextUpdate.NeedsActionEventCount == 0 {
			nextUpdate.Status = UPDATE_STATUS_POSTED
		} else {
			nextUpdate.Status = UPDATE_STATUS_PARTIALLY_POSTED
		}
		nextUpdate.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrRebuildStateConflict
		}
		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.ReasonCodesJson = correctionReasonCodes(request.Correction.FieldMask)
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
		if updateErr != nil || !updated {
			return ErrRebuildStateConflict
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if actionRequired {
		return nil, ErrRebuildActionRequired
	}
	update, err := e.repository.FindUpdateById(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	event, err := e.repository.FindEventById(c, request.Uid, request.EventId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, request.Uid, persistedActionId)
	if err != nil {
		return nil, err
	}
	return &RebuildResult{Update: update, Event: event, Action: action, Impact: impact, Replayed: replayed}, nil
}

func (e *RebuildEngine) createReplacement(c core.Context, tx *RepositoryTransaction, event *EconomicEvent, now int64) error {
	draft, err := transactionDraftForEvent(event)
	if err != nil {
		return err
	}
	primary, counterpart, err := e.ledger.CreateTransactionInSession(c, tx.database, tx.session, draft, nil)
	if err != nil {
		return err
	}
	if primary == nil || primary.TransactionId < 1 || primary.UpdatedUnixTime < 1 {
		return ErrPostEventNotPostable
	}
	role := EVENT_TRANSACTION_ROLE_PRIMARY
	if event.EconomicNature == ECONOMIC_NATURE_REFUND {
		role = EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION
	}
	if err = tx.InsertEventTransaction(newRebuildLink(e.ids, event, primary, role, now)); err != nil {
		return err
	}
	if counterpart != nil {
		if counterpart.TransactionId < 1 || counterpart.UpdatedUnixTime < 1 {
			return ErrPostEventNotPostable
		}
		return tx.InsertEventTransaction(newRebuildLink(e.ids, event, counterpart, EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART, now))
	}
	return nil
}

func newRebuildLink(ids IdentifierGenerator, event *EconomicEvent, transaction *models.Transaction, role EventTransactionRole, now int64) *EconomicEventTransaction {
	return &EconomicEventTransaction{
		Uid: event.Uid, UpdateId: event.UpdateId, EventId: event.EventId, TransactionId: transaction.TransactionId,
		Role: role, RuleVersion: EVENT_TRANSACTION_VERSION_V1, TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
		CreatedUnixTime: now, LinkId: ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE),
	}
}

func historicalEventTransactionRole(role EventTransactionRole) (EventTransactionRole, bool) {
	switch role {
	case EVENT_TRANSACTION_ROLE_PRIMARY:
		return EVENT_TRANSACTION_ROLE_HISTORICAL_PRIMARY, true
	case EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART:
		return EVENT_TRANSACTION_ROLE_HISTORICAL_COUNTERPART, true
	case EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION:
		return EVENT_TRANSACTION_ROLE_HISTORICAL_REFUND, true
	default:
		return "", false
	}
}

func inspectPostedEventInSession(tx *RepositoryTransaction, updateId int64, eventId int64) (*undoInspection, error) {
	event, err := tx.FindEventById(eventId)
	if err != nil {
		return nil, err
	}
	if event == nil || event.UpdateId != updateId || event.Status != EVENT_STATUS_POSTED {
		return nil, ErrRebuildStateConflict
	}
	links, err := tx.ListEventTransactions(eventId)
	if err != nil {
		return nil, err
	}
	links = currentEventTransactionLinks(links)
	inspection := &undoInspection{
		impact: &UndoImpact{PostedEventCount: 1}, events: []*EconomicEvent{event},
		linksByEvent: map[int64][]*EconomicEventTransaction{eventId: links}, transactions: make(map[int64]*models.Transaction),
	}
	reasons := make(map[string]struct{})
	ids := make([]int64, 0, len(links))
	for _, link := range links {
		ids = append(ids, link.TransactionId)
	}
	ids = uniqueSortedInt64(ids)
	inspection.impact.TransactionCount = int64(len(ids))
	if len(ids) == 0 {
		reasons[UNDO_REASON_TRANSACTION_MISSING] = struct{}{}
	} else {
		transactions := make([]*models.Transaction, 0, len(ids))
		if err = tx.session.Where("uid=?", tx.uid).In("transaction_id", ids).Find(&transactions); err != nil {
			return nil, err
		}
		for _, transaction := range transactions {
			inspection.transactions[transaction.TransactionId] = transaction
		}
		shared, countErr := tx.session.Where("uid=? AND (update_id<>? OR event_id<>?)", tx.uid, updateId, eventId).
			In("transaction_id", ids).Count(new(EconomicEventTransaction))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.SharedTransactionCount = shared
		if shared > 0 {
			reasons[UNDO_REASON_TRANSACTION_SHARED] = struct{}{}
		}
		batch, countErr := tx.session.Where("uid=?", tx.uid).In("transaction_id", ids).Count(new(importing.RawRowTransactionLink))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.BatchRelationCount = batch
		if batch > 0 {
			reasons[UNDO_REASON_BATCH_RELATION_PRESENT] = struct{}{}
		}
		loanCount, countErr := tx.session.Where("uid=? AND current_allocation_id IS NOT NULL", tx.uid).In("transaction_id", ids).Count(new(loans.TransactionBinding))
		if countErr != nil {
			return nil, countErr
		}
		installmentCount, countErr := tx.session.Where("uid=?", tx.uid).In("linked_purchase_transaction_id", ids).Count(new(installments.Candidate))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.DebtRelationCount = loanCount + installmentCount
		if inspection.impact.DebtRelationCount > 0 {
			reasons[UNDO_REASON_DEBT_RELATION_PRESENT] = struct{}{}
		}
	}
	for _, link := range links {
		transaction := inspection.transactions[link.TransactionId]
		if transaction == nil || transaction.Deleted {
			inspection.impact.MissingTransactionCount++
			reasons[UNDO_REASON_TRANSACTION_MISSING] = struct{}{}
		} else if transaction.UpdatedUnixTime != link.TransactionUpdatedUnixTime {
			inspection.impact.ModifiedTransactionCount++
			reasons[UNDO_REASON_TRANSACTION_MODIFIED] = struct{}{}
		}
	}
	if !completeUndoPair(links, inspection.transactions) {
		inspection.impact.IncompleteTransferPairCount++
		reasons[UNDO_REASON_TRANSFER_PAIR_INCOMPLETE] = struct{}{}
	}
	inspection.impact.ReasonCodes = sortedReasonSet(reasons)
	inspection.impact.CanUndo = len(inspection.impact.ReasonCodes) == 0
	return inspection, nil
}
