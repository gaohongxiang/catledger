package organizer

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrCorrectionRequestInvalid        = errors.New("organizer correction request is invalid")
	ErrCorrectionUpdateConflict        = errors.New("finance update correction conflict")
	ErrCorrectionEventConflict         = errors.New("economic event correction conflict")
	ErrCorrectionPostedRequiresRebuild = errors.New("posted event correction requires safe ledger rebuild")
)

const reasonManualCorrection = "manual_correction"

type EventCorrection struct {
	FieldMask                   int64
	Status                      EventStatus
	FlowDirection               FlowDirection
	EconomicNature              EconomicNature
	LedgerAccountId             *int64
	CounterpartyLedgerAccountId *int64
	EventUnixTime               *int64
	TimezoneUtcOffset           *int16
	Amount                      *int64
	Currency                    string
	CategoryId                  *int64
}

type CorrectEventRequest struct {
	Uid                   int64
	UpdateId              int64
	EventId               int64
	ExpectedUpdateVersion int64
	ExpectedEventVersion  int64
	IdempotencyKey        string
	Correction            EventCorrection
}

type CorrectEventResult struct {
	Update   *FinanceUpdate
	Event    *EconomicEvent
	Action   *FinanceAction
	Replayed bool
}

type CorrectionEngine struct {
	repository *Repository
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewCorrectionEngine(repository *Repository, ids IdentifierGenerator) (*CorrectionEngine, error) {
	if repository == nil || ids == nil {
		return nil, ErrCorrectionRequestInvalid
	}
	return &CorrectionEngine{repository: repository, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *CorrectionEngine) Correct(c core.Context, request CorrectEventRequest) (*CorrectEventResult, error) {
	if !validCorrectionRequest(e, request) {
		return nil, ErrCorrectionRequestInvalid
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
		return nil, ErrCorrectionRequestInvalid
	}
	candidate := newCorrectionAction(request, actionId, now)
	var persistedActionId int64
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
			return ErrCorrectionEventConflict
		}
		update, findErr := tx.FindUpdateById(request.UpdateId)
		if findErr != nil {
			return findErr
		}
		if update == nil || update.Version != request.ExpectedUpdateVersion {
			return ErrCorrectionUpdateConflict
		}
		event, findErr := tx.FindEventById(request.EventId)
		if findErr != nil {
			return findErr
		}
		if event == nil || event.UpdateId != request.UpdateId || event.Version != request.ExpectedEventVersion {
			return ErrCorrectionEventConflict
		}
		if event.Status == EVENT_STATUS_POSTED || event.Status == EVENT_STATUS_CORRECTED {
			return ErrCorrectionPostedRequiresRebuild
		}
		if update.Status != UPDATE_STATUS_REVIEW && update.Status != UPDATE_STATUS_PARTIALLY_POSTED {
			return ErrCorrectionUpdateConflict
		}
		nextEvent, applyErr := applyEventCorrection(event, request.Correction, action.ActionId, now)
		if applyErr != nil {
			return applyErr
		}
		applying := *action
		applying.Status = ACTION_STATUS_APPLYING
		applying.StartedUnixTime = &now
		applying.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
		if updateErr != nil || !updated {
			return ErrCorrectionEventConflict
		}
		updated, updateErr = tx.UpdateEventCAS(event.Version, nextEvent)
		if updateErr != nil || !updated {
			return ErrCorrectionEventConflict
		}
		nextUpdate := *update
		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		if !moveEventCount(&nextUpdate, event.Status, nextEvent.Status) {
			return ErrCorrectionUpdateConflict
		}
		nextUpdate.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrCorrectionUpdateConflict
		}
		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.ReasonCodesJson = correctionReasonCodes(request.Correction.FieldMask)
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
		if updateErr != nil || !updated {
			return ErrCorrectionEventConflict
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
	event, err := e.repository.FindEventById(c, request.Uid, request.EventId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, request.Uid, persistedActionId)
	if err != nil {
		return nil, err
	}
	return &CorrectEventResult{Update: update, Event: event, Action: action, Replayed: replayed}, nil
}

func validCorrectionRequest(engine *CorrectionEngine, request CorrectEventRequest) bool {
	return engine != nil && engine.repository != nil && engine.ids != nil && engine.now != nil && engine.locks != nil &&
		request.Uid > 0 && request.UpdateId > 0 && request.EventId > 0 && request.ExpectedUpdateVersion > 0 && request.ExpectedEventVersion > 0 &&
		strings.TrimSpace(request.IdempotencyKey) != "" && len(request.IdempotencyKey) <= maximumOrganizeIdempotencyKeyLength &&
		request.Correction.FieldMask > 0 && request.Correction.FieldMask&^MANUAL_FIELD_ALL == 0
}

func applyEventCorrection(current *EconomicEvent, correction EventCorrection, actionId int64, now int64) (*EconomicEvent, error) {
	next := *current
	if correction.FieldMask&MANUAL_FIELD_STATUS != 0 {
		next.Status = correction.Status
	}
	if correction.FieldMask&MANUAL_FIELD_FLOW_DIRECTION != 0 {
		next.FlowDirection = correction.FlowDirection
	}
	if correction.FieldMask&MANUAL_FIELD_ECONOMIC_NATURE != 0 {
		next.EconomicNature = correction.EconomicNature
	}
	if correction.FieldMask&MANUAL_FIELD_LEDGER_ACCOUNT != 0 {
		next.LedgerAccountId = cloneInt64Pointer(correction.LedgerAccountId)
	}
	if correction.FieldMask&MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT != 0 {
		next.CounterpartyLedgerAccountId = cloneInt64Pointer(correction.CounterpartyLedgerAccountId)
	}
	if correction.FieldMask&MANUAL_FIELD_EVENT_TIME != 0 {
		next.EventUnixTime = cloneInt64Pointer(correction.EventUnixTime)
		next.TimezoneUtcOffset = cloneInt16Pointer(correction.TimezoneUtcOffset)
	}
	if correction.FieldMask&MANUAL_FIELD_AMOUNT != 0 {
		next.Amount = cloneInt64Pointer(correction.Amount)
	}
	if correction.FieldMask&MANUAL_FIELD_CURRENCY != 0 {
		next.Currency = correction.Currency
	}
	if correction.FieldMask&MANUAL_FIELD_CATEGORY != 0 {
		next.CategoryId = cloneInt64Pointer(correction.CategoryId)
	}
	if next.Status != EVENT_STATUS_READY && next.Status != EVENT_STATUS_NEEDS_ACTION && next.Status != EVENT_STATUS_EXCLUDED {
		return nil, ErrCorrectionRequestInvalid
	}
	next.Version = current.Version + 1
	next.ManualFieldMask |= correction.FieldMask
	next.FieldSourcesJson = correctedFieldSources(current.FieldSourcesJson, correction.FieldMask, actionId)
	next.ReasonCodesJson = correctedEventReasons(&next)
	next.UpdatedUnixTime = now
	if !isValidEventCAS(&next, current.Uid, current.Version) {
		return nil, ErrCorrectionRequestInvalid
	}
	return &next, nil
}

func correctedFieldSources(encoded string, mask int64, actionId int64) string {
	fields := make(map[string]string)
	_ = json.Unmarshal([]byte(encoded), &fields)
	ref := "action:" + strconv.FormatInt(actionId, 10)
	for field, bit := range map[string]int64{
		"ledger_account": MANUAL_FIELD_LEDGER_ACCOUNT, "counterparty_ledger_account": MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT,
		"direction": MANUAL_FIELD_FLOW_DIRECTION, "economic_nature": MANUAL_FIELD_ECONOMIC_NATURE,
		"event_time": MANUAL_FIELD_EVENT_TIME, "amount": MANUAL_FIELD_AMOUNT, "currency": MANUAL_FIELD_CURRENCY,
		"category": MANUAL_FIELD_CATEGORY, "status": MANUAL_FIELD_STATUS,
	} {
		if mask&bit != 0 {
			fields[field] = ref
		}
	}
	value, _ := json.Marshal(fields)
	return string(value)
}

func correctedEventReasons(event *EconomicEvent) string {
	reasons := []string{reasonManualCorrection}
	if event.Status == EVENT_STATUS_READY && event.EconomicNature == ECONOMIC_NATURE_EXPENSE && event.CategoryId == nil {
		reasons = append(reasons, reasonCategoryUnclassified)
	}
	if event.EconomicNature == ECONOMIC_NATURE_UNKNOWN && event.Status != EVENT_STATUS_EXCLUDED {
		reasons = append(reasons, reasonEconomicNatureRequired)
	}
	return reasonCodesJSON(reasons)
}

func moveEventCount(update *FinanceUpdate, from EventStatus, to EventStatus) bool {
	if from == to {
		return true
	}
	counter := func(status EventStatus) *int64 {
		switch status {
		case EVENT_STATUS_READY:
			return &update.ReadyEventCount
		case EVENT_STATUS_NEEDS_ACTION:
			return &update.NeedsActionEventCount
		case EVENT_STATUS_EXCLUDED:
			return &update.ExcludedEventCount
		default:
			return nil
		}
	}
	fromCount, toCount := counter(from), counter(to)
	if fromCount == nil || toCount == nil || *fromCount < 1 {
		return false
	}
	(*fromCount)--
	(*toCount)++
	return validConservation(update)
}

func correctionReasonCodes(mask int64) string {
	items := []string{reasonManualCorrection, fmt.Sprintf("manual_field_mask:%d", mask)}
	return reasonCodesJSON(items)
}

func newCorrectionAction(request CorrectEventRequest, actionId int64, now int64) *FinanceAction {
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, ActionType: ACTION_TYPE_CORRECT_EVENT,
		IdempotencyKeyDigest:  digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest: digestOrganizeValue(string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), strconv.FormatInt(request.UpdateId, 10),
			strconv.FormatInt(request.EventId, 10), strconv.FormatInt(request.ExpectedUpdateVersion, 10), strconv.FormatInt(request.ExpectedEventVersion, 10),
			strconv.FormatInt(request.Correction.FieldMask, 10), correctionDigest(request.Correction)),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func correctionDigest(value EventCorrection) string {
	encoded, _ := json.Marshal(value)
	return digestOrganizeValue(string(encoded))
}
