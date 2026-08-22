package organizer

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrPostRequestInvalid       = errors.New("organizer posting request is invalid")
	ErrPostUpdateNotFound       = errors.New("finance update is not found")
	ErrPostVersionConflict      = errors.New("finance update version conflict")
	ErrPostStateConflict        = errors.New("finance update is not ready for posting")
	ErrPostUnresolvedEvents     = errors.New("finance update still has unresolved events")
	ErrPostEventNotPostable     = errors.New("economic event is not postable")
	ErrPostActionAlreadyRunning = errors.New("posting action is already running")
)

type PostMode string

const (
	POST_MODE_ALL_READY PostMode = "all_ready"
	POST_MODE_READY     PostMode = "ready"
)

// LedgerSessionWriter 由核心账本服务实现；写入必须复用 organizer 持有的同一个用户隐私事务。
type LedgerSessionWriter interface {
	CreateTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft *models.Transaction, tagIds []int64) (*models.Transaction, *models.Transaction, error)
}

type PostRequest struct {
	Uid                   int64
	UpdateId              int64
	ExpectedUpdateVersion int64
	IdempotencyKey        string
	Mode                  PostMode
}

type PostResult struct {
	Update   *FinanceUpdate
	Action   *FinanceAction
	Events   []*EconomicEvent
	Links    []*EconomicEventTransaction
	Replayed bool
}

type PostingEngine struct {
	repository *Repository
	ledger     LedgerSessionWriter
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewPostingEngine(repository *Repository, ledger LedgerSessionWriter, ids IdentifierGenerator) (*PostingEngine, error) {
	if repository == nil || ledger == nil || ids == nil {
		return nil, ErrPostRequestInvalid
	}
	return &PostingEngine{repository: repository, ledger: ledger, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *PostingEngine) Post(c core.Context, request PostRequest) (*PostResult, error) {
	if e == nil || e.repository == nil || e.ledger == nil || e.ids == nil || e.now == nil || e.locks == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.ExpectedUpdateVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength ||
		(request.Mode != POST_MODE_ALL_READY && request.Mode != POST_MODE_READY) {
		return nil, ErrPostRequestInvalid
	}
	now := e.now().Unix()
	if now < 1 {
		return nil, ErrPostRequestInvalid
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

	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if actionId < 1 {
		return nil, fmt.Errorf("%w: action id", ErrPostRequestInvalid)
	}
	action := newPostAction(request, actionId, now)
	replayed, persistedActionId, err := e.persist(c, request, action, now)
	if err != nil {
		return nil, err
	}
	return e.loadResult(c, request.Uid, request.UpdateId, persistedActionId, replayed)
}

func (e *PostingEngine) persist(c core.Context, request PostRequest, candidate *FinanceAction, now int64) (bool, int64, error) {
	database, err := e.repository.database(request.Uid)
	if err != nil {
		return false, 0, err
	}
	var replayed bool
	var actionId int64
	var lastErr error
	for attempt := 0; attempt < maximumPersistenceAttempts; attempt++ {
		replayed = false
		actionId = 0
		lastErr = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
			action, created, persistErr := tx.CreateOrFindAction(candidate)
			if persistErr != nil {
				return persistErr
			}
			actionId = action.ActionId
			if !created {
				switch action.Status {
				case ACTION_STATUS_APPLIED:
					replayed = true
					return nil
				case ACTION_STATUS_APPLYING:
					return ErrPostActionAlreadyRunning
				default:
					return ErrOrganizeActionTerminal
				}
			}

			update, findErr := tx.FindUpdateById(request.UpdateId)
			if findErr != nil {
				return findErr
			}
			if update == nil {
				return ErrPostUpdateNotFound
			}
			if update.Version != request.ExpectedUpdateVersion {
				return ErrPostVersionConflict
			}
			if update.Status != UPDATE_STATUS_REVIEW && update.Status != UPDATE_STATUS_PARTIALLY_POSTED {
				return ErrPostStateConflict
			}
			persistedSources, sourceErr := tx.ListSources(request.UpdateId)
			if sourceErr != nil {
				return sourceErr
			}
			if int64(len(persistedSources)) != update.SourceCount {
				return ErrPostStateConflict
			}
			events, listErr := tx.ListEvents(request.UpdateId)
			if listErr != nil {
				return listErr
			}
			ready := make([]*EconomicEvent, 0)
			var postedCount, needsActionCount, excludedCount int64
			for _, event := range events {
				switch event.Status {
				case EVENT_STATUS_READY:
					ready = append(ready, event)
				case EVENT_STATUS_NEEDS_ACTION:
					needsActionCount++
					if request.Mode == POST_MODE_ALL_READY {
						return ErrPostUnresolvedEvents
					}
				case EVENT_STATUS_POSTED:
					postedCount++
				case EVENT_STATUS_EXCLUDED:
					excludedCount++
				default:
					return ErrPostStateConflict
				}
			}
			if int64(len(events)) != update.FinalEventCount || int64(len(ready)) != update.ReadyEventCount ||
				postedCount != update.PostedEventCount || needsActionCount != update.NeedsActionEventCount || excludedCount != update.ExcludedEventCount {
				return ErrPostStateConflict
			}
			if request.Mode == POST_MODE_READY && len(ready) == 0 {
				return ErrPostEventNotPostable
			}

			applying := *action
			applying.Status = ACTION_STATUS_APPLYING
			applying.StartedUnixTime = &now
			applying.UpdatedUnixTime = now
			updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
			if updateErr != nil {
				return updateErr
			}
			if !updated {
				return ErrPostStateConflict
			}

			posting := *update
			posting.Status = UPDATE_STATUS_POSTING
			posting.Version = update.Version + 1
			posting.CurrentActionId = &action.ActionId
			posting.UpdatedUnixTime = now
			updated, updateErr = tx.UpdateUpdateCAS(update.Version, &posting)
			if updateErr != nil {
				return updateErr
			}
			if !updated {
				return ErrPostVersionConflict
			}

			for _, event := range ready {
				if postErr := e.postEvent(c, tx, event, now); postErr != nil {
					return postErr
				}
			}

			final := posting
			final.Version = posting.Version + 1
			final.PostedEventCount += int64(len(ready))
			final.ReadyEventCount -= int64(len(ready))
			if final.ReadyEventCount != 0 {
				return ErrPostStateConflict
			}
			if final.NeedsActionEventCount == 0 {
				final.Status = UPDATE_STATUS_POSTED
			} else if request.Mode == POST_MODE_READY {
				final.Status = UPDATE_STATUS_PARTIALLY_POSTED
			} else {
				return ErrPostUnresolvedEvents
			}
			final.UpdatedUnixTime = now
			updated, updateErr = tx.UpdateUpdateCAS(posting.Version, &final)
			if updateErr != nil {
				return updateErr
			}
			if !updated {
				return ErrPostVersionConflict
			}

			applied := applying
			applied.Status = ACTION_STATUS_APPLIED
			applied.AppliedUpdateVersion = final.Version
			applied.CompletedUnixTime = &now
			applied.UpdatedUnixTime = now
			updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
			if updateErr != nil {
				return updateErr
			}
			if !updated {
				return ErrPostStateConflict
			}
			return nil
		})
		if lastErr == nil {
			return replayed, actionId, nil
		}
		if attempt+1 == maximumPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), lastErr) {
			return false, 0, lastErr
		}
		if err = waitPersistenceRetry(c, initialPersistenceRetryInterval<<attempt); err != nil {
			return false, 0, err
		}
	}
	return false, 0, lastErr
}

func (e *PostingEngine) postEvent(c core.Context, tx *RepositoryTransaction, event *EconomicEvent, now int64) error {
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
	if err = tx.InsertEventTransaction(e.newLink(event, primary, role, now)); err != nil {
		return err
	}
	if counterpart != nil {
		if counterpart.TransactionId < 1 || counterpart.UpdatedUnixTime < 1 {
			return ErrPostEventNotPostable
		}
		if err = tx.InsertEventTransaction(e.newLink(event, counterpart, EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART, now)); err != nil {
			return err
		}
	}
	next := *event
	next.Status = EVENT_STATUS_POSTED
	next.Version = event.Version + 1
	next.UpdatedUnixTime = now
	updated, err := tx.UpdateEventCAS(event.Version, &next)
	if err != nil {
		return err
	}
	if !updated {
		return ErrPostVersionConflict
	}
	return nil
}

func (e *PostingEngine) newLink(event *EconomicEvent, transaction *models.Transaction, role EventTransactionRole, now int64) *EconomicEventTransaction {
	return &EconomicEventTransaction{
		Uid: event.Uid, UpdateId: event.UpdateId, EventId: event.EventId, TransactionId: transaction.TransactionId,
		Role: role, RuleVersion: EVENT_TRANSACTION_VERSION_V1, TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
		CreatedUnixTime: now, LinkId: e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE),
	}
}

func transactionDraftForEvent(event *EconomicEvent) (*models.Transaction, error) {
	if event == nil || event.Status != EVENT_STATUS_READY || event.LedgerAccountId == nil || *event.LedgerAccountId < 1 ||
		event.EventUnixTime == nil || *event.EventUnixTime < 1 || event.Amount == nil || *event.Amount < 0 ||
		len(event.Currency) != 3 || event.EconomicNature == ECONOMIC_NATURE_UNKNOWN {
		return nil, ErrPostEventNotPostable
	}
	draft := &models.Transaction{
		Uid: event.Uid, AccountId: *event.LedgerAccountId, TransactionTime: utils.GetMinTransactionTimeFromUnixTime(*event.EventUnixTime),
		Amount: *event.Amount, TimezoneUtcOffset: pointerInt16Value(event.TimezoneUtcOffset),
	}
	if event.CategoryId != nil {
		draft.CategoryId = *event.CategoryId
	}
	switch event.EconomicNature {
	case ECONOMIC_NATURE_INCOME, ECONOMIC_NATURE_REFUND, ECONOMIC_NATURE_BORROW:
		draft.Type = models.TRANSACTION_DB_TYPE_INCOME
	case ECONOMIC_NATURE_EXPENSE, ECONOMIC_NATURE_FEE:
		draft.Type = models.TRANSACTION_DB_TYPE_EXPENSE
	case ECONOMIC_NATURE_INTERNAL_TRANSFER, ECONOMIC_NATURE_REPAYMENT:
		if event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId < 1 || *event.CounterpartyLedgerAccountId == *event.LedgerAccountId {
			return nil, ErrPostEventNotPostable
		}
		draft.Type = models.TRANSACTION_DB_TYPE_TRANSFER_OUT
		draft.RelatedAccountId = *event.CounterpartyLedgerAccountId
		draft.RelatedAccountAmount = *event.Amount
	default:
		return nil, ErrPostEventNotPostable
	}
	return draft, nil
}

func (e *PostingEngine) loadResult(c core.Context, uid int64, updateId int64, actionId int64, replayed bool) (*PostResult, error) {
	update, err := e.repository.FindUpdateById(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, uid, actionId)
	if err != nil {
		return nil, err
	}
	events, err := e.repository.ListEvents(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	links := make([]*EconomicEventTransaction, 0)
	for _, event := range events {
		items, listErr := e.repository.ListEventTransactions(c, uid, event.EventId)
		if listErr != nil {
			return nil, listErr
		}
		links = append(links, items...)
	}
	sort.Slice(links, func(i, j int) bool { return links[i].LinkId < links[j].LinkId })
	return &PostResult{Update: update, Action: action, Events: events, Links: links, Replayed: replayed}, nil
}

func newPostAction(request PostRequest, actionId int64, now int64) *FinanceAction {
	actionType := ACTION_TYPE_POST_ALL_READY
	if request.Mode == POST_MODE_READY {
		actionType = ACTION_TYPE_POST_READY
	}
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, ActionType: actionType,
		IdempotencyKeyDigest:  digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest: digestOrganizeValue(string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), strconv.FormatInt(request.UpdateId, 10),
			strconv.FormatInt(request.ExpectedUpdateVersion, 10), string(actionType), string(request.Mode)),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func pointerInt16Value(value *int16) int16 {
	if value == nil {
		return 0
	}
	return *value
}

type postingLockSet struct {
	mu    sync.Mutex
	locks map[string]*postingLockEntry
}

type postingLockEntry struct {
	mutex sync.Mutex
	refs  int
}

type heldPostingLock struct {
	key   string
	entry *postingLockEntry
}

var globalPostingLocks = &postingLockSet{locks: make(map[string]*postingLockEntry)}

func (s *postingLockSet) lock(uid int64, batchIds []int64) func() {
	unique := make(map[int64]struct{})
	for _, batchId := range batchIds {
		if batchId > 0 {
			unique[batchId] = struct{}{}
		}
	}
	ids := make([]int64, 0, len(unique))
	for batchId := range unique {
		ids = append(ids, batchId)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	locked := make([]heldPostingLock, 0, len(ids))
	for _, batchId := range ids {
		key := strconv.FormatInt(uid, 10) + ":" + strconv.FormatInt(batchId, 10)
		s.mu.Lock()
		entry := s.locks[key]
		if entry == nil {
			entry = new(postingLockEntry)
			s.locks[key] = entry
		}
		entry.refs++
		s.mu.Unlock()
		entry.mutex.Lock()
		locked = append(locked, heldPostingLock{key: key, entry: entry})
	}
	return func() {
		for index := len(locked) - 1; index >= 0; index-- {
			held := locked[index]
			held.entry.mutex.Unlock()
			s.mu.Lock()
			held.entry.refs--
			if held.entry.refs == 0 && s.locks[held.key] == held.entry {
				delete(s.locks, held.key)
			}
			s.mu.Unlock()
		}
	}
}
