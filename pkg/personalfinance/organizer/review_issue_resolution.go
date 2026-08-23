package organizer

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var (
	ErrReviewIssueRequestInvalid  = errors.New("review issue request is invalid")
	ErrReviewIssueNotFound        = errors.New("review issue is not found")
	ErrReviewIssueVersionConflict = errors.New("review issue version conflict")
	ErrReviewIssueStateConflict   = errors.New("review issue state conflict")
	ErrReviewIssueDecisionInvalid = errors.New("review issue decision is invalid")
)

type ReviewIssueDecision string

const (
	REVIEW_ISSUE_DECISION_APPLY_FIELDS     ReviewIssueDecision = "apply_fields"
	REVIEW_ISSUE_DECISION_CONFIRM_DISTINCT ReviewIssueDecision = "confirm_distinct"
	REVIEW_ISSUE_DECISION_CONFIRM_SAME     ReviewIssueDecision = "confirm_same"
	REVIEW_ISSUE_DECISION_EXCLUDE_EVENTS   ReviewIssueDecision = "exclude_events"
	REVIEW_ISSUE_DECISION_DISCARD_EVIDENCE ReviewIssueDecision = "discard_evidence"
	REVIEW_ISSUE_DECISION_LINK_REFUND      ReviewIssueDecision = "link_refund"
	REVIEW_ISSUE_DECISION_LINK_EXISTING    ReviewIssueDecision = "link_existing_transaction"
)

type ResolveReviewIssueRequest struct {
	Uid                   int64
	UpdateId              int64
	IssueId               int64
	ExpectedUpdateVersion int64
	ExpectedIssueVersion  int64
	IdempotencyKey        string
	Decision              ReviewIssueDecision
	Correction            EventCorrection
	PrimaryEventId        int64
	EventIds              []int64
	EvidenceId            int64
	TargetEventId         int64
	TransactionId         int64
}

type ResolveReviewIssueResult struct {
	Update    *FinanceUpdate
	Issue     *ReviewIssue
	Events    []*EconomicEvent
	Relations []*EconomicEventRelation
	Links     []*EconomicEventTransaction
	Action    *FinanceAction
	Replayed  bool
}

type ReviewIssueEngine struct {
	repository *Repository
	ids        IdentifierGenerator
	now        func() time.Time
	locks      *postingLockSet
}

func NewReviewIssueEngine(repository *Repository, ids IdentifierGenerator) (*ReviewIssueEngine, error) {
	if repository == nil || ids == nil {
		return nil, ErrReviewIssueRequestInvalid
	}
	return &ReviewIssueEngine{repository: repository, ids: ids, now: time.Now, locks: globalPostingLocks}, nil
}

func (e *ReviewIssueEngine) Resolve(c core.Context, request ResolveReviewIssueRequest) (*ResolveReviewIssueResult, error) {
	if !validResolveReviewIssueRequest(e, request) {
		return nil, ErrReviewIssueRequestInvalid
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
		return nil, ErrReviewIssueRequestInvalid
	}
	candidate := newResolveReviewIssueAction(request, actionId, now)
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
			return ErrReviewIssueStateConflict
		}

		update, findErr := tx.FindUpdateById(request.UpdateId)
		if findErr != nil {
			return findErr
		}
		if update == nil || update.Version != request.ExpectedUpdateVersion {
			return ErrReviewIssueVersionConflict
		}
		if update.Status != UPDATE_STATUS_REVIEW && update.Status != UPDATE_STATUS_PARTIALLY_POSTED {
			return ErrReviewIssueStateConflict
		}
		issue, findErr := tx.FindReviewIssueById(request.IssueId)
		if findErr != nil {
			return findErr
		}
		if issue == nil || issue.UpdateId != request.UpdateId {
			return ErrReviewIssueNotFound
		}
		if issue.Version != request.ExpectedIssueVersion {
			return ErrReviewIssueVersionConflict
		}
		if issue.Status != REVIEW_ISSUE_STATUS_OPEN || !issue.Blocking || issue.ResolvedActionId != nil {
			return ErrReviewIssueStateConflict
		}
		members, findErr := tx.ListReviewIssueMembers(issue.IssueId)
		if findErr != nil {
			return findErr
		}
		events, findErr := loadReviewIssueSubjectEvents(tx, issue, members)
		if findErr != nil {
			return findErr
		}

		applying := *action
		applying.Status = ACTION_STATUS_APPLYING
		applying.StartedUnixTime = &now
		applying.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateActionCAS(ACTION_STATUS_READY, &applying)
		if updateErr != nil || !updated {
			return ErrReviewIssueStateConflict
		}

		nextUpdate := *update
		resolvedEvents, decisionErr := e.applyDecision(tx, issue, members, events, request, &nextUpdate, action.ActionId, now)
		if decisionErr != nil {
			return decisionErr
		}

		resolvedIssue := *issue
		resolvedIssue.Status = REVIEW_ISSUE_STATUS_RESOLVED
		resolvedIssue.Version = issue.Version + 1
		resolvedIssue.Blocking = false
		resolvedIssue.ResolvedActionId = &action.ActionId
		resolvedIssue.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateReviewIssueCAS(issue.Version, &resolvedIssue)
		if updateErr != nil || !updated {
			return ErrReviewIssueVersionConflict
		}
		if err := e.createFollowUpIssues(tx, &resolvedIssue, resolvedEvents, action.ActionId, now); err != nil {
			return err
		}

		nextUpdate.Version = update.Version + 1
		nextUpdate.CurrentActionId = &action.ActionId
		nextUpdate.UpdatedUnixTime = now
		if !validConservation(&nextUpdate) {
			return ErrReviewIssueStateConflict
		}
		updated, updateErr = tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if updateErr != nil || !updated {
			return ErrReviewIssueVersionConflict
		}

		applied := applying
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedUpdateVersion = nextUpdate.Version
		applied.ReasonCodesJson = reasonCodesJSON([]string{"review_issue_resolved", "decision:" + string(request.Decision)})
		applied.CompletedUnixTime = &now
		applied.UpdatedUnixTime = now
		updated, updateErr = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &applied)
		if updateErr != nil || !updated {
			return ErrReviewIssueStateConflict
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return e.loadResult(c, request, persistedActionId, replayed)
}

func validResolveReviewIssueRequest(engine *ReviewIssueEngine, request ResolveReviewIssueRequest) bool {
	if engine == nil || engine.repository == nil || engine.ids == nil || engine.now == nil || engine.locks == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.IssueId < 1 || request.ExpectedUpdateVersion < 1 || request.ExpectedIssueVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength || !isReviewIssueDecision(request.Decision) {
		return false
	}
	switch request.Decision {
	case REVIEW_ISSUE_DECISION_APPLY_FIELDS:
		mask, valid := correctionEffectiveMask(request.Correction)
		return valid && mask&MANUAL_FIELD_STATUS == 0
	case REVIEW_ISSUE_DECISION_CONFIRM_SAME:
		return request.PrimaryEventId > 0
	case REVIEW_ISSUE_DECISION_DISCARD_EVIDENCE:
		return request.EvidenceId > 0
	case REVIEW_ISSUE_DECISION_LINK_REFUND:
		return request.TargetEventId > 0
	case REVIEW_ISSUE_DECISION_LINK_EXISTING:
		return request.TransactionId > 0
	default:
		return true
	}
}

func isReviewIssueDecision(value ReviewIssueDecision) bool {
	switch value {
	case REVIEW_ISSUE_DECISION_APPLY_FIELDS, REVIEW_ISSUE_DECISION_CONFIRM_DISTINCT,
		REVIEW_ISSUE_DECISION_CONFIRM_SAME, REVIEW_ISSUE_DECISION_EXCLUDE_EVENTS,
		REVIEW_ISSUE_DECISION_DISCARD_EVIDENCE, REVIEW_ISSUE_DECISION_LINK_REFUND,
		REVIEW_ISSUE_DECISION_LINK_EXISTING:
		return true
	default:
		return false
	}
}

func loadReviewIssueSubjectEvents(tx *RepositoryTransaction, issue *ReviewIssue, members []*ReviewIssueMember) ([]*EconomicEvent, error) {
	if tx == nil || issue == nil || len(members) < 1 {
		return nil, ErrReviewIssueStateConflict
	}
	events := make([]*EconomicEvent, 0)
	seen := make(map[int64]struct{})
	for _, member := range members {
		if member == nil || member.Uid != issue.Uid || member.UpdateId != issue.UpdateId || member.IssueId != issue.IssueId {
			return nil, ErrReviewIssueStateConflict
		}
		if member.Role != REVIEW_ISSUE_MEMBER_ROLE_SUBJECT || member.ObjectType != REVIEW_OBJECT_TYPE_EVENT {
			continue
		}
		if _, exists := seen[member.ObjectId]; exists {
			return nil, ErrReviewIssueStateConflict
		}
		event, err := tx.FindEventById(member.ObjectId)
		if err != nil {
			return nil, err
		}
		if event == nil || event.UpdateId != issue.UpdateId || event.Version != member.ObjectVersion ||
			event.Status == EVENT_STATUS_POSTED || event.Status == EVENT_STATUS_CORRECTED {
			return nil, ErrReviewIssueVersionConflict
		}
		seen[event.EventId] = struct{}{}
		events = append(events, event)
	}
	if len(events) < 1 {
		return nil, ErrReviewIssueStateConflict
	}
	sort.Slice(events, func(i, j int) bool { return events[i].EventId < events[j].EventId })
	return events, nil
}

func (e *ReviewIssueEngine) applyDecision(tx *RepositoryTransaction, issue *ReviewIssue, members []*ReviewIssueMember, events []*EconomicEvent,
	request ResolveReviewIssueRequest, update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	switch request.Decision {
	case REVIEW_ISSUE_DECISION_APPLY_FIELDS:
		return e.applyFields(tx, issue, events, request.Correction, update, actionId, now)
	case REVIEW_ISSUE_DECISION_CONFIRM_DISTINCT:
		if issue.IssueType != REVIEW_ISSUE_TYPE_SAME_EVENT && issue.IssueType != REVIEW_ISSUE_TYPE_IDENTITY_CONFLICT {
			return nil, ErrReviewIssueDecisionInvalid
		}
		ids := reviewEventIds(events)
		if err := tx.RejectProposedRelationsForEvents(ids, now); err != nil {
			return nil, err
		}
		return e.rederiveEvents(tx, issue, events, update, actionId, now)
	case REVIEW_ISSUE_DECISION_CONFIRM_SAME:
		if issue.IssueType != REVIEW_ISSUE_TYPE_SAME_EVENT || len(events) < 2 {
			return nil, ErrReviewIssueDecisionInvalid
		}
		return e.confirmSameEvent(tx, issue, events, request.PrimaryEventId, update, actionId, now)
	case REVIEW_ISSUE_DECISION_EXCLUDE_EVENTS:
		return e.excludeEvents(tx, issue, selectReviewEvents(events, request.EventIds), update, actionId, now)
	case REVIEW_ISSUE_DECISION_DISCARD_EVIDENCE:
		return e.discardEvidence(tx, issue, events, request.EvidenceId, update, actionId, now)
	case REVIEW_ISSUE_DECISION_LINK_REFUND:
		if issue.IssueType != REVIEW_ISSUE_TYPE_REFUND_RELATION || len(events) != 1 {
			return nil, ErrReviewIssueDecisionInvalid
		}
		return e.linkRefund(tx, issue, events[0], request.TargetEventId, update, actionId, now)
	case REVIEW_ISSUE_DECISION_LINK_EXISTING:
		return e.linkExistingTransaction(tx, issue, events, request.PrimaryEventId, request.TransactionId, update, actionId, now)
	default:
		return nil, ErrReviewIssueDecisionInvalid
	}
}

func (e *ReviewIssueEngine) applyFields(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent, correction EventCorrection,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	result := make([]*EconomicEvent, 0, len(events))
	for _, event := range events {
		next, err := rederiveReviewEvent(tx, issue, event, &correction, actionId, now)
		if err != nil {
			return nil, err
		}
		transitionReviewEventCount(update, event.Status, next.Status)
		result = append(result, next)
	}
	return result, nil
}

func (e *ReviewIssueEngine) rederiveEvents(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	result := make([]*EconomicEvent, 0, len(events))
	for _, event := range events {
		next, err := rederiveReviewEvent(tx, issue, event, nil, actionId, now)
		if err != nil {
			return nil, err
		}
		transitionReviewEventCount(update, event.Status, next.Status)
		result = append(result, next)
	}
	return result, nil
}

func (e *ReviewIssueEngine) confirmSameEvent(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent, primaryEventId int64,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	var primary *EconomicEvent
	for _, event := range events {
		if event.EventId == primaryEventId {
			primary = event
			break
		}
	}
	if primary == nil {
		return nil, ErrReviewIssueDecisionInvalid
	}
	ids := reviewEventIds(events)
	if err := tx.RejectProposedRelationsForEvents(ids, now); err != nil {
		return nil, err
	}
	removed := int64(0)
	for _, event := range events {
		if event.EventId == primary.EventId {
			continue
		}
		if links, err := tx.CountEventTransactionLinks(event.EventId); err != nil || links != 0 {
			return nil, ErrReviewIssueStateConflict
		}
		if _, err := tx.MoveEventEvidence(event.EventId, primary.EventId); err != nil {
			return nil, err
		}
		deleted, err := tx.DeleteUnpostedEvent(event.EventId)
		if err != nil || !deleted {
			return nil, ErrReviewIssueStateConflict
		}
		decrementReviewEventCount(update, event.Status)
		removed++
	}
	update.FinalEventCount -= removed
	update.DuplicateEvidenceCount += removed
	next, err := rederiveReviewEvent(tx, issue, primary, nil, actionId, now)
	if err != nil {
		return nil, err
	}
	transitionReviewEventCount(update, primary.Status, next.Status)
	return []*EconomicEvent{next}, nil
}

func (e *ReviewIssueEngine) excludeEvents(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	if len(events) < 1 {
		return nil, ErrReviewIssueDecisionInvalid
	}
	result := make([]*EconomicEvent, 0, len(events))
	for _, event := range events {
		next := *event
		next.Status = EVENT_STATUS_EXCLUDED
		next.Version = event.Version + 1
		next.ManualFieldMask |= MANUAL_FIELD_STATUS
		next.FieldSourcesJson = correctedFieldSources(event.FieldSourcesJson, MANUAL_FIELD_STATUS, 0, actionId)
		next.ReasonCodesJson = reasonCodesJSON(appendUniqueReasons(retainedInformationalReasonCodes(event.ReasonCodesJson), "manual_exclusion"))
		next.UpdatedUnixTime = now
		updated, err := tx.UpdateEventCAS(event.Version, &next)
		if err != nil || !updated {
			return nil, ErrReviewIssueVersionConflict
		}
		transitionReviewEventCount(update, event.Status, next.Status)
		result = append(result, &next)
	}
	return result, nil
}

func (e *ReviewIssueEngine) discardEvidence(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent, evidenceId int64,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	for _, event := range events {
		items, err := tx.ListEventEvidence(event.EventId)
		if err != nil {
			return nil, err
		}
		found := false
		usable := int64(0)
		for _, item := range items {
			if item.EvidenceId == evidenceId {
				if item.EvidenceRole == EVIDENCE_ROLE_DISCARDED {
					return nil, ErrReviewIssueStateConflict
				}
				updated, updateErr := tx.UpdateEvidenceRole(item.EvidenceId, item.EvidenceRole, EVIDENCE_ROLE_DISCARDED)
				if updateErr != nil || !updated {
					return nil, ErrReviewIssueVersionConflict
				}
				found = true
				continue
			}
			if item.EvidenceRole != EVIDENCE_ROLE_DISCARDED {
				usable++
			}
		}
		if !found {
			continue
		}
		if usable == 0 {
			return e.excludeEvents(tx, issue, []*EconomicEvent{event}, update, actionId, now)
		}
		return e.rederiveEvents(tx, issue, []*EconomicEvent{event}, update, actionId, now)
	}
	return nil, ErrReviewIssueDecisionInvalid
}

func (e *ReviewIssueEngine) linkRefund(tx *RepositoryTransaction, issue *ReviewIssue, refund *EconomicEvent, targetEventId int64,
	update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	if refund.EconomicNature != ECONOMIC_NATURE_REFUND || refund.Amount == nil || *refund.Amount <= 0 {
		return nil, ErrReviewIssueDecisionInvalid
	}
	original, err := tx.FindEventById(targetEventId)
	if err != nil {
		return nil, err
	}
	if original == nil || original.EventId == refund.EventId || original.EconomicNature != ECONOMIC_NATURE_EXPENSE ||
		original.Status == EVENT_STATUS_EXCLUDED || original.Amount == nil || *original.Amount < *refund.Amount ||
		original.Currency != refund.Currency || original.EventUnixTime == nil || refund.EventUnixTime == nil ||
		*original.EventUnixTime > *refund.EventUnixTime {
		return nil, ErrReviewIssueDecisionInvalid
	}
	total, err := tx.SumConfirmedRefundAmountForEvent(original.EventId, refund.EventId)
	if err != nil || total > *original.Amount-*refund.Amount {
		return nil, ErrReviewIssueDecisionInvalid
	}
	relations, err := tx.ListRelations(refund.EventId)
	if err != nil {
		return nil, err
	}
	var selected *EconomicEventRelation
	for _, relation := range relations {
		if relation.RelationType == RELATION_TYPE_REFUND_OF && relation.SourceEventId == refund.EventId && relation.TargetEventId == original.EventId &&
			relation.Status != RELATION_STATUS_REJECTED && relation.Status != RELATION_STATUS_UNDONE {
			selected = relation
			break
		}
	}
	if selected == nil {
		amount := *refund.Amount
		selected = &EconomicEventRelation{
			Uid: refund.Uid, UpdateId: refund.UpdateId,
			RelationKey:        relationKey(refund.Uid, RELATION_TYPE_REFUND_OF, refund.EventId, original.EventId),
			RelationKeyVersion: RELATION_KEY_VERSION_V1, RelationType: RELATION_TYPE_REFUND_OF,
			Status: RELATION_STATUS_CONFIRMED, Version: 1, SourceEventId: refund.EventId, TargetEventId: original.EventId,
			Amount: &amount, Currency: refund.Currency, Manual: true, RuleVersion: REVIEW_ISSUE_RULE_VERSION_V1,
			ReasonCodesJson: reasonCodesJSON([]string{"manual_refund_relation"}), CreatedUnixTime: now, UpdatedUnixTime: now,
			RelationId: e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE),
		}
		if selected.RelationId < 1 || tx.InsertRelation(selected) != nil {
			return nil, ErrReviewIssueStateConflict
		}
	} else if selected.Status != RELATION_STATUS_CONFIRMED || !selected.Manual {
		next := *selected
		amount := *refund.Amount
		next.Status = RELATION_STATUS_CONFIRMED
		next.Version = selected.Version + 1
		next.Amount = &amount
		next.Currency = refund.Currency
		next.Manual = true
		next.ReasonCodesJson = reasonCodesJSON([]string{"manual_refund_relation"})
		next.UpdatedUnixTime = now
		updated, updateErr := tx.UpdateRelationCAS(selected.Version, &next)
		if updateErr != nil || !updated {
			return nil, ErrReviewIssueVersionConflict
		}
	}
	if err = tx.RejectOtherProposedRefundRelations(refund.EventId, selected.RelationId, now); err != nil {
		return nil, err
	}
	return e.rederiveEvents(tx, issue, []*EconomicEvent{refund}, update, actionId, now)
}

func (e *ReviewIssueEngine) linkExistingTransaction(tx *RepositoryTransaction, issue *ReviewIssue, events []*EconomicEvent,
	primaryEventId int64, transactionId int64, update *FinanceUpdate, actionId int64, now int64) ([]*EconomicEvent, error) {
	primary := events[0]
	if primaryEventId > 0 {
		primary = nil
		for _, event := range events {
			if event.EventId == primaryEventId {
				primary = event
				break
			}
		}
		if primary == nil {
			return nil, ErrReviewIssueDecisionInvalid
		}
	}
	if len(events) > 1 {
		merged, err := e.confirmSameEvent(tx, issue, events, primary.EventId, update, actionId, now)
		if err != nil {
			return nil, err
		}
		primary = merged[0]
	}
	transaction, err := tx.FindLedgerTransaction(transactionId)
	if err != nil {
		return nil, err
	}
	if transaction == nil || transactionAlreadyLinked(tx, transactionId) || !eventMatchesLedgerTransaction(primary, transaction) {
		return nil, ErrReviewIssueDecisionInvalid
	}
	link := &EconomicEventTransaction{
		Uid: primary.Uid, UpdateId: primary.UpdateId, EventId: primary.EventId, TransactionId: transaction.TransactionId,
		Role: EVENT_TRANSACTION_ROLE_HISTORICAL_PRIMARY, RuleVersion: EVENT_TRANSACTION_VERSION_V1,
		TransactionUpdatedUnixTime: transaction.UpdatedUnixTime, CreatedUnixTime: now,
		LinkId: e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE),
	}
	if link.LinkId < 1 || tx.InsertHistoricalTransactionLink(link) != nil {
		return nil, ErrReviewIssueStateConflict
	}
	current, err := tx.FindEventById(primary.EventId)
	if err != nil || current == nil {
		return nil, ErrReviewIssueStateConflict
	}
	next := *current
	next.Status = EVENT_STATUS_POSTED
	next.Version = current.Version + 1
	next.ManualFieldMask |= MANUAL_FIELD_STATUS
	next.FieldSourcesJson = correctedFieldSources(current.FieldSourcesJson, MANUAL_FIELD_STATUS, 0, actionId)
	next.ReasonCodesJson = reasonCodesJSON(appendUniqueReasons(retainedInformationalReasonCodes(current.ReasonCodesJson), "linked_existing_transaction"))
	next.UpdatedUnixTime = now
	updated, updateErr := tx.UpdateEventCAS(current.Version, &next)
	if updateErr != nil || !updated {
		return nil, ErrReviewIssueVersionConflict
	}
	transitionReviewEventCount(update, current.Status, next.Status)
	return []*EconomicEvent{&next}, nil
}

func transactionAlreadyLinked(tx *RepositoryTransaction, transactionId int64) bool {
	link, err := tx.FindEventLinkByTransactionId(transactionId)
	return err != nil || link != nil
}

func eventMatchesLedgerTransaction(event *EconomicEvent, transaction *models.Transaction) bool {
	if event == nil || transaction == nil || event.Amount == nil || event.LedgerAccountId == nil ||
		*event.Amount != transaction.Amount || *event.LedgerAccountId != transaction.AccountId {
		return false
	}
	switch event.EconomicNature {
	case ECONOMIC_NATURE_INCOME, ECONOMIC_NATURE_REFUND:
		return transaction.Type == models.TRANSACTION_DB_TYPE_INCOME
	case ECONOMIC_NATURE_EXPENSE, ECONOMIC_NATURE_FEE:
		return transaction.Type == models.TRANSACTION_DB_TYPE_EXPENSE
	case ECONOMIC_NATURE_INTERNAL_TRANSFER, ECONOMIC_NATURE_REPAYMENT, ECONOMIC_NATURE_BORROW:
		return transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT
	default:
		return false
	}
}

func rederiveReviewEvent(tx *RepositoryTransaction, issue *ReviewIssue, current *EconomicEvent, correction *EventCorrection,
	actionId int64, now int64) (*EconomicEvent, error) {
	if tx == nil || issue == nil || current == nil {
		return nil, ErrReviewIssueStateConflict
	}
	next := *current
	manualMask := int64(0)
	if correction != nil {
		mask, valid := correctionEffectiveMask(*correction)
		if !valid || mask&MANUAL_FIELD_STATUS != 0 {
			return nil, ErrReviewIssueDecisionInvalid
		}
		manualMask = mask
		applyReviewCorrectionFields(&next, *correction)
	}
	relations, err := tx.ListRelations(current.EventId)
	if err != nil {
		return nil, err
	}
	links, err := tx.ListEventTransactions(current.EventId)
	if err != nil {
		return nil, err
	}
	openCount, err := tx.CountOpenBlockingReviewIssuesForEvent(current.EventId)
	if err != nil {
		return nil, err
	}
	if openCount > 0 {
		openCount--
	}
	blockers := unresolvedReviewBlockers(current.ReasonCodesJson, issue.IssueType)
	next.Status = EVENT_STATUS_NEEDS_ACTION
	postability, err := EvaluatePostability(PostabilityInput{
		Event: &next, Relations: relations, Links: links,
		ExistingBlockingReasons: blockers, OpenBlockingIssueCount: openCount,
	})
	if err != nil {
		return nil, err
	}
	next.Status = postability.Status
	next.Version = current.Version + 1
	next.ManualFieldMask |= manualMask
	if manualMask != 0 {
		next.FieldSourcesJson = correctedFieldSources(current.FieldSourcesJson, manualMask, 0, actionId)
	}
	next.ReasonCodesJson = mergePostabilityReasonCodes(current.ReasonCodesJson, postability, &next, "review_issue_decision")
	next.UpdatedUnixTime = now
	updated, err := tx.UpdateEventCAS(current.Version, &next)
	if err != nil || !updated {
		return nil, ErrReviewIssueVersionConflict
	}
	return &next, nil
}

func applyReviewCorrectionFields(event *EconomicEvent, correction EventCorrection) {
	if correction.FieldMask&MANUAL_FIELD_FLOW_DIRECTION != 0 {
		event.FlowDirection = correction.FlowDirection
	}
	if correction.FieldMask&MANUAL_FIELD_ECONOMIC_NATURE != 0 {
		event.EconomicNature = correction.EconomicNature
	}
	if correction.FieldMask&MANUAL_FIELD_LEDGER_ACCOUNT != 0 {
		event.LedgerAccountId = cloneInt64Pointer(correction.LedgerAccountId)
	}
	if correction.FieldMask&MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT != 0 {
		event.CounterpartyLedgerAccountId = cloneInt64Pointer(correction.CounterpartyLedgerAccountId)
	}
	if correction.FieldMask&MANUAL_FIELD_EVENT_TIME != 0 {
		event.EventUnixTime = cloneInt64Pointer(correction.EventUnixTime)
		event.TimezoneUtcOffset = cloneInt16Pointer(correction.TimezoneUtcOffset)
	}
	if correction.FieldMask&MANUAL_FIELD_AMOUNT != 0 {
		event.Amount = cloneInt64Pointer(correction.Amount)
	}
	if correction.FieldMask&MANUAL_FIELD_CURRENCY != 0 {
		event.Currency = correction.Currency
	}
	if correction.FieldMask&MANUAL_FIELD_CATEGORY != 0 {
		event.CategoryId = cloneInt64Pointer(correction.CategoryId)
	}
}

func unresolvedReviewBlockers(encoded string, issueType ReviewIssueType) []string {
	result := make([]string, 0)
	for _, reason := range hardBlockingReasonCodes(encoded) {
		if reason == reasonBlockingIssueOpen || reviewIssueResolvesReason(issueType, reason) {
			continue
		}
		result = appendUniqueReasons(result, reason)
	}
	return result
}

func reviewIssueResolvesReason(issueType ReviewIssueType, reason string) bool {
	switch issueType {
	case REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING:
		return reason == reasonLedgerAccountRequired || reason == reasonCoreFieldsMissing
	case REVIEW_ISSUE_TYPE_SHARED_FIELDS:
		return reason == reasonCoreFieldsMissing || reason == reasonEconomicNatureRequired || reason == reasonPostabilityDirectionConflict
	case REVIEW_ISSUE_TYPE_SAME_EVENT:
		return reason == reasonRelationAmbiguous
	case REVIEW_ISSUE_TYPE_REFUND_RELATION:
		return reason == reasonRefundRelationRequired || reason == reasonRefundRelationAmbiguous || reason == reasonRefundAmountExceeded ||
			reason == reasonRefundRelationInvalid || reason == reasonRelationAmbiguous
	case REVIEW_ISSUE_TYPE_TRANSFER_ACCOUNTS:
		return reason == reasonTransferAccountRequired || reason == reasonRepaymentAccountRequired || reason == reasonBorrowAccountRequired || reason == reasonRelationAmbiguous
	case REVIEW_ISSUE_TYPE_IDENTITY_CONFLICT:
		return reason == reasonIdentityConflict || reason == reasonIdentityReviewRequired
	case REVIEW_ISSUE_TYPE_FIELD_CONFLICT:
		return reason == reasonCoreFieldsConflict
	default:
		return false
	}
}

func (e *ReviewIssueEngine) createFollowUpIssues(tx *RepositoryTransaction, resolved *ReviewIssue, events []*EconomicEvent, actionId int64, now int64) error {
	for index, event := range events {
		if event == nil || event.Status != EVENT_STATUS_NEEDS_ACTION {
			continue
		}
		reasons := decodeReasonCodes(event.ReasonCodesJson)
		spec := classifyReviewIssue(event, reasons)
		issueId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
		memberId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
		if issueId < 1 || memberId < 1 {
			return ErrReviewIssueStateConflict
		}
		key := stablePlanDigest("follow-up-review-issue", string(REVIEW_ISSUE_KEY_VERSION_V1),
			strconv.FormatInt(event.Uid, 10), strconv.FormatInt(event.UpdateId, 10), strconv.FormatInt(event.EventId, 10),
			strconv.FormatInt(actionId, 10), spec.primaryReason)
		nextEvent := *event
		nextEvent.Version = event.Version + 1
		nextEvent.ReasonCodesJson = reasonCodesJSON(appendUniqueReasons(reasons, reasonBlockingIssueOpen))
		nextEvent.UpdatedUnixTime = now
		updated, err := tx.UpdateEventCAS(event.Version, &nextEvent)
		if err != nil || !updated {
			return ErrReviewIssueVersionConflict
		}
		events[index] = &nextEvent
		issue := &ReviewIssue{
			Uid: event.Uid, UpdateId: event.UpdateId, Status: REVIEW_ISSUE_STATUS_OPEN, IssueType: spec.issueType,
			IssueKey: key, IssueKeyVersion: REVIEW_ISSUE_KEY_VERSION_V1, Version: 1, Blocking: true,
			PrimaryReasonCode: spec.primaryReason, MemberCount: 1, CandidateCount: 0,
			RuleVersion: REVIEW_ISSUE_RULE_VERSION_V1, ReasonCodesJson: nextEvent.ReasonCodesJson,
			CreatedUnixTime: now, UpdatedUnixTime: now, IssueId: issueId,
		}
		member := &ReviewIssueMember{
			Uid: event.Uid, UpdateId: event.UpdateId, IssueId: issueId,
			MemberKey: stablePlanDigest("review-issue-member", string(REVIEW_ISSUE_MEMBER_KEY_VERSION_V1), key,
				string(REVIEW_ISSUE_MEMBER_ROLE_SUBJECT), string(REVIEW_OBJECT_TYPE_EVENT), strconv.FormatInt(event.EventId, 10)),
			MemberKeyVersion: REVIEW_ISSUE_MEMBER_KEY_VERSION_V1, Role: REVIEW_ISSUE_MEMBER_ROLE_SUBJECT,
			ObjectType: REVIEW_OBJECT_TYPE_EVENT, ObjectId: event.EventId, ObjectVersion: nextEvent.Version,
			SortOrder: 0, Score: 0, ReasonCodesJson: nextEvent.ReasonCodesJson, CreatedUnixTime: now, MemberId: memberId,
		}
		if err = tx.InsertReviewIssue(issue); err != nil {
			return err
		}
		if err = tx.InsertReviewIssueMember(member); err != nil {
			return err
		}
	}
	return nil
}

func transitionReviewEventCount(update *FinanceUpdate, from EventStatus, to EventStatus) {
	if from == to {
		return
	}
	decrementReviewEventCount(update, from)
	incrementReviewEventCount(update, to)
}

func decrementReviewEventCount(update *FinanceUpdate, status EventStatus) {
	switch status {
	case EVENT_STATUS_READY:
		update.ReadyEventCount--
	case EVENT_STATUS_NEEDS_ACTION:
		update.NeedsActionEventCount--
	case EVENT_STATUS_EXCLUDED:
		update.ExcludedEventCount--
	case EVENT_STATUS_POSTED, EVENT_STATUS_CORRECTED:
		update.PostedEventCount--
	}
}

func incrementReviewEventCount(update *FinanceUpdate, status EventStatus) {
	switch status {
	case EVENT_STATUS_READY:
		update.ReadyEventCount++
	case EVENT_STATUS_NEEDS_ACTION:
		update.NeedsActionEventCount++
	case EVENT_STATUS_EXCLUDED:
		update.ExcludedEventCount++
	case EVENT_STATUS_POSTED, EVENT_STATUS_CORRECTED:
		update.PostedEventCount++
	}
}

func reviewEventIds(events []*EconomicEvent) []int64 {
	ids := make([]int64, 0, len(events))
	for _, event := range events {
		ids = append(ids, event.EventId)
	}
	return ids
}

func selectReviewEvents(events []*EconomicEvent, selected []int64) []*EconomicEvent {
	if len(selected) == 0 {
		return events
	}
	wanted := make(map[int64]struct{}, len(selected))
	for _, id := range selected {
		if id > 0 {
			wanted[id] = struct{}{}
		}
	}
	result := make([]*EconomicEvent, 0, len(wanted))
	for _, event := range events {
		if _, exists := wanted[event.EventId]; exists {
			result = append(result, event)
		}
	}
	return result
}

func newResolveReviewIssueAction(request ResolveReviewIssueRequest, actionId int64, now int64) *FinanceAction {
	eventIds := append([]int64(nil), request.EventIds...)
	sort.Slice(eventIds, func(i, j int) bool { return eventIds[i] < eventIds[j] })
	encodedCorrection, _ := json.Marshal(request.Correction)
	parts := []string{
		string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), strconv.FormatInt(request.UpdateId, 10),
		strconv.FormatInt(request.IssueId, 10), strconv.FormatInt(request.ExpectedUpdateVersion, 10), strconv.FormatInt(request.ExpectedIssueVersion, 10),
		string(request.Decision), strconv.FormatInt(request.PrimaryEventId, 10), strconv.FormatInt(request.EvidenceId, 10),
		strconv.FormatInt(request.TargetEventId, 10), strconv.FormatInt(request.TransactionId, 10), string(encodedCorrection),
	}
	for _, eventId := range eventIds {
		parts = append(parts, strconv.FormatInt(eventId, 10))
	}
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion,
		ActionType:            ACTION_TYPE_RESOLVE_REVIEW_ISSUE,
		IdempotencyKeyDigest:  digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey)),
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1,
		RequestDigest:         digestOrganizeValue(parts...), RequestDigestVersion: ACTION_REQUEST_VERSION_V1,
		Status: ACTION_STATUS_READY, ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func (e *ReviewIssueEngine) loadResult(c core.Context, request ResolveReviewIssueRequest, actionId int64, replayed bool) (*ResolveReviewIssueResult, error) {
	update, err := e.repository.FindUpdateById(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	issue, err := e.repository.FindReviewIssueById(c, request.Uid, request.IssueId)
	if err != nil {
		return nil, err
	}
	action, err := e.repository.FindActionById(c, request.Uid, actionId)
	if err != nil {
		return nil, err
	}
	members, err := e.repository.ListReviewIssueMembers(c, request.Uid, request.IssueId)
	if err != nil {
		return nil, err
	}
	events := make([]*EconomicEvent, 0)
	relations := make([]*EconomicEventRelation, 0)
	links := make([]*EconomicEventTransaction, 0)
	seenEvents := make(map[int64]struct{})
	seenRelations := make(map[int64]struct{})
	seenLinks := make(map[int64]struct{})
	for _, member := range members {
		if member.ObjectType != REVIEW_OBJECT_TYPE_EVENT {
			continue
		}
		event, findErr := e.repository.FindEventById(c, request.Uid, member.ObjectId)
		if findErr != nil {
			return nil, findErr
		}
		if event == nil {
			continue
		}
		if _, exists := seenEvents[event.EventId]; !exists {
			seenEvents[event.EventId] = struct{}{}
			events = append(events, event)
		}
		items, findErr := e.repository.ListRelations(c, request.Uid, event.EventId)
		if findErr != nil {
			return nil, findErr
		}
		for _, relation := range items {
			if _, exists := seenRelations[relation.RelationId]; !exists {
				seenRelations[relation.RelationId] = struct{}{}
				relations = append(relations, relation)
			}
		}
		transactionLinks, findErr := e.repository.ListEventTransactions(c, request.Uid, event.EventId)
		if findErr != nil {
			return nil, findErr
		}
		for _, link := range transactionLinks {
			if _, exists := seenLinks[link.LinkId]; !exists {
				seenLinks[link.LinkId] = struct{}{}
				links = append(links, link)
			}
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].EventId < events[j].EventId })
	sort.Slice(relations, func(i, j int) bool { return relations[i].RelationId < relations[j].RelationId })
	sort.Slice(links, func(i, j int) bool { return links[i].LinkId < links[j].LinkId })
	return &ResolveReviewIssueResult{Update: update, Issue: issue, Events: events, Relations: relations, Links: links, Action: action, Replayed: replayed}, nil
}
