package organizer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

const maximumOrganizeIdempotencyKeyLength = 128

var (
	ErrOrganizeRequestInvalid  = errors.New("organizer request is invalid")
	ErrOrganizeUpdateNotFound  = errors.New("finance update is not found")
	ErrOrganizeVersionConflict = errors.New("finance update version conflict")
	ErrOrganizeStateConflict   = errors.New("finance update state conflict")
	ErrOrganizeActionTerminal  = errors.New("organizer action is already terminal")
	ErrOrganizePlanExists      = errors.New("finance update already has an event plan")
)

// EvidenceReader 只读取来源快照指向的不可变解析证据。
type EvidenceReader interface {
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error)
	ListRawImportRows(c core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error)
}

type PaymentAccountMappingReader interface {
	ListPaymentAccountMappings(c core.Context, uid int64, sourceType importing.SourceType) ([]*importing.PaymentAccountMapping, error)
}

// LedgerAccountReader 为经济性质判断提供正式账户类别和币种，不允许规划器写账。
type LedgerAccountReader interface {
	GetAccountsByAccountIds(c core.Context, uid int64, accountIds []int64) (map[int64]*models.Account, error)
}

type IdentifierGenerator interface {
	GenerateUuid(uuidType uuid.UuidType) int64
}

type OrganizeRequest struct {
	Uid                   int64
	UpdateId              int64
	ExpectedUpdateVersion int64
	IdempotencyKey        string
}

type OrganizeResult struct {
	Update       *FinanceUpdate
	Action       *FinanceAction
	Events       []*EconomicEvent
	Relations    []*EconomicEventRelation
	Issues       []*ReviewIssue
	IssueMembers []*ReviewIssueMember
	Replayed     bool
}

// Engine 把一次更新从 draft 原子声明为 organizing，再把同一守恒计划原子推进到 review。
// 它不调用旧 billflow/reconciliation，也不创建正式 Transaction。
type Engine struct {
	repository *Repository
	evidence   EvidenceReader
	accounts   LedgerAccountReader
	mappings   PaymentAccountMappingReader
	projector  importing.SourceFundsProjector
	ids        IdentifierGenerator
	now        func() time.Time
}

func NewEngine(repository *Repository, evidence EvidenceReader, accounts LedgerAccountReader, projector importing.SourceFundsProjector, ids IdentifierGenerator) (*Engine, error) {
	mappings, ok := evidence.(PaymentAccountMappingReader)
	if !ok {
		return nil, ErrOrganizeRequestInvalid
	}
	if repository == nil || evidence == nil || accounts == nil || projector == nil || ids == nil {
		return nil, ErrOrganizeRequestInvalid
	}
	return &Engine{repository: repository, evidence: evidence, accounts: accounts, mappings: mappings, projector: projector, ids: ids, now: time.Now}, nil
}

func (e *Engine) Organize(c core.Context, request OrganizeRequest) (*OrganizeResult, error) {
	if e == nil || e.repository == nil || e.evidence == nil || e.accounts == nil || e.projector == nil || e.ids == nil || e.now == nil ||
		request.Uid < 1 || request.UpdateId < 1 || request.ExpectedUpdateVersion < 1 ||
		strings.TrimSpace(request.IdempotencyKey) == "" || len(request.IdempotencyKey) > maximumOrganizeIdempotencyKeyLength {
		return nil, ErrOrganizeRequestInvalid
	}
	now := e.now().Unix()
	if now < 1 {
		return nil, ErrOrganizeRequestInvalid
	}
	actionId := e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	if actionId < 1 {
		return nil, fmt.Errorf("%w: action id", ErrOrganizeRequestInvalid)
	}
	action := newOrganizeAction(request, actionId, now)
	claimed, replayed, err := e.claimOrganize(c, request, action, now)
	if err != nil {
		return nil, err
	}
	if replayed {
		return e.loadResult(c, request.Uid, request.UpdateId, claimed.ActionId, true)
	}

	sources, accountMap, err := e.loadPlanningInput(c, request.Uid, request.UpdateId)
	if err != nil {
		e.failOrganize(c, request, claimed, "source_snapshot_invalid", now)
		return nil, err
	}
	generateId := func() int64 { return e.ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE) }
	plan, err := BuildOrganizePlan(request.Uid, request.UpdateId, sources, accountMap, now, generateId)
	if err != nil {
		e.failOrganize(c, request, claimed, "plan_invalid", now)
		return nil, err
	}
	reviewPlan, err := BuildReviewIssuePlan(request.Uid, request.UpdateId, plan, sources, now, generateId)
	if err != nil {
		e.failOrganize(c, request, claimed, "review_issue_plan_invalid", now)
		return nil, err
	}
	if err = ApplyReviewIssueBlockers(plan, reviewPlan); err != nil {
		e.failOrganize(c, request, claimed, "review_issue_plan_invalid", now)
		return nil, err
	}
	if err = e.persistPlan(c, request, claimed, plan, reviewPlan, now); err != nil {
		persisted, findErr := e.repository.FindActionById(c, request.Uid, claimed.ActionId)
		if findErr == nil && persisted != nil && persisted.Status == ACTION_STATUS_APPLIED {
			return e.loadResult(c, request.Uid, request.UpdateId, persisted.ActionId, true)
		}
		return nil, err
	}
	return e.loadResult(c, request.Uid, request.UpdateId, claimed.ActionId, false)
}

func (e *Engine) claimOrganize(c core.Context, request OrganizeRequest, candidate *FinanceAction, now int64) (*FinanceAction, bool, error) {
	database, err := e.repository.database(request.Uid)
	if err != nil {
		return nil, false, err
	}
	var lastErr error
	for attempt := 0; attempt < maximumPersistenceAttempts; attempt++ {
		var claimed *FinanceAction
		replayed := false
		lastErr = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
			persisted, created, err := tx.CreateOrFindAction(candidate)
			if err != nil {
				return err
			}
			claimed = persisted
			if !created {
				switch persisted.Status {
				case ACTION_STATUS_APPLIED:
					replayed = true
					return nil
				case ACTION_STATUS_APPLYING:
					update, findErr := tx.FindUpdateById(request.UpdateId)
					if findErr != nil {
						return findErr
					}
					if update == nil || update.Status != UPDATE_STATUS_ORGANIZING || update.CurrentActionId == nil || *update.CurrentActionId != persisted.ActionId ||
						update.Version != request.ExpectedUpdateVersion+1 {
						return ErrOrganizeStateConflict
					}
					return nil
				case ACTION_STATUS_FAILED, ACTION_STATUS_ACTION_REQUIRED:
					return ErrOrganizeActionTerminal
				case ACTION_STATUS_READY:
				default:
					return ErrOrganizeStateConflict
				}
			}

			update, err := tx.FindUpdateById(request.UpdateId)
			if err != nil {
				return err
			}
			if update == nil {
				return ErrOrganizeUpdateNotFound
			}
			if update.Version != request.ExpectedUpdateVersion {
				return ErrOrganizeVersionConflict
			}
			if update.Status != UPDATE_STATUS_DRAFT || update.PostedEventCount != 0 {
				return ErrOrganizeStateConflict
			}
			if err = tx.ensureUnpostedPlanReplaceable(request.UpdateId); err != nil {
				return err
			}
			nextUpdate := *update
			nextUpdate.Status = UPDATE_STATUS_ORGANIZING
			nextUpdate.Version = update.Version + 1
			nextUpdate.CurrentActionId = &persisted.ActionId
			nextUpdate.ErrorCode = ""
			nextUpdate.UpdatedUnixTime = now
			updated, err := tx.UpdateUpdateCAS(update.Version, &nextUpdate)
			if err != nil {
				return err
			}
			if !updated {
				return ErrOrganizeVersionConflict
			}
			nextAction := *persisted
			nextAction.Status = ACTION_STATUS_APPLYING
			nextAction.StartedUnixTime = &now
			nextAction.UpdatedUnixTime = now
			updated, err = tx.UpdateActionCAS(ACTION_STATUS_READY, &nextAction)
			if err != nil {
				return err
			}
			if !updated {
				return ErrOrganizeStateConflict
			}
			claimed = &nextAction
			return nil
		})
		if lastErr == nil {
			return claimed, replayed, nil
		}
		if attempt+1 == maximumPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), lastErr) {
			return nil, false, lastErr
		}
		if err = waitPersistenceRetry(c, initialPersistenceRetryInterval<<attempt); err != nil {
			return nil, false, err
		}
	}
	return nil, false, lastErr
}

func (e *Engine) loadPlanningInput(c core.Context, uid int64, updateId int64) ([]*PlanningSource, map[int64]*models.Account, error) {
	sources, err := e.repository.ListSources(c, uid, updateId)
	if err != nil {
		return nil, nil, err
	}
	if len(sources) < 1 {
		return nil, nil, fmt.Errorf("finance update has no sources")
	}
	planningSources := make([]*PlanningSource, 0, len(sources))
	accountIds := make(map[int64]struct{})
	mappingsBySource := make(map[importing.SourceType]map[string]int64)
	for _, source := range sources {
		batch, findErr := e.evidence.FindImportBatchById(c, uid, source.BatchId)
		if findErr != nil {
			return nil, nil, findErr
		}
		if batch == nil {
			return nil, nil, fmt.Errorf("organizer source batch is missing")
		}
		if batch.Uid != uid || batch.BatchId != source.BatchId || batch.FileId != source.FileId ||
			batch.SourceTypeSnapshot != importing.SourceType(source.SourceTypeSnapshot) ||
			batch.ParserVersion != importing.RuleVersion(source.ParserVersion) ||
			batch.NormalizationVersion != importing.RuleVersion(source.NormalizationVersion) ||
			batch.IdentityKeyVersion != importing.RuleVersion(source.IdentityKeyVersion) {
			return nil, nil, fmt.Errorf("organizer source snapshot mismatch")
		}
		rows, listErr := e.evidence.ListRawImportRows(c, uid, source.BatchId)
		if listErr != nil {
			return nil, nil, listErr
		}
		sourceType := importing.SourceType(source.SourceTypeSnapshot)
		mappingIndex := mappingsBySource[sourceType]
		if mappingIndex == nil && e.mappings != nil {
			mappings, mappingErr := e.mappings.ListPaymentAccountMappings(c, uid, sourceType)
			if mappingErr != nil {
				return nil, nil, mappingErr
			}
			mappingIndex = indexPaymentAccountMappings(mappings)
			mappingsBySource[sourceType] = mappingIndex
		}
		if mappingIndex == nil {
			mappingIndex = map[string]int64{}
		}
		movements := make(map[int64]*PlanningFundsMovement)
		for _, row := range rows {
			if row != nil && row.LedgerAccountId != nil && *row.LedgerAccountId > 0 {
				accountIds[*row.LedgerAccountId] = struct{}{}
			}
			if row == nil {
				continue
			}
			projection, projected := e.projector.ProjectSourceFunds(sourceType, row)
			if !projected {
				continue
			}
			movement := resolvePlanningFundsMovement(row, batch, projection, mappingIndex)
			movements[row.RowId] = movement
			for _, accountId := range []*int64{movement.FromLedgerAccountId, movement.ToLedgerAccountId} {
				if accountId != nil && *accountId > 0 {
					accountIds[*accountId] = struct{}{}
				}
			}
		}
		planningSources = append(planningSources, &PlanningSource{Source: source, Batch: batch, Rows: rows, FundsMovements: movements})
	}
	ids := make([]int64, 0, len(accountIds))
	for accountId := range accountIds {
		ids = append(ids, accountId)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	accounts := make(map[int64]*models.Account)
	if len(ids) > 0 {
		accounts, err = e.accounts.GetAccountsByAccountIds(c, uid, ids)
		if err != nil {
			return nil, nil, err
		}
	}
	return planningSources, accounts, nil
}

func indexPaymentAccountMappings(mappings []*importing.PaymentAccountMapping) map[string]int64 {
	result := make(map[string]int64, len(mappings))
	for _, mapping := range mappings {
		if mapping == nil || mapping.Currency == "" || mapping.AliasKey == "" || mapping.LedgerAccountId < 1 ||
			mapping.AliasKeyVersion != importing.PAYMENT_ACCOUNT_ALIAS_VERSION_V1 {
			continue
		}
		result[mapping.Currency+"\x00"+mapping.AliasKey] = mapping.LedgerAccountId
	}
	return result
}

func resolvePlanningFundsMovement(row *importing.RawImportRow, batch *importing.ImportBatch, projection importing.SourceFundsProjection, mappings map[string]int64) *PlanningFundsMovement {
	return &PlanningFundsMovement{
		Kind:                projection.Kind,
		FromLedgerAccountId: resolveFundsAccountReference(row, batch, projection.From, mappings),
		ToLedgerAccountId:   resolveFundsAccountReference(row, batch, projection.To, mappings),
		RuleVersion:         projection.RuleVersion,
	}
}

func resolveFundsAccountReference(row *importing.RawImportRow, batch *importing.ImportBatch, reference importing.SourceFundsAccountReference, mappings map[string]int64) *int64 {
	switch reference.Kind {
	case importing.SOURCE_FUNDS_ACCOUNT_STATEMENT:
		return cloneInt64Pointer(batch.LedgerAccountId)
	case importing.SOURCE_FUNDS_ACCOUNT_PAYMENT:
		alias, ok := importing.BuildPaymentAccountAlias(reference.Raw)
		if !ok {
			return nil
		}
		if row.LedgerAccountId != nil {
			rowAlias, rowAliasOK := importing.BuildPaymentAccountAlias(row.RawPaymentMethod)
			if rowAliasOK && rowAlias.Key == alias.Key {
				return cloneInt64Pointer(row.LedgerAccountId)
			}
		}
		accountId := mappings[row.Currency+"\x00"+alias.Key]
		if accountId < 1 {
			return nil
		}
		return &accountId
	default:
		return nil
	}
}

func (e *Engine) persistPlan(c core.Context, request OrganizeRequest, action *FinanceAction, plan *OrganizePlan, reviewPlan *ReviewIssuePlan, now int64) error {
	if plan == nil || reviewPlan == nil {
		return ErrOrganizeRequestInvalid
	}
	database, err := e.repository.database(request.Uid)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < maximumPersistenceAttempts; attempt++ {
		lastErr = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
			currentAction, err := tx.FindActionById(action.ActionId)
			if err != nil {
				return err
			}
			if currentAction == nil || currentAction.Status != ACTION_STATUS_APPLYING {
				return ErrOrganizeStateConflict
			}
			update, err := tx.FindUpdateById(request.UpdateId)
			if err != nil {
				return err
			}
			if update == nil || update.Status != UPDATE_STATUS_ORGANIZING || update.Version != request.ExpectedUpdateVersion+1 ||
				update.CurrentActionId == nil || *update.CurrentActionId != action.ActionId {
				return ErrOrganizeStateConflict
			}
			count, err := tx.CountEvents(request.UpdateId)
			if err != nil {
				return err
			}
			if err = tx.ReplaceReviewIssues(request.UpdateId); err != nil {
				return err
			}
			if count != 0 {
				if err = tx.ReplaceUnpostedPlan(request.UpdateId); err != nil {
					return err
				}
			}
			for _, event := range plan.Events {
				if err = tx.InsertEvent(event); err != nil {
					return err
				}
			}
			for _, evidence := range plan.Evidence {
				if err = tx.InsertEvidence(evidence); err != nil {
					return err
				}
			}
			for _, relation := range plan.Relations {
				if err = tx.InsertRelation(relation); err != nil {
					return err
				}
			}
			for _, issue := range reviewPlan.Issues {
				if err = tx.InsertReviewIssue(issue); err != nil {
					return err
				}
			}
			for _, member := range reviewPlan.Members {
				if err = tx.InsertReviewIssueMember(member); err != nil {
					return err
				}
			}

			nextUpdate := *update
			nextUpdate.Status = UPDATE_STATUS_REVIEW
			nextUpdate.Version = update.Version + 1
			nextUpdate.PlanVersion = PLAN_VERSION_V2
			nextUpdate.SourceCount = plan.SourceCount
			nextUpdate.ValidEvidenceCount = plan.ValidEvidenceCount
			nextUpdate.DuplicateEvidenceCount = plan.DuplicateEvidenceCount
			nextUpdate.FinalEventCount = plan.FinalEventCount
			nextUpdate.PostedEventCount = 0
			nextUpdate.ReadyEventCount = plan.ReadyEventCount
			nextUpdate.NeedsActionEventCount = plan.NeedsActionEventCount
			nextUpdate.ExcludedEventCount = plan.ExcludedEventCount
			nextUpdate.ErrorCode = ""
			nextUpdate.UpdatedUnixTime = now
			updated, err := tx.UpdateUpdateCAS(update.Version, &nextUpdate)
			if err != nil {
				return err
			}
			if !updated {
				return ErrOrganizeVersionConflict
			}
			nextAction := *currentAction
			nextAction.Status = ACTION_STATUS_APPLIED
			nextAction.AppliedUpdateVersion = nextUpdate.Version
			nextAction.CompletedUnixTime = &now
			nextAction.UpdatedUnixTime = now
			updated, err = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &nextAction)
			if err != nil {
				return err
			}
			if !updated {
				return ErrOrganizeStateConflict
			}
			return nil
		})
		if lastErr == nil {
			return nil
		}
		if attempt+1 == maximumPersistenceAttempts || !isRetryablePersistenceError(database.DatabaseType(), lastErr) {
			return lastErr
		}
		if err = waitPersistenceRetry(c, initialPersistenceRetryInterval<<attempt); err != nil {
			return err
		}
	}
	return lastErr
}

func (e *Engine) failOrganize(c core.Context, request OrganizeRequest, action *FinanceAction, errorCode string, now int64) {
	if action == nil || errorCode == "" {
		return
	}
	_ = e.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		currentAction, err := tx.FindActionById(action.ActionId)
		if err != nil || currentAction == nil || currentAction.Status != ACTION_STATUS_APPLYING {
			return err
		}
		update, err := tx.FindUpdateById(request.UpdateId)
		if err != nil || update == nil || update.Status != UPDATE_STATUS_ORGANIZING || update.CurrentActionId == nil || *update.CurrentActionId != action.ActionId {
			return err
		}
		nextUpdate := *update
		nextUpdate.Status = UPDATE_STATUS_FAILED
		nextUpdate.Version = update.Version + 1
		nextUpdate.ErrorCode = errorCode
		nextUpdate.UpdatedUnixTime = now
		updated, err := tx.UpdateUpdateCAS(update.Version, &nextUpdate)
		if err != nil || !updated {
			return err
		}
		nextAction := *currentAction
		nextAction.Status = ACTION_STATUS_FAILED
		nextAction.ErrorCode = errorCode
		nextAction.FailedUnixTime = &now
		nextAction.UpdatedUnixTime = now
		_, err = tx.UpdateActionCAS(ACTION_STATUS_APPLYING, &nextAction)
		return err
	})
}

func (e *Engine) loadResult(c core.Context, uid int64, updateId int64, actionId int64, replayed bool) (*OrganizeResult, error) {
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
	relations := make([]*EconomicEventRelation, 0)
	seenRelations := make(map[int64]struct{})
	for _, event := range events {
		items, listErr := e.repository.ListRelations(c, uid, event.EventId)
		if listErr != nil {
			return nil, listErr
		}
		for _, relation := range items {
			if _, exists := seenRelations[relation.RelationId]; exists {
				continue
			}
			seenRelations[relation.RelationId] = struct{}{}
			relations = append(relations, relation)
		}
	}
	sort.Slice(relations, func(i, j int) bool { return relations[i].RelationId < relations[j].RelationId })
	issues, err := e.repository.ListReviewIssues(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	members := make([]*ReviewIssueMember, 0)
	if len(issues) > 0 {
		issueIds := make([]int64, len(issues))
		for index, issue := range issues {
			issueIds[index] = issue.IssueId
		}
		members, err = e.repository.ListReviewIssueMembersForIssues(c, uid, issueIds)
		if err != nil {
			return nil, err
		}
	}
	return &OrganizeResult{
		Update: update, Action: action, Events: events, Relations: relations,
		Issues: issues, IssueMembers: members, Replayed: replayed,
	}, nil
}

func newOrganizeAction(request OrganizeRequest, actionId int64, now int64) *FinanceAction {
	idempotencyDigest := digestOrganizeValue(string(ACTION_IDEMPOTENCY_VERSION_V1), strconv.FormatInt(request.Uid, 10), strings.TrimSpace(request.IdempotencyKey))
	requestDigest := digestOrganizeValue(string(ACTION_REQUEST_VERSION_V1), strconv.FormatInt(request.Uid, 10), strconv.FormatInt(request.UpdateId, 10), strconv.FormatInt(request.ExpectedUpdateVersion, 10), string(ACTION_TYPE_ORGANIZE))
	return &FinanceAction{
		Uid: request.Uid, UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion,
		ActionType: ACTION_TYPE_ORGANIZE, IdempotencyKeyDigest: idempotencyDigest,
		IdempotencyKeyVersion: ACTION_IDEMPOTENCY_VERSION_V1, RequestDigest: requestDigest,
		RequestDigestVersion: ACTION_REQUEST_VERSION_V1, Status: ACTION_STATUS_READY,
		ReasonCodesJson: "[]", CreatedUnixTime: now, UpdatedUnixTime: now, ActionId: actionId,
	}
}

func digestOrganizeValue(parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}
