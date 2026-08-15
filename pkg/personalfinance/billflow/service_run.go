package billflow

import (
	"strconv"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

type RunTaskRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	IdempotencyKey  string
	CreatedIp       string
}

func (s *Service) RunTask(c core.Context, request RunTaskRequest, clientTimezone *time.Location) (*TaskView, error) {
	return s.organize(c, request, clientTimezone, false)
}

func (s *Service) ConfirmPost(c core.Context, request RunTaskRequest, clientTimezone *time.Location) (*TaskView, error) {
	return s.organize(c, request, clientTimezone, true)
}

func (s *Service) organize(c core.Context, request RunTaskRequest, clientTimezone *time.Location, confirmPost bool) (*TaskView, error) {
	if s == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	actionType := ACTION_TYPE_RUN_ORGANIZE
	if confirmPost {
		actionType = ACTION_TYPE_CONFIRM_POST
		if task.Status != TASK_STATUS_AWAITING_CONFIRM {
			return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
		}
	} else if task.Status != TASK_STATUS_RECEIVING {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	action, created, err := s.beginAction(c, request.Uid, request.TaskId, request.ExpectedVersion, actionType, request.IdempotencyKey, []string{
		string(actionType), strconv.FormatInt(request.TaskId, 10),
	})
	if err != nil {
		return nil, err
	}
	if !created {
		if action.Status == ACTION_STATUS_APPLIED {
			return s.GetTask(c, request.Uid, request.TaskId)
		}
		if action.Status != ACTION_STATUS_READY {
			return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
		}
	}
	accounts, err := s.collectAccounts(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if !confirmPost && len(accounts.NeedsCreate) > 0 {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}

	members, err := s.repository.ListMembers(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	plan, err := s.buildOrganizePlan(c, request.Uid, request.TaskId, members, createdIP(request.CreatedIp))
	if err != nil {
		return nil, err
	}

	shouldPost := confirmPost || task.ConfirmPolicy == CONFIRM_POLICY_AUTO_POST
	posted := int64(0)
	if shouldPost {
		if s.poster == nil {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if clientTimezone == nil {
			clientTimezone = time.UTC
		}
		for batchId, commands := range plan.commands {
			if len(commands) == 0 {
				continue
			}
			result, postErr := s.poster.PostImportBatch(c, importing.PostImportBatchRequest{
				Uid: request.Uid, BatchId: batchId,
				IdempotencyKey: "billflow-" + strconv.FormatInt(request.TaskId, 10) + "-" + strconv.FormatInt(batchId, 10),
				CreatedIp:      createdIP(request.CreatedIp), Commands: commands,
			}, clientTimezone)
			if postErr != nil {
				return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
			if result != nil && result.Posting != nil {
				posted += result.Posting.CreatedTransactionCount
			}
		}
	}

	nextStatus := TASK_STATUS_READY
	if !shouldPost {
		nextStatus = TASK_STATUS_AWAITING_CONFIRM
	}
	if err := s.persistOrganizeResult(c, request, action, task, plan, posted, nextStatus); err != nil {
		return nil, err
	}
	return s.GetTask(c, request.Uid, request.TaskId)
}

type organizePlan struct {
	commands map[int64][]importing.PostingIdentityCommand
	todos    []Todo
	posted   int64
}

func (s *Service) buildOrganizePlan(c core.Context, uid int64, taskId int64, members []*TaskMember, createdIp string) (*organizePlan, error) {
	plan := &organizePlan{commands: map[int64][]importing.PostingIdentityCommand{}}
	batchIds := make([]int64, 0, len(members))
	rowsByBatch := make(map[int64][]*importing.RawImportRow)
	sourceByBatch := make(map[int64]importing.SourceType)
	for _, member := range members {
		if member == nil {
			continue
		}
		batchIds = append(batchIds, member.BatchId)
		batch, err := s.evidence.FindImportBatchById(c, uid, member.BatchId)
		if err != nil || batch == nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		sourceByBatch[member.BatchId] = batch.SourceTypeSnapshot
		rows, err := s.evidence.ListRawImportRows(c, uid, member.BatchId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		rowsByBatch[member.BatchId] = rows
	}

	ambiguousRows, err := s.autoReconcile(c, uid, taskId, batchIds, rowsByBatch, createdIp)
	if err != nil {
		return nil, err
	}
	if s.installments != nil {
		if _, err := s.installments.IngestBatches(c, installments.IngestRequest{Uid: uid, BatchIds: batchIds}); err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if page, listErr := s.installments.ListCandidates(c, uid, installments.CANDIDATE_STATUS_PENDING, nil, 100); listErr == nil {
			for _, candidate := range page.Items {
				if candidate == nil {
					continue
				}
				plan.todos = append(plan.todos, Todo{
					Uid: uid, TaskId: taskId, TodoKind: TODO_KIND_INSTALLMENT_CANDIDATE, Status: TODO_STATUS_OPEN,
					SubjectKind: SUBJECT_KIND_INSTALLMENT_CANDIDATE, SubjectId: candidate.CandidateId, ReasonCodesJson: "[]",
				})
			}
		}
	}

	categories, err := s.loadCategoryIndex(c, uid, sourceByBatch, rowsByBatch)
	if err != nil {
		return nil, err
	}

	for batchId, rows := range rowsByBatch {
		sourceType := sourceByBatch[batchId]
		grouped := map[int64][]*importing.RawImportRow{}
		for _, row := range rows {
			if row == nil || row.ProcessingState != importing.PROCESSING_STATE_PENDING {
				continue
			}
			todoKind, postable := s.classifyRow(row, sourceType, ambiguousRows[row.RowId], categories)
			if todoKind != "" {
				subjectKind, subjectId := SUBJECT_KIND_RAW_ROW, row.RowId
				if row.IdentityId != nil && (todoKind == TODO_KIND_IDENTITY_CONFLICT || todoKind == TODO_KIND_CORE_FIELD_CONFLICT) {
					subjectKind, subjectId = SUBJECT_KIND_SOURCE_IDENTITY, *row.IdentityId
				}
				reason := []string{}
				if todoKind == TODO_KIND_CROSS_SOURCE_AMBIGUOUS {
					reason = []string{"cross_source_ambiguous"}
				}
				plan.todos = append(plan.todos, Todo{
					Uid: uid, TaskId: taskId, TodoKind: todoKind, Status: TODO_STATUS_OPEN,
					SubjectKind: subjectKind, SubjectId: subjectId, ReasonCodesJson: encodeReasonCodes(reason),
				})
			}
			if !postable || row.IdentityId == nil || *row.IdentityId < 1 || row.LedgerAccountId == nil {
				continue
			}
			grouped[*row.IdentityId] = append(grouped[*row.IdentityId], row)
		}
		for _, group := range grouped {
			command := s.postingCommand(group, sourceType, categories)
			if command != nil {
				plan.commands[batchId] = append(plan.commands[batchId], *command)
				plan.posted++
			}
		}
	}
	return plan, nil
}

func (s *Service) classifyRow(row *importing.RawImportRow, sourceType importing.SourceType, ambiguous bool, categories *categoryIndex) (TodoKind, bool) {
	if row.LedgerAccountId == nil || *row.LedgerAccountId < 1 {
		return TODO_KIND_UNRESOLVED_PAYMENT_ACCOUNT, false
	}
	if row.IdentityState == importing.IDENTITY_STATE_IDENTITY_CONFLICT {
		return TODO_KIND_IDENTITY_CONFLICT, false
	}
	if row.ParseState != importing.PARSE_STATE_VALID || row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_POSTABLE ||
		row.Disposition != importing.IMPORT_DISPOSITION_POSTABLE {
		return "", false
	}
	if row.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL && row.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND {
		return "", false
	}
	if row.IdentityState != importing.IDENTITY_STATE_NEW && row.IdentityState != importing.IDENTITY_STATE_EXACT_DUPLICATE {
		return "", false
	}
	if row.NormalizedUnixTime == nil || row.NormalizedAmount == nil || row.NormalizedDirection == importing.NORMALIZED_DIRECTION_UNKNOWN {
		return TODO_KIND_CORE_FIELD_CONFLICT, false
	}
	if ambiguous {
		return TODO_KIND_CROSS_SOURCE_AMBIGUOUS, false
	}
	switch row.NormalizedTransactionType {
	case importing.SOURCE_TRANSACTION_TYPE_TOP_UP, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL, importing.SOURCE_TRANSACTION_TYPE_TRANSFER:
		return TODO_KIND_TRANSFER_UNCLEAR, false
	}
	if row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND {
		return TODO_KIND_REFUND_UNCLEAR, false
	}
	if row.IdentityState == importing.IDENTITY_STATE_EXACT_DUPLICATE {
		return "", true
	}
	name := sourceCategoryName(row, sourceType)
	if todoKind := transferLikeTodo(name); todoKind != "" {
		return todoKind, false
	}
	if _, mapped := categories.lookup(sourceType, name); !mapped {
		if row.NormalizedDirection == importing.NORMALIZED_DIRECTION_INCOME || row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE {
			return TODO_KIND_UNCATEGORIZED, true
		}
	}
	return "", true
}

func (s *Service) postingCommand(rows []*importing.RawImportRow, sourceType importing.SourceType, categories *categoryIndex) *importing.PostingIdentityCommand {
	if len(rows) == 0 || rows[0].LedgerAccountId == nil || rows[0].NormalizedAmount == nil || rows[0].NormalizedUnixTime == nil {
		return nil
	}
	row := rows[0]
	if row.IdentityState == importing.IDENTITY_STATE_EXACT_DUPLICATE {
		ids := make([]int64, 0, len(rows))
		for _, item := range rows {
			ids = append(ids, item.RowId)
		}
		return &importing.PostingIdentityCommand{RowIds: ids, AutoPosted: true}
	}
	txType := models.TRANSACTION_TYPE_EXPENSE
	if row.NormalizedDirection == importing.NORMALIZED_DIRECTION_INCOME {
		txType = models.TRANSACTION_TYPE_INCOME
	} else if row.NormalizedDirection != importing.NORMALIZED_DIRECTION_EXPENSE {
		return nil
	}
	categoryId := int64(0)
	allowUncategorized := true
	if id, mapped := categories.lookup(sourceType, sourceCategoryName(row, sourceType)); mapped {
		categoryId = id
		allowUncategorized = false
	}
	ids := make([]int64, 0, len(rows))
	for _, item := range rows {
		ids = append(ids, item.RowId)
	}
	offset := int16(0)
	if row.NormalizedTimezoneUtcOffset != nil {
		offset = *row.NormalizedTimezoneUtcOffset
	}
	return &importing.PostingIdentityCommand{
		RowIds: ids, AutoPosted: true,
		Draft: &importing.LedgerTransactionDraft{
			Type: txType, CategoryId: categoryId, AllowUncategorized: allowUncategorized,
			UnixTime: *row.NormalizedUnixTime, TimezoneUtcOffset: offset,
			SourceAccountId: *row.LedgerAccountId, SourceAmount: *row.NormalizedAmount,
		},
	}
}

func (s *Service) autoReconcile(c core.Context, uid int64, taskId int64, batchIds []int64, rowsByBatch map[int64][]*importing.RawImportRow, createdIp string) (map[int64]bool, error) {
	ambiguous := map[int64]bool{}
	if s.reconciler == nil {
		return ambiguous, nil
	}
	rowIndex := map[int64]*importing.RawImportRow{}
	for _, rows := range rowsByBatch {
		for _, row := range rows {
			if row != nil {
				rowIndex[row.RowId] = row
			}
		}
	}
	cases := []*reconciliation.CaseDetail{}
	seenCases := map[int64]struct{}{}
	for _, batchId := range batchIds {
		result, err := s.reconciler.GenerateCandidates(c, reconciliation.GenerateCandidatesRequest{Uid: uid, BatchId: batchId})
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if result == nil {
			continue
		}
		for _, summary := range result.Cases {
			if summary == nil {
				continue
			}
			if _, exists := seenCases[summary.CaseId]; exists {
				continue
			}
			seenCases[summary.CaseId] = struct{}{}
			detail, getErr := s.reconciler.GetCase(c, uid, summary.CaseId)
			if getErr != nil || detail == nil {
				continue
			}
			cases = append(cases, detail)
		}
	}
	rowCases := map[int64][]*reconciliation.CaseDetail{}
	for _, detail := range cases {
		for _, member := range detail.Members {
			if member == nil {
				continue
			}
			for _, evidence := range member.Evidence {
				if evidence != nil {
					rowCases[evidence.RowId] = append(rowCases[evidence.RowId], detail)
				}
			}
		}
	}
	for _, detail := range cases {
		if detail.SuggestedRelationType != reconciliation.DECISION_TYPE_SAME_EVENT || detail.Status != reconciliation.CASE_STATUS_OPEN {
			for _, member := range detail.Members {
				for _, evidence := range member.Evidence {
					if evidence != nil {
						ambiguous[evidence.RowId] = true
					}
				}
			}
			continue
		}
		if !s.highConfidenceSameEvent(detail, rowIndex) {
			for _, member := range detail.Members {
				for _, evidence := range member.Evidence {
					if evidence != nil {
						ambiguous[evidence.RowId] = true
					}
				}
			}
			continue
		}
		unique := true
		for _, member := range detail.Members {
			for _, evidence := range member.Evidence {
				if evidence != nil && len(rowCases[evidence.RowId]) != 1 {
					unique = false
				}
			}
		}
		if !unique {
			for _, member := range detail.Members {
				for _, evidence := range member.Evidence {
					if evidence != nil {
						ambiguous[evidence.RowId] = true
					}
				}
			}
			continue
		}
		if _, err := s.reconciler.DecideCase(c, reconciliation.DecideCaseRequest{
			Uid: uid, CaseId: detail.CaseId, ExpectedCaseVersion: detail.Version,
			DecisionType:   reconciliation.DECISION_TYPE_SAME_EVENT,
			IdempotencyKey: "billflow-recon-" + strconv.FormatInt(taskId, 10) + "-" + strconv.FormatInt(detail.CaseId, 10),
			CreatedIp:      createdIp,
		}, time.UTC); err != nil {
			for _, member := range detail.Members {
				for _, evidence := range member.Evidence {
					if evidence != nil {
						ambiguous[evidence.RowId] = true
					}
				}
			}
		}
	}
	return ambiguous, nil
}

func (s *Service) highConfidenceSameEvent(detail *reconciliation.CaseDetail, rows map[int64]*importing.RawImportRow) bool {
	var first *importing.RawImportRow
	for _, member := range detail.Members {
		if member == nil {
			continue
		}
		for _, evidence := range member.Evidence {
			if evidence == nil {
				continue
			}
			row := rows[evidence.RowId]
			if row == nil || row.NormalizedAmount == nil || row.NormalizedUnixTime == nil {
				return false
			}
			if first == nil {
				first = row
				continue
			}
			if first.Currency != row.Currency || *first.NormalizedAmount != *row.NormalizedAmount {
				return false
			}
			delta := *first.NormalizedUnixTime - *row.NormalizedUnixTime
			if delta < 0 {
				delta = -delta
			}
			if delta > HIGH_CONFIDENCE_WINDOW_SECONDS {
				return false
			}
			if first.LedgerAccountId != nil && row.LedgerAccountId != nil && *first.LedgerAccountId != *row.LedgerAccountId {
				return false
			}
			if first.NormalizedDirection != row.NormalizedDirection && !compatibleBillflowDirections(first.NormalizedDirection, row.NormalizedDirection) {
				return false
			}
		}
	}
	return first != nil
}

func compatibleBillflowDirections(left importing.NormalizedDirection, right importing.NormalizedDirection) bool {
	if left == right {
		return true
	}
	return (left == importing.NORMALIZED_DIRECTION_EXPENSE && right == importing.NORMALIZED_DIRECTION_EXPENSE) ||
		(left == importing.NORMALIZED_DIRECTION_INCOME && right == importing.NORMALIZED_DIRECTION_INCOME)
}

func (s *Service) persistOrganizeResult(c core.Context, request RunTaskRequest, action *Action, _ *Task, plan *organizePlan, posted int64, status TaskStatus) error {
	if err := s.applyReadyAction(c, request.Uid, request.TaskId, request.ExpectedVersion, action, func(next *Task) {
		next.Status = status
		if posted > 0 {
			next.AutoPostedCount = posted
		} else {
			next.AutoPostedCount = plan.posted
		}
		next.TodoOpenCount = int64(len(plan.todos))
	}); err != nil {
		return err
	}
	now := s.now().Unix()
	return s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		for _, todo := range plan.todos {
			existing, err := tx.FindTodoBySubject(request.TaskId, todo.TodoKind, todo.SubjectKind, todo.SubjectId)
			if err != nil {
				return err
			}
			if existing != nil {
				continue
			}
			item := todo
			item.Uid = request.Uid
			item.TaskId = request.TaskId
			item.Status = TODO_STATUS_OPEN
			item.Version = 1
			item.CreatedUnixTime = now
			item.UpdatedUnixTime = now
			item.TodoId = s.generateId()
			if item.ReasonCodesJson == "" {
				item.ReasonCodesJson = "[]"
			}
			if err := tx.InsertTodo(&item); err != nil {
				return err
			}
		}
		return nil
	})
}

type categoryIndex struct {
	leaves  map[string]int64
	aliases map[string]int64
}

func (index *categoryIndex) lookup(sourceType importing.SourceType, name string) (int64, bool) {
	if index == nil || name == "" || isForbiddenCategoryName(name) {
		return 0, false
	}
	if id, ok := index.aliases[string(sourceType)+"\x00"+categoryAliasKey(name)]; ok {
		return id, true
	}
	if id, ok := index.leaves[canonicalCategoryName(name)]; ok {
		return id, true
	}
	return 0, false
}

func (s *Service) loadCategoryIndex(c core.Context, uid int64, sourceByBatch map[int64]importing.SourceType, rowsByBatch map[int64][]*importing.RawImportRow) (*categoryIndex, error) {
	index := &categoryIndex{leaves: map[string]int64{}, aliases: map[string]int64{}}
	if s.categories != nil {
		catalog, err := s.categories.ListVisibleLeafCategories(c, uid)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, leaf := range catalog {
			index.leaves[canonicalCategoryName(leaf.Name)] = leaf.CategoryId
		}
	}
	seen := map[string]struct{}{}
	for batchId, rows := range rowsByBatch {
		sourceType := sourceByBatch[batchId]
		for _, row := range rows {
			name := sourceCategoryName(row, sourceType)
			if name == "" || isForbiddenCategoryName(name) {
				continue
			}
			key := string(sourceType) + "\x00" + categoryAliasKey(name)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			mapping, err := s.repository.FindCategoryAlias(c, uid, sourceType, categoryAliasKey(name))
			if err != nil {
				return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
			if mapping != nil && mapping.LedgerCategoryId > 0 {
				index.aliases[key] = mapping.LedgerCategoryId
			}
		}
	}
	return index, nil
}

func createdIP(value string) string {
	if value == "" {
		return "127.0.0.1"
	}
	return value
}
