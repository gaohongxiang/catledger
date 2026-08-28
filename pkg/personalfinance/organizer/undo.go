package organizer

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrUndoRequestInvalid = errors.New("organizer undo request is invalid")
	ErrUndoStateConflict  = errors.New("finance update is not undoable")
	ErrUndoActionRequired = errors.New("organizer undo requires manual impact handling")
)

const (
	UNDO_REASON_NOT_ORGANIZER_CREATED    = "not_organizer_created"
	UNDO_REASON_TRANSACTION_MISSING      = "transaction_missing"
	UNDO_REASON_TRANSACTION_MODIFIED     = "transaction_modified"
	UNDO_REASON_TRANSACTION_SHARED       = "transaction_shared"
	UNDO_REASON_BATCH_RELATION_PRESENT   = "batch_relation_present"
	UNDO_REASON_DEBT_RELATION_PRESENT    = "debt_relation_present"
	UNDO_REASON_TRANSFER_PAIR_INCOMPLETE = "transfer_pair_incomplete"
)

type LedgerSessionDeleter interface {
	DeleteTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error)
}

type UndoRequest struct {
	Uid                   int64
	UpdateId              int64
	ExpectedUpdateVersion int64
	IdempotencyKey        string
}

type UndoImpact struct {
	CanUndo                     bool
	PostedEventCount            int64
	TransactionCount            int64
	MissingTransactionCount     int64
	ModifiedTransactionCount    int64
	SharedTransactionCount      int64
	BatchRelationCount          int64
	DebtRelationCount           int64
	IncompleteTransferPairCount int64
	ReasonCodes                 []string
}

type UndoResult struct {
	Update   *FinanceUpdate
	Action   *FinanceAction
	Impact   *UndoImpact
	Replayed bool
}

type UndoEngine struct {
	repository *Repository
	ledger     LedgerSessionDeleter
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

type undoInspection struct {
	impact       *UndoImpact
	events       []*EconomicEvent
	linksByEvent map[int64][]*EconomicEventTransaction
	transactions map[int64]*models.Transaction
}

func NewUndoEngine(repository *Repository, ledger LedgerSessionDeleter, ids IdentifierGenerator) (*UndoEngine, error) {
	if repository == nil || ledger == nil || ids == nil {
		return nil, ErrUndoRequestInvalid
	}
	return &UndoEngine{repository: repository, ledger: ledger, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *UndoEngine) Inspect(c core.Context, uid int64, updateId int64) (*UndoImpact, error) {
	if e == nil || e.repository == nil || uid < 1 || updateId < 1 {
		return nil, ErrUndoRequestInvalid
	}
	var inspection *undoInspection
	err := e.repository.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		var err error
		inspection, err = inspectUndoInSession(tx, updateId)
		return err
	})
	if err != nil {
		return nil, err
	}
	return inspection.impact, nil
}

func (e *UndoEngine) Undo(c core.Context, request UndoRequest) (*UndoResult, error) {
	if e == nil || e.repository == nil || e.ledger == nil || e.ids == nil || e.now == nil || e.locks == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.ExpectedUpdateVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength {
		return nil, ErrUndoRequestInvalid
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
	if now < 1 {
		return nil, ErrUndoRequestInvalid
	}
	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if actionId < 1 {
		return nil, ErrUndoRequestInvalid
	}
	candidate := newUndoAction(request, actionId, now)
	var impact *UndoImpact
	var replayed bool
	var actionRequired bool
	var persistedActionId int64
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
			if action.Status == ACTION_STATUS_ACTION_REQUIRED {
				return ErrUndoActionRequired
			}
			return ErrUndoStateConflict
		}
		update, findErr := tx.FindUpdateById(request.UpdateId)
		if findErr != nil {
			return findErr
		}
		if update == nil || update.Version != request.ExpectedUpdateVersion || update.Status != UPDATE_STATUS_POSTED {
			return ErrUndoStateConflict
		}
		inspection, inspectErr := inspectUndoInSession(tx, request.UpdateId)
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
				return ErrUndoStateConflict
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
			return ErrUndoStateConflict
		}
		for _, event := range inspection.events {
			if event.Status != EVENT_STATUS_POSTED {
				continue
			}
			links := inspection.linksByEvent[event.EventId]
			primary, counterpart := undoPair(links, inspection.transactions)
			if primary == nil {
				return ErrUndoStateConflict
			}
			var counterpartId, counterpartVersion int64
			if counterpart != nil {
				counterpartId = counterpart.TransactionId
				counterpartVersion = counterpart.UpdatedUnixTime
			}
			if _, _, deleteErr := e.ledger.DeleteTransactionInSession(c, tx.database, tx.session, request.Uid,
				primary.TransactionId, primary.UpdatedUnixTime, counterpartId, counterpartVersion, now); deleteErr != nil {
				return deleteErr
			}
			nextEvent := *event
			nextEvent.Status = EVENT_STATUS_READY
			nextEvent.Version = event.Version + 1
			nextEvent.UpdatedUnixTime = now
			updated, updateErr = tx.UpdateEventCAS(event.Version, &nextEvent)
			if updateErr != nil || !updated {
				return ErrUndoStateConflict
			}
		}
		nextUpdate := *update
		nextUpdate.Status = UPDATE_STATUS_UNDONE
		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		nextUpdate.ReadyEventCount += nextUpdate.PostedEventCount
		nextUpdate.PostedEventCount = 0
		nextUpdate.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrUndoStateConflict
		}
		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
		if updateErr != nil || !updated {
			return ErrUndoStateConflict
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if actionRequired {
		return nil, ErrUndoActionRequired
	}
	update, err := e.repository.FindUpdateById(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, request.Uid, persistedActionId)
	if err != nil {
		return nil, err
	}
	if replayed && impact == nil {
		impact = &UndoImpact{CanUndo: true}
	}
	return &UndoResult{Update: update, Action: action, Impact: impact, Replayed: replayed}, nil
}

func inspectUndoInSession(tx *RepositoryTransaction, updateId int64) (*undoInspection, error) {
	update, err := tx.FindUpdateById(updateId)
	if err != nil {
		return nil, err
	}
	if update == nil || update.Status != UPDATE_STATUS_POSTED {
		return nil, ErrUndoStateConflict
	}
	events, err := tx.ListEvents(updateId)
	if err != nil {
		return nil, err
	}
	inspection := &undoInspection{impact: &UndoImpact{}, events: events, linksByEvent: make(map[int64][]*EconomicEventTransaction), transactions: make(map[int64]*models.Transaction)}
	reasons := make(map[string]struct{})
	postedActions, err := tx.session.Where("uid=? AND update_id=? AND status=?", tx.uid, updateId, ACTION_STATUS_APPLIED).
		And("action_type=?", ACTION_TYPE_POST_ALL_READY).Count(new(FinanceAction))
	if err != nil {
		return nil, err
	}
	if postedActions == 0 {
		reasons[UNDO_REASON_NOT_ORGANIZER_CREATED] = struct{}{}
	}
	transactionIds := make([]int64, 0)
	linkUseCount := make(map[int64]int64)
	for _, event := range events {
		if event.Status != EVENT_STATUS_POSTED {
			continue
		}
		inspection.impact.PostedEventCount++
		links, listErr := tx.ListEventTransactions(event.EventId)
		if listErr != nil {
			return nil, listErr
		}
		links = currentEventTransactionLinks(links)
		inspection.linksByEvent[event.EventId] = links
		for _, link := range links {
			transactionIds = append(transactionIds, link.TransactionId)
			linkUseCount[link.TransactionId]++
		}
	}
	transactionIds = uniqueSortedInt64(transactionIds)
	inspection.impact.TransactionCount = int64(len(transactionIds))
	if len(transactionIds) == 0 || inspection.impact.PostedEventCount != update.PostedEventCount {
		reasons[UNDO_REASON_TRANSACTION_MISSING] = struct{}{}
	}
	if len(transactionIds) > 0 {
		transactions := make([]*models.Transaction, 0, len(transactionIds))
		if err = tx.session.Where("uid=?", tx.uid).In("transaction_id", transactionIds).Find(&transactions); err != nil {
			return nil, err
		}
		for _, transaction := range transactions {
			inspection.transactions[transaction.TransactionId] = transaction
		}
		shared, countErr := tx.session.Where("uid=? AND update_id<>?", tx.uid, updateId).In("transaction_id", transactionIds).Count(new(EconomicEventTransaction))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.SharedTransactionCount = shared
		for _, count := range linkUseCount {
			if count > 1 {
				inspection.impact.SharedTransactionCount++
			}
		}
		if inspection.impact.SharedTransactionCount > 0 {
			reasons[UNDO_REASON_TRANSACTION_SHARED] = struct{}{}
		}
		batchRelations, countErr := tx.session.Where("uid=?", tx.uid).In("transaction_id", transactionIds).Count(new(importing.RawRowTransactionLink))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.BatchRelationCount = batchRelations
		if batchRelations > 0 {
			reasons[UNDO_REASON_BATCH_RELATION_PRESENT] = struct{}{}
		}
		loanRelations, countErr := tx.session.Where("uid=? AND current_allocation_id IS NOT NULL", tx.uid).In("transaction_id", transactionIds).Count(new(loans.TransactionBinding))
		if countErr != nil {
			return nil, countErr
		}
		installmentRelations, countErr := tx.session.Where("uid=?", tx.uid).In("linked_purchase_transaction_id", transactionIds).Count(new(installments.Candidate))
		if countErr != nil {
			return nil, countErr
		}
		inspection.impact.DebtRelationCount = loanRelations + installmentRelations
		if inspection.impact.DebtRelationCount > 0 {
			reasons[UNDO_REASON_DEBT_RELATION_PRESENT] = struct{}{}
		}
	}
	for _, event := range events {
		if event.Status != EVENT_STATUS_POSTED {
			continue
		}
		links := inspection.linksByEvent[event.EventId]
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
	}
	inspection.impact.ReasonCodes = sortedReasonSet(reasons)
	inspection.impact.CanUndo = inspection.impact.PostedEventCount > 0 && len(inspection.impact.ReasonCodes) == 0
	return inspection, nil
}

func currentEventTransactionLinks(links []*EconomicEventTransaction) []*EconomicEventTransaction {
	result := make([]*EconomicEventTransaction, 0, len(links))
	for _, link := range links {
		if link == nil {
			continue
		}
		switch link.Role {
		case EVENT_TRANSACTION_ROLE_PRIMARY, EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART, EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION:
			result = append(result, link)
		}
	}
	return result
}

func completeUndoPair(links []*EconomicEventTransaction, transactions map[int64]*models.Transaction) bool {
	primary, counterpart := undoPair(links, transactions)
	if primary == nil {
		return false
	}
	if primary.Type != models.TRANSACTION_DB_TYPE_TRANSFER_OUT && primary.Type != models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		return counterpart == nil && len(links) == 1
	}
	return counterpart != nil && len(links) == 2 && primary.RelatedId == counterpart.TransactionId && counterpart.RelatedId == primary.TransactionId
}

func undoPair(links []*EconomicEventTransaction, transactions map[int64]*models.Transaction) (*models.Transaction, *models.Transaction) {
	var primary, counterpart *models.Transaction
	for _, link := range links {
		transaction := transactions[link.TransactionId]
		switch link.Role {
		case EVENT_TRANSACTION_ROLE_PRIMARY, EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION:
			if primary != nil {
				return nil, nil
			}
			primary = transaction
		case EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART:
			if counterpart != nil {
				return nil, nil
			}
			counterpart = transaction
		default:
			return nil, nil
		}
	}
	return primary, counterpart
}

func newUndoAction(request UndoRequest, actionId int64, now int64) *FinanceAction {
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, ActionType: ACTION_TYPE_UNDO,
		IdempotencyKeyDigest:  digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest: digestOrganizeValue(string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), strconv.FormatInt(request.UpdateId, 10),
			strconv.FormatInt(request.ExpectedUpdateVersion, 10), string(ACTION_TYPE_UNDO)),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func uniqueSortedInt64(values []int64) []int64 {
	seen := make(map[int64]struct{})
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value < 1 {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func sortedReasonSet(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
