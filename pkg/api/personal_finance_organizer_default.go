package api

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gaohongxiang/catledger/pkg/converters"
	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

type personalFinanceOrganizerApplication struct {
	repository      *organizer.Repository
	evidence        *importing.Repository
	paymentAccounts *importing.PaymentAccountService
	installments    personalFinanceInstallmentCoordinator
	accountMappings *personalFinanceReviewAccountMappingCoordinator
	create          *organizer.CreateEngine
	organize        *organizer.Engine
	abandon         *organizer.AbandonEngine
	posting         *organizer.PostingEngine
	correction      *organizer.CorrectionEngine
	undo            *organizer.UndoEngine
	rebuild         *organizer.RebuildEngine
}

func InitializePersonalFinanceOrganizerApi() error {
	store := datastore.Container.UserDataStore
	repository, err := organizer.NewRepository(store)
	if err != nil {
		return err
	}
	evidence, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	generateId := func() int64 {
		return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	}
	sourceAccounts, err := importing.NewSourceAccountService(evidence, generateId)
	if err != nil {
		return err
	}
	paymentAccounts, err := importing.NewPaymentAccountService(evidence, generateId)
	if err != nil {
		return err
	}
	create, err := organizer.NewCreateEngine(repository, evidence, uuid.Container)
	if err != nil {
		return err
	}
	engine, err := organizer.NewEngine(repository, evidence, services.Accounts, converters.NewSourceFundsProjector(), uuid.Container, services.TransactionCategories)
	if err != nil {
		return err
	}
	abandon, err := organizer.NewAbandonEngine(repository, uuid.Container)
	if err != nil {
		return err
	}
	posting, err := organizer.NewPostingEngine(repository, services.Transactions, uuid.Container)
	if err != nil {
		return err
	}
	correction, err := organizer.NewCorrectionEngine(repository, uuid.Container, evidence)
	if err != nil {
		return err
	}
	undo, err := organizer.NewUndoEngine(repository, services.Transactions, uuid.Container)
	if err != nil {
		return err
	}
	rebuild, err := organizer.NewRebuildEngine(repository, services.Transactions, uuid.Container, evidence)
	if err != nil {
		return err
	}
	application := &personalFinanceOrganizerApplication{
		repository: repository, evidence: evidence, paymentAccounts: paymentAccounts,
		accountMappings: &personalFinanceReviewAccountMappingCoordinator{
			repository: repository, evidence: evidence, accounts: services.Accounts,
			sourceAccounts: sourceAccounts, paymentAccounts: paymentAccounts,
		},
		create: create, organize: engine, abandon: abandon,
		posting: posting, correction: correction, undo: undo, rebuild: rebuild,
	}
	if PersonalFinanceInstallments != nil {
		application.installments, _ = PersonalFinanceInstallments.application.(personalFinanceInstallmentCoordinator)
	}
	PersonalFinanceOrganizer, err = NewPersonalFinanceOrganizerApi(application)
	return err
}

func (a *personalFinanceOrganizerApplication) CreateUpdate(c core.Context, uid int64, batchIds []int64, idempotencyKey string) (*organizerUpdateDetail, error) {
	result, err := a.create.Create(c, organizer.CreateUpdateRequest{Uid: uid, BatchIds: batchIds, IdempotencyKey: idempotencyKey})
	if err != nil {
		return nil, err
	}
	return &organizerUpdateDetail{Update: result.Update, Sources: result.Sources}, nil
}

func (a *personalFinanceOrganizerApplication) ListUpdates(c core.Context, uid int64, status organizer.UpdateStatus, cursor *organizer.UpdateCursor, limit int) (*organizer.UpdatePage, error) {
	return a.repository.ListUpdates(c, uid, status, cursor, limit)
}

func (a *personalFinanceOrganizerApplication) GetUpdate(c core.Context, uid int64, updateId int64) (*organizerUpdateDetail, error) {
	update, err := a.repository.FindUpdateById(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	if update == nil {
		return nil, organizer.ErrOrganizeUpdateNotFound
	}
	if update.Status == organizer.UPDATE_STATUS_POSTED {
		a.promotePostedInstallments(c, uid, updateId)
	}
	sources, err := a.repository.ListSources(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	return &organizerUpdateDetail{Update: update, Sources: sources}, nil
}

func (a *personalFinanceOrganizerApplication) Organize(c core.Context, request organizer.OrganizeRequest) (*organizer.OrganizeResult, error) {
	update, err := a.repository.FindUpdateById(c, request.Uid, request.UpdateId)
	if err != nil {
		return nil, err
	}
	if update != nil && update.Status == organizer.UPDATE_STATUS_DRAFT && update.PostedEventCount == 0 {
		// 事件计划冻结前再次同步长期忽略策略，保证非 Web 入口也不会绕过账户政策。
		sources, listErr := a.repository.ListSources(c, request.Uid, request.UpdateId)
		if listErr != nil {
			return nil, listErr
		}
		batchIds := make([]int64, 0, len(sources))
		for _, source := range sources {
			if source == nil {
				continue
			}
			if applyErr := a.paymentAccounts.ApplyPersistedExclusions(c, request.Uid, source.BatchId); applyErr != nil {
				return nil, applyErr
			}
			batchIds = append(batchIds, source.BatchId)
		}
		// 分期候选是由不可变证据重建的派生数据；整理前先交给现有贷款/分期模块采集，
		// 不在 organizer 内复制合同或现金流计算逻辑。
		if a.installments != nil && len(batchIds) > 0 {
			if _, ingestErr := a.installments.IngestBatches(c, installments.IngestRequest{Uid: request.Uid, BatchIds: batchIds}); ingestErr != nil {
				return nil, ingestErr
			}
		}
	}
	result, err := a.organize.Organize(c, request)
	if err != nil {
		return nil, err
	}
	return a.autoResolveKnownInstallments(c, request.Uid, result)
}

// autoResolveKnownInstallments 只复用已由稳定候选身份关联或创建的正式分期。
// 它不使用金额、日期、卡号或期次近似，因此没有唯一既有关系时仍交给用户新建。
func (a *personalFinanceOrganizerApplication) autoResolveKnownInstallments(c core.Context, uid int64, result *organizer.OrganizeResult) (*organizer.OrganizeResult, error) {
	if a == nil || a.installments == nil || result == nil || result.Update == nil || uid < 1 {
		return result, nil
	}
	issueEvents := make(map[int64][]int64)
	for _, member := range result.IssueMembers {
		if member != nil && member.Role == organizer.REVIEW_ISSUE_MEMBER_ROLE_SUBJECT && member.ObjectType == organizer.REVIEW_OBJECT_TYPE_EVENT {
			issueEvents[member.IssueId] = append(issueEvents[member.IssueId], member.ObjectId)
		}
	}
	currentVersion := result.Update.Version
	for _, issue := range result.Issues {
		if issue == nil || issue.Status != organizer.REVIEW_ISSUE_STATUS_OPEN || issue.IssueType != organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN {
			continue
		}
		eventIds := issueEvents[issue.IssueId]
		if len(eventIds) < 1 {
			continue
		}
		links, err := a.repository.ListEvidenceForEvents(c, uid, eventIds)
		if err != nil {
			return nil, err
		}
		rowIds := make([]int64, 0, len(links))
		for _, link := range links {
			if link != nil {
				rowIds = append(rowIds, link.RowId)
			}
		}
		if len(rowIds) < 1 {
			continue
		}
		candidates, err := a.installments.FindCandidatesByRawRows(c, uid, rowIds)
		if err != nil {
			return nil, err
		}
		known := uniqueKnownInstallmentCandidate(candidates)
		if known == nil {
			continue
		}
		resolved, err := a.ResolveReviewIssue(c, organizer.ResolveReviewIssueRequest{
			Uid: uid, UpdateId: result.Update.UpdateId, IssueId: issue.IssueId,
			ExpectedUpdateVersion: currentVersion, ExpectedIssueVersion: issue.Version,
			IdempotencyKey:         "auto-installment-existing:" + strconv.FormatInt(result.Update.UpdateId, 10) + ":" + strconv.FormatInt(issue.IssueId, 10),
			Decision:               organizer.REVIEW_ISSUE_DECISION_CONFIRM_INSTALLMENT_PRINCIPAL,
			InstallmentCandidateId: known.CandidateId,
		})
		if err != nil {
			return nil, err
		}
		if resolved != nil && resolved.Update != nil {
			result.Update = resolved.Update
			currentVersion = resolved.Update.Version
		}
	}
	if currentVersion != result.Update.Version {
		result.Update.Version = currentVersion
	}
	events, err := a.repository.ListEvents(c, uid, result.Update.UpdateId)
	if err != nil {
		return nil, err
	}
	result.Events = events
	return result, nil
}

func uniqueKnownInstallmentCandidate(candidates []*installments.CandidateView) *installments.CandidateView {
	var known *installments.CandidateView
	for _, candidate := range candidates {
		if candidate == nil || (candidate.Status != installments.CANDIDATE_STATUS_LINKED && candidate.Status != installments.CANDIDATE_STATUS_CONVERTED) {
			continue
		}
		if known != nil && known.CandidateId != candidate.CandidateId {
			return nil
		}
		known = candidate
	}
	return known
}

func (a *personalFinanceOrganizerApplication) Abandon(c core.Context, request organizer.AbandonRequest) (*organizer.AbandonResult, error) {
	result, err := a.abandon.Abandon(c, request)
	if err != nil {
		return nil, err
	}
	// 放弃轮次后只清除该轮次已经填写但尚未生效的分期表单；
	// 候选、原始证据、人工决定和正式合同均保持不变。
	a.discardInstallmentDrafts(c, request.Uid, request.UpdateId)
	return result, nil
}

func (a *personalFinanceOrganizerApplication) ListEvents(c core.Context, uid int64, updateId int64, status organizer.EventStatus, cursor *organizer.EventCursor, limit int) (*organizerEventPage, error) {
	update, err := a.repository.FindUpdateById(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	if update == nil {
		return nil, organizer.ErrOrganizeUpdateNotFound
	}
	page, err := a.repository.ListEventsPage(c, uid, updateId, status, cursor, limit)
	if err != nil {
		return nil, err
	}
	result := &organizerEventPage{Items: make([]*organizerEventListItem, 0, len(page.Items)), NextCursor: page.NextCursor}
	if len(page.Items) < 1 {
		return result, nil
	}
	eventIds := make([]int64, 0, len(page.Items))
	for _, event := range page.Items {
		if event != nil {
			eventIds = append(eventIds, event.EventId)
		}
	}
	if len(eventIds) < 1 {
		return result, nil
	}
	evidence, err := a.repository.ListEvidenceForEvents(c, uid, eventIds)
	if err != nil {
		return nil, err
	}
	rowIds := make([]int64, 0, len(evidence))
	for _, link := range evidence {
		if link != nil {
			rowIds = append(rowIds, link.RowId)
		}
	}
	rows := make([]*importing.RawImportRow, 0)
	if len(rowIds) > 0 {
		rows, err = a.evidence.FindRawImportRowsByIds(c, uid, rowIds)
		if err != nil {
			return nil, err
		}
	}
	rowsById := make(map[int64]*importing.RawImportRow, len(rows))
	for _, row := range rows {
		if row != nil {
			rowsById[row.RowId] = row
		}
	}
	summaries := make(map[int64]*organizerEventSummary, len(page.Items))
	selectedRoles := make(map[int64]organizer.EvidenceRole, len(page.Items))
	for _, link := range evidence {
		if link == nil {
			continue
		}
		summary := summaries[link.EventId]
		if summary == nil {
			summary = &organizerEventSummary{}
			summaries[link.EventId] = summary
		}
		summary.EvidenceCount++
		row := rowsById[link.RowId]
		selectedRole, selected := selectedRoles[link.EventId]
		if row == nil || (selected && (selectedRole == organizer.EVIDENCE_ROLE_PRIMARY || link.EvidenceRole != organizer.EVIDENCE_ROLE_PRIMARY)) {
			continue
		}
		selectedRoles[link.EventId] = link.EvidenceRole
		summary.Counterparty = row.RawCounterparty
		summary.Item = row.RawItem
		summary.PaymentMethod = row.RawPaymentMethod
		summary.Note = row.RawNote
	}
	for _, event := range page.Items {
		if event == nil {
			continue
		}
		item := &organizerEventListItem{Event: event}
		if summary := summaries[event.EventId]; summary != nil {
			item.Summary = *summary
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func (a *personalFinanceOrganizerApplication) GetEventEvidence(c core.Context, uid int64, eventId int64) (*organizerEventEvidenceDetail, error) {
	event, err := a.repository.FindEventById(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	if event == nil {
		return nil, organizer.ErrCorrectionEventConflict
	}
	evidence, err := a.repository.ListEvidence(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	rows := make([]*importing.RawImportRow, 0, len(evidence))
	for _, link := range evidence {
		if link == nil {
			continue
		}
		row, rowErr := a.evidence.FindRawImportRowById(c, uid, link.RowId)
		if rowErr != nil {
			return nil, rowErr
		}
		if row == nil {
			return nil, organizer.ErrCorrectionEventConflict
		}
		rows = append(rows, row)
	}
	relations, err := a.repository.ListRelations(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	links, err := a.repository.ListEventTransactions(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	return &organizerEventEvidenceDetail{Event: event, Evidence: evidence, Rows: rows, Relations: relations, Links: links}, nil
}

func (a *personalFinanceOrganizerApplication) InspectEventCorrection(c core.Context, uid int64, updateId int64, eventId int64) (*organizer.UndoImpact, error) {
	event, err := a.repository.FindEventById(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	if event == nil || event.UpdateId != updateId {
		return nil, organizer.ErrCorrectionEventConflict
	}
	if event.Status != organizer.EVENT_STATUS_POSTED {
		return &organizer.UndoImpact{CanUndo: true, ReasonCodes: []string{}}, nil
	}
	return a.rebuild.Inspect(c, uid, updateId, eventId)
}

func (a *personalFinanceOrganizerApplication) InspectCategoryCorrectionScope(c core.Context, uid int64, updateId int64, eventId int64) (*organizer.CategoryCorrectionScopePreview, error) {
	return a.correction.InspectCategoryCorrectionScope(c, uid, updateId, eventId)
}

func (a *personalFinanceOrganizerApplication) CorrectEvent(c core.Context, request organizer.CorrectEventRequest) (*organizerMutationResult, error) {
	event, err := a.repository.FindEventById(c, request.Uid, request.EventId)
	if err != nil {
		return nil, err
	}
	if event == nil || event.UpdateId != request.UpdateId {
		return nil, organizer.ErrCorrectionEventConflict
	}
	if event.Status == organizer.EVENT_STATUS_POSTED {
		if request.CategoryScope != "" && request.CategoryScope != organizer.CATEGORY_CORRECTION_SCOPE_SINGLE {
			return nil, organizer.ErrCorrectionRequestInvalid
		}
		result, rebuildErr := a.rebuild.Rebuild(c, request)
		if rebuildErr != nil && !errors.Is(rebuildErr, organizer.ErrRebuildActionRequired) {
			return nil, rebuildErr
		}
		if result == nil {
			return nil, rebuildErr
		}
		return &organizerMutationResult{Update: result.Update, Event: result.Event, Action: result.Action, Impact: result.Impact, Replayed: result.Replayed}, rebuildErr
	}
	result, err := a.correction.Correct(c, request)
	if err != nil {
		return nil, err
	}
	return &organizerMutationResult{Update: result.Update, Event: result.Event, Events: result.Events, Action: result.Action, Replayed: result.Replayed}, nil
}

func (a *personalFinanceOrganizerApplication) Post(c core.Context, request organizer.PostRequest) (*organizer.PostResult, error) {
	result, err := a.posting.Post(c, request)
	if err != nil {
		return nil, err
	}
	// 正式账本原子入账已经成功后，再让持久化的分期决定生效为正式合同或待完善候选。
	// 投影失败不能把已成功的正式入账伪装成失败；GetUpdate 与幂等重放会继续补偿。
	a.promotePostedInstallments(c, request.Uid, request.UpdateId)
	return result, nil
}

func (a *personalFinanceOrganizerApplication) validateInstallmentPrincipalDecision(c core.Context, request organizer.ResolveReviewIssueRequest) error {
	if a == nil || a.installments == nil || request.InstallmentCandidateId < 1 {
		return organizer.ErrReviewIssueDecisionInvalid
	}
	detail, err := a.GetReviewIssue(c, request.Uid, request.IssueId)
	if err != nil || detail == nil || detail.Issue == nil || detail.Issue.UpdateId != request.UpdateId ||
		detail.Issue.IssueType != organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN {
		return organizer.ErrReviewIssueDecisionInvalid
	}
	candidate, err := a.installments.GetCandidate(c, request.Uid, request.InstallmentCandidateId)
	if err != nil || candidate == nil || (candidate.Status != installments.CANDIDATE_STATUS_PENDING &&
		candidate.Status != installments.CANDIDATE_STATUS_LINKED && candidate.Status != installments.CANDIDATE_STATUS_CONVERTED) {
		return organizer.ErrReviewIssueDecisionInvalid
	}
	eventIds := make([]int64, 0, len(detail.Events))
	for _, event := range detail.Events {
		if event != nil {
			eventIds = append(eventIds, event.EventId)
		}
	}
	links, err := a.repository.ListEvidenceForEvents(c, request.Uid, eventIds)
	if err != nil {
		return err
	}
	rows := make(map[int64]struct{}, len(links))
	for _, link := range links {
		if link != nil {
			rows[link.RowId] = struct{}{}
		}
	}
	for _, member := range candidate.Members {
		if member != nil && member.MemberKind == installments.MEMBER_KIND_RAW_ROW {
			if _, exists := rows[member.MemberRefId]; exists {
				return nil
			}
		}
	}
	return organizer.ErrReviewIssueDecisionInvalid
}

func (a *personalFinanceOrganizerApplication) installmentCandidateIdsFromDecisions(c core.Context, uid int64, updateId int64) []int64 {
	if a == nil || a.installments == nil || uid < 1 || updateId < 1 {
		return nil
	}
	issues, err := a.repository.ListReviewIssues(c, uid, updateId)
	if err != nil {
		log.Warnf(c, "[personal_finance_installments.decisions] failed to load review decisions for user \"uid:%d\"", uid)
		return nil
	}
	ids := make([]int64, 0)
	seen := make(map[int64]struct{})
	for _, issue := range issues {
		if issue == nil || issue.Status != organizer.REVIEW_ISSUE_STATUS_RESOLVED ||
			issue.IssueType != organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN || issue.ResolvedActionId == nil {
			continue
		}
		action, findErr := a.repository.FindActionById(c, uid, *issue.ResolvedActionId)
		if findErr != nil || action == nil || action.Status != organizer.ACTION_STATUS_APPLIED {
			continue
		}
		var reasons []string
		if json.Unmarshal([]byte(action.ReasonCodesJson), &reasons) != nil {
			continue
		}
		for _, reason := range reasons {
			const prefix = "installment_candidate:"
			if !strings.HasPrefix(reason, prefix) {
				continue
			}
			id, parseErr := strconv.ParseInt(strings.TrimPrefix(reason, prefix), 10, 64)
			if parseErr == nil && id > 0 {
				if _, exists := seen[id]; !exists {
					seen[id] = struct{}{}
					ids = append(ids, id)
				}
			}
		}
	}
	return ids
}

func (a *personalFinanceOrganizerApplication) promotePostedInstallments(c core.Context, uid int64, updateId int64) {
	ids := a.installmentCandidateIdsFromDecisions(c, uid, updateId)
	if len(ids) > 0 {
		if err := a.installments.PromoteAfterPosting(c, installments.PromoteRequest{Uid: uid, CandidateIds: ids}); err != nil {
			log.Warnf(c, "[personal_finance_installments.promote] deferred for user \"uid:%d\" and update \"id:%d\"", uid, updateId)
		}
	}
}

func (a *personalFinanceOrganizerApplication) discardInstallmentDrafts(c core.Context, uid int64, updateId int64) {
	if a == nil || a.installments == nil || uid < 1 || updateId < 1 {
		return
	}
	issues, err := a.repository.ListReviewIssues(c, uid, updateId)
	if err != nil {
		log.Warnf(c, "[personal_finance_installments.discard] failed to load issues for user \"uid:%d\" and update \"id:%d\"", uid, updateId)
		return
	}
	rowSet := make(map[int64]struct{})
	for _, issue := range issues {
		if issue == nil || issue.IssueType != organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN {
			continue
		}
		detail, detailErr := a.GetReviewIssue(c, uid, issue.IssueId)
		if detailErr != nil || detail == nil {
			continue
		}
		eventIds := make([]int64, 0, len(detail.Events))
		for _, event := range detail.Events {
			if event != nil {
				eventIds = append(eventIds, event.EventId)
			}
		}
		links, linkErr := a.repository.ListEvidenceForEvents(c, uid, eventIds)
		if linkErr != nil {
			continue
		}
		for _, link := range links {
			if link != nil {
				rowSet[link.RowId] = struct{}{}
			}
		}
	}
	rowIds := make([]int64, 0, len(rowSet))
	for rowId := range rowSet {
		rowIds = append(rowIds, rowId)
	}
	if len(rowIds) < 1 {
		return
	}
	candidates, err := a.installments.FindCandidatesByRawRows(c, uid, rowIds)
	if err != nil {
		log.Warnf(c, "[personal_finance_installments.discard] failed to load candidates for user \"uid:%d\" and update \"id:%d\"", uid, updateId)
		return
	}
	ids := make([]int64, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != nil && candidate.CandidateId > 0 {
			ids = append(ids, candidate.CandidateId)
		}
	}
	if len(ids) > 0 {
		if err = a.installments.DiscardContractDrafts(c, uid, ids); err != nil {
			log.Warnf(c, "[personal_finance_installments.discard] failed for user \"uid:%d\" and update \"id:%d\"", uid, updateId)
		}
	}
}

func (a *personalFinanceOrganizerApplication) InspectUndo(c core.Context, uid int64, updateId int64) (*organizer.UndoImpact, error) {
	return a.undo.Inspect(c, uid, updateId)
}

func (a *personalFinanceOrganizerApplication) Undo(c core.Context, request organizer.UndoRequest) (*organizer.UndoResult, error) {
	return a.undo.Undo(c, request)
}
