package organizer

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

var (
	ErrCorrectionRequestInvalid        = errors.New("organizer correction request is invalid")
	ErrCorrectionUpdateConflict        = errors.New("finance update correction conflict")
	ErrCorrectionEventConflict         = errors.New("economic event correction conflict")
	ErrCorrectionPostedRequiresRebuild = errors.New("posted event correction requires safe ledger rebuild")
)

const reasonManualCorrection = "manual_correction"

type CategoryCorrectionScope string

const (
	CATEGORY_CORRECTION_SCOPE_SINGLE                 CategoryCorrectionScope = "single"
	CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED CategoryCorrectionScope = "matching_uncategorized"
)

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
	CategoryScope         CategoryCorrectionScope
	Correction            EventCorrection
}

type CorrectEventResult struct {
	Update   *FinanceUpdate
	Event    *EconomicEvent
	Events   []*EconomicEvent
	Action   *FinanceAction
	Replayed bool
}

type CategoryCorrectionScopePreview struct {
	MatchingEventCount int64
}

type CorrectionEngine struct {
	repository *Repository
	evidence   EvidenceReader
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewCorrectionEngine(repository *Repository, ids IdentifierGenerator, evidenceReaders ...EvidenceReader) (*CorrectionEngine, error) {
	if repository == nil || ids == nil {
		return nil, ErrCorrectionRequestInvalid
	}
	if len(evidenceReaders) > 1 || (len(evidenceReaders) == 1 && evidenceReaders[0] == nil) {
		return nil, ErrCorrectionRequestInvalid
	}
	var evidence EvidenceReader
	if len(evidenceReaders) == 1 {
		evidence = evidenceReaders[0]
	}
	return &CorrectionEngine{repository: repository, evidence: evidence, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
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
	correctedEventIds, err := e.categoryCorrectionEventIds(c, request, sources)
	if err != nil {
		return nil, err
	}
	categoryAliases, err := e.categoryAliasesForCorrection(c, request, sources, correctedEventIds, now)
	if err != nil {
		return nil, err
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
		if update.Status != UPDATE_STATUS_REVIEW {
			return ErrCorrectionUpdateConflict
		}
		manualMask, validMask := correctionEffectiveMask(request.Correction)
		if !validMask {
			return ErrCorrectionRequestInvalid
		}
		currentEvents := make([]*EconomicEvent, 0, len(correctedEventIds))
		nextEvents := make([]*EconomicEvent, 0, len(correctedEventIds))
		for _, eventId := range correctedEventIds {
			current := event
			if eventId != request.EventId {
				current, findErr = tx.FindEventById(eventId)
				if findErr != nil {
					return findErr
				}
			}
			if current == nil || current.UpdateId != request.UpdateId {
				return ErrCorrectionEventConflict
			}
			if normalizedCategoryCorrectionScope(request.CategoryScope) == CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED &&
				(current.Status != EVENT_STATUS_READY || current.CategoryId != nil || current.EconomicNature != event.EconomicNature) {
				return ErrCorrectionEventConflict
			}
			relations, relationErr := tx.ListRelations(eventId)
			if relationErr != nil {
				return relationErr
			}
			nextEvent, applyErr := applyEventCorrection(current, request.Correction, relations, action.ActionId, now)
			if applyErr != nil {
				return applyErr
			}
			currentEvents = append(currentEvents, current)
			nextEvents = append(nextEvents, nextEvent)
		}
		applying := *action
		applying.Status = ACTION_STATUS_APPLYING
		applying.StartedUnixTime = &now
		applying.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
		if updateErr != nil || !updated {
			return ErrCorrectionEventConflict
		}
		for index, nextEvent := range nextEvents {
			updated, updateErr = tx.UpdateEventCAS(currentEvents[index].Version, nextEvent)
			if updateErr != nil || !updated {
				return ErrCorrectionEventConflict
			}
		}
		if err = tx.SaveCategoryAliases(categoryAliases); err != nil {
			return err
		}
		nextUpdate := *update
		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		for index, nextEvent := range nextEvents {
			if !moveEventCount(&nextUpdate, currentEvents[index].Status, nextEvent.Status) {
				return ErrCorrectionUpdateConflict
			}
		}
		nextUpdate.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrCorrectionUpdateConflict
		}
		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.ReasonCodesJson = correctionReasonCodes(manualMask)
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
	allEvents, err := e.repository.ListEvents(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	wanted := make(map[int64]struct{}, len(correctedEventIds))
	for _, eventId := range correctedEventIds {
		wanted[eventId] = struct{}{}
	}
	correctedEvents := make([]*EconomicEvent, 0, len(correctedEventIds))
	for _, item := range allEvents {
		if _, ok := wanted[item.EventId]; ok {
			correctedEvents = append(correctedEvents, item)
		}
	}
	return &CorrectEventResult{Update: update, Event: event, Events: correctedEvents, Action: action, Replayed: replayed}, nil
}

func (e *CorrectionEngine) categoryAliasesForCorrection(c core.Context, request CorrectEventRequest, sources []*FinanceUpdateSource, eventIds []int64, now int64) ([]*CategoryAliasMapping, error) {
	if e.evidence == nil || request.Correction.FieldMask&MANUAL_FIELD_CATEGORY == 0 || request.Correction.CategoryId == nil || *request.Correction.CategoryId < 1 {
		return nil, nil
	}
	return buildCategoryAliases(c, e.repository, e.evidence, e.ids, request.Uid, sources, eventIds, *request.Correction.CategoryId, now)
}

func (e *CorrectionEngine) categoryCorrectionEventIds(c core.Context, request CorrectEventRequest, sources []*FinanceUpdateSource) ([]int64, error) {
	if normalizedCategoryCorrectionScope(request.CategoryScope) != CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED {
		return []int64{request.EventId}, nil
	}
	if e.evidence == nil || !isCategoryOnlyCorrection(request.Correction) {
		return nil, ErrCorrectionRequestInvalid
	}
	return e.matchingUncategorizedCategoryEventIds(c, request.Uid, request.UpdateId, request.EventId, sources, request.Correction.CategoryId)
}

func (e *CorrectionEngine) InspectCategoryCorrectionScope(c core.Context, uid int64, updateId int64, eventId int64) (*CategoryCorrectionScopePreview, error) {
	if e == nil || e.repository == nil || e.evidence == nil || uid < 1 || updateId < 1 || eventId < 1 {
		return nil, ErrCorrectionRequestInvalid
	}
	sources, err := e.repository.ListSources(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	eventIds, err := e.matchingUncategorizedCategoryEventIds(c, uid, updateId, eventId, sources, nil)
	if err != nil {
		return nil, err
	}
	return &CategoryCorrectionScopePreview{MatchingEventCount: int64(len(eventIds))}, nil
}

func (e *CorrectionEngine) matchingUncategorizedCategoryEventIds(c core.Context, uid int64, updateId int64, eventId int64,
	sources []*FinanceUpdateSource, allowedSelectedCategoryId *int64) ([]int64, error) {
	events, err := e.repository.ListEvents(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	var selected *EconomicEvent
	eventIds := make([]int64, 0, len(events))
	for _, event := range events {
		if event == nil {
			continue
		}
		eventIds = append(eventIds, event.EventId)
		if event.EventId == eventId {
			selected = event
		}
	}
	if selected == nil || selected.Status != EVENT_STATUS_READY || categoryTypeForNature(selected.EconomicNature) == 0 ||
		(selected.CategoryId != nil && (allowedSelectedCategoryId == nil || *selected.CategoryId != *allowedSelectedCategoryId)) {
		return nil, ErrCorrectionEventConflict
	}
	keysByEvent, err := categoryAliasKeysForEvents(c, e.repository, e.evidence, uid, sources, eventIds)
	if err != nil {
		return nil, err
	}
	selectedKeys := keysByEvent[selected.EventId]
	result := []int64{selected.EventId}
	if len(selectedKeys) < 1 {
		return result, nil
	}
	for _, event := range events {
		if event == nil || event.EventId == selected.EventId || event.Status != EVENT_STATUS_READY || event.CategoryId != nil ||
			event.EconomicNature != selected.EconomicNature || !categoryKeySetsIntersect(selectedKeys, keysByEvent[event.EventId]) {
			continue
		}
		result = append(result, event.EventId)
	}
	return result, nil
}

func normalizedCategoryCorrectionScope(scope CategoryCorrectionScope) CategoryCorrectionScope {
	if scope == "" {
		return CATEGORY_CORRECTION_SCOPE_SINGLE
	}
	return scope
}

func isCategoryOnlyCorrection(correction EventCorrection) bool {
	mask, valid := correctionEffectiveMask(correction)
	return valid && correction.FieldMask == MANUAL_FIELD_CATEGORY && mask == MANUAL_FIELD_CATEGORY &&
		correction.CategoryId != nil && *correction.CategoryId > 0
}

func categoryKeySetsIntersect(left map[string]struct{}, right map[string]struct{}) bool {
	if len(left) > len(right) {
		left, right = right, left
	}
	for key := range left {
		if _, ok := right[key]; ok {
			return true
		}
	}
	return false
}

func validCorrectionRequest(engine *CorrectionEngine, request CorrectEventRequest) bool {
	_, validMask := correctionEffectiveMask(request.Correction)
	scope := normalizedCategoryCorrectionScope(request.CategoryScope)
	return engine != nil && engine.repository != nil && engine.ids != nil && engine.now != nil && engine.locks != nil &&
		request.Uid > 0 && request.UpdateId > 0 && request.EventId > 0 && request.ExpectedUpdateVersion > 0 && request.ExpectedEventVersion > 0 &&
		strings.TrimSpace(request.IdempotencyKey) != "" && len(request.IdempotencyKey) <= maximumOrganizeIdempotencyKeyLength && validMask &&
		(scope == CATEGORY_CORRECTION_SCOPE_SINGLE || (scope == CATEGORY_CORRECTION_SCOPE_MATCHING_UNCATEGORIZED && isCategoryOnlyCorrection(request.Correction)))
}

// correctionEffectiveMask keeps the legacy status field as a compatibility
// hint, but only an explicit exclusion is persisted as a manual status fact.
// ready and needs_action are always derived by EvaluatePostability.
func correctionEffectiveMask(correction EventCorrection) (int64, bool) {
	if correction.FieldMask <= 0 || correction.FieldMask&^MANUAL_FIELD_ALL != 0 {
		return 0, false
	}
	statusSelected := correction.FieldMask&MANUAL_FIELD_STATUS != 0
	if correction.Status != "" && !statusSelected {
		return 0, false
	}
	mask := correction.FieldMask &^ MANUAL_FIELD_STATUS
	if statusSelected {
		switch correction.Status {
		case EVENT_STATUS_EXCLUDED:
			mask |= MANUAL_FIELD_STATUS
		case EVENT_STATUS_READY, EVENT_STATUS_NEEDS_ACTION:
			// Compatibility only. The server derives the actual status below.
		default:
			return 0, false
		}
	}
	return mask, mask != 0
}

func applyEventCorrection(current *EconomicEvent, correction EventCorrection, relations []*EconomicEventRelation, actionId int64, now int64) (*EconomicEvent, error) {
	manualMask, validMask := correctionEffectiveMask(correction)
	if current == nil || !validMask {
		return nil, ErrCorrectionRequestInvalid
	}
	next := *current
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

	clearMask := int64(0)
	var postability *PostabilityResult
	if manualMask&MANUAL_FIELD_STATUS != 0 && correction.Status == EVENT_STATUS_EXCLUDED {
		next.Status = EVENT_STATUS_EXCLUDED
		postability = &PostabilityResult{Status: EVENT_STATUS_EXCLUDED}
	} else {
		if correction.FieldMask&MANUAL_FIELD_STATUS != 0 {
			clearMask = MANUAL_FIELD_STATUS
		}
		// Reset the old display status before deriving a fresh result, which also
		// allows an explicitly restored exclusion to become actionable again.
		next.Status = EVENT_STATUS_NEEDS_ACTION
		derived, err := EvaluatePostability(PostabilityInput{
			Event:                   &next,
			Relations:               relations,
			ExistingBlockingReasons: hardBlockingReasonCodes(current.ReasonCodesJson),
		})
		if err != nil {
			return nil, err
		}
		postability = derived
		next.Status = derived.Status
	}

	next.Version = current.Version + 1
	next.ManualFieldMask &^= clearMask
	next.ManualFieldMask |= manualMask
	next.FieldSourcesJson = correctedFieldSources(current.FieldSourcesJson, manualMask, clearMask, actionId)
	next.ReasonCodesJson = mergePostabilityReasonCodes(current.ReasonCodesJson, postability, &next, reasonManualCorrection)
	next.UpdatedUnixTime = now
	if !isValidEventCAS(&next, current.Uid, current.Version) {
		return nil, ErrCorrectionRequestInvalid
	}
	return &next, nil
}

func correctedFieldSources(encoded string, setMask int64, clearMask int64, actionId int64) string {
	fields := make(map[string]string)
	_ = json.Unmarshal([]byte(encoded), &fields)
	ref := "action:" + strconv.FormatInt(actionId, 10)
	fieldBits := map[string]int64{
		"ledger_account": MANUAL_FIELD_LEDGER_ACCOUNT, "counterparty_ledger_account": MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT,
		"direction": MANUAL_FIELD_FLOW_DIRECTION, "economic_nature": MANUAL_FIELD_ECONOMIC_NATURE,
		"event_time": MANUAL_FIELD_EVENT_TIME, "amount": MANUAL_FIELD_AMOUNT, "currency": MANUAL_FIELD_CURRENCY,
		"category": MANUAL_FIELD_CATEGORY, "status": MANUAL_FIELD_STATUS,
	}
	for field, bit := range fieldBits {
		if clearMask&bit != 0 {
			delete(fields, field)
		}
		if setMask&bit != 0 {
			fields[field] = ref
		}
	}
	value, _ := json.Marshal(fields)
	return string(value)
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
			strconv.FormatInt(request.Correction.FieldMask, 10), string(normalizedCategoryCorrectionScope(request.CategoryScope)), correctionDigest(request.Correction)),
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func correctionDigest(value EventCorrection) string {
	encoded, _ := json.Marshal(value)
	return digestOrganizeValue(string(encoded))
}
