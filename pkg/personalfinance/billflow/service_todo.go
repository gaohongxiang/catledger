package billflow

import (
	"sort"
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

type ResolveTodoRequest struct {
	Uid             int64
	TodoId          int64
	ExpectedVersion int64
	Status          TodoStatus
	IdempotencyKey  string
}

type AssignTodoCategoryItem struct {
	TodoId          int64
	ExpectedVersion int64
}

type AssignTodoCategoryRequest struct {
	Uid            int64
	CategoryId     int64
	IdempotencyKey string
	Items          []AssignTodoCategoryItem
}

func (s *Service) ResolveTodo(c core.Context, request ResolveTodoRequest) (*TodoView, error) {
	restore := request.Status == TODO_STATUS_OPEN
	if s == nil || s.repository == nil || request.Uid < 1 || request.TodoId < 1 || request.ExpectedVersion < 1 ||
		(!restore && request.Status != TODO_STATUS_RESOLVED && request.Status != TODO_STATUS_DISMISSED) || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	todo, err := s.repository.FindTodoById(c, request.Uid, request.TodoId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if todo == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if todo.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	if restore {
		if todo.Status != TODO_STATUS_RESOLVED && todo.Status != TODO_STATUS_DISMISSED {
			return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
		}
	} else if todo.Status != TODO_STATUS_OPEN {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	task, err := s.requireTask(c, request.Uid, todo.TaskId)
	if err != nil {
		return nil, err
	}
	if err := s.bumpTask(c, request.Uid, todo.TaskId, task.Version, request.IdempotencyKey, ACTION_TYPE_RESOLVE_TODO, []string{
		"resolve_todo", strconv.FormatInt(request.TodoId, 10), string(request.Status),
	}, func(updated *Task) {
		if restore {
			updated.TodoOpenCount++
			return
		}
		if updated.TodoOpenCount > 0 {
			updated.TodoOpenCount--
		}
	}); err != nil {
		return nil, err
	}
	current, err := s.repository.FindTodoById(c, request.Uid, request.TodoId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if current != nil && current.Status == request.Status {
		return s.todoView(c, request.Uid, current), nil
	}
	now := s.now().Unix()
	next := *todo
	next.Status = request.Status
	next.Version = todo.Version + 1
	next.UpdatedUnixTime = now
	if restore {
		next.ResolvedUnixTime = nil
	} else {
		next.ResolvedUnixTime = &now
	}
	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		updated, updateErr := tx.UpdateTodoCAS(request.ExpectedVersion, &next)
		if updateErr != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.todoView(c, request.Uid, &next), nil
}

func (s *Service) AssignTodoCategories(c core.Context, request AssignTodoCategoryRequest) (*TaskView, error) {
	if s == nil || s.repository == nil || s.categories == nil || request.Uid < 1 || request.CategoryId < 1 ||
		len(request.Items) < 1 || len(request.Items) > maximumRepositoryPageSize || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if !s.visibleCategory(c, request.Uid, request.CategoryId) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	todos := make([]*Todo, 0, len(request.Items))
	seen := map[int64]struct{}{}
	var taskId int64
	for _, item := range request.Items {
		if item.TodoId < 1 || item.ExpectedVersion < 1 {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if _, exists := seen[item.TodoId]; exists {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		seen[item.TodoId] = struct{}{}
		todo, err := s.repository.FindTodoById(c, request.Uid, item.TodoId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if todo == nil || todo.Version != item.ExpectedVersion || !canAssignTodoCategory(todo.TodoKind) ||
			(todo.Status != TODO_STATUS_OPEN && todo.Status != TODO_STATUS_RESOLVED) {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if taskId == 0 {
			taskId = todo.TaskId
		} else if todo.TaskId != taskId {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		todos = append(todos, todo)
	}
	task, err := s.requireTask(c, request.Uid, taskId)
	if err != nil {
		return nil, err
	}
	parts := []string{"assign_todo_category", strconv.FormatInt(request.CategoryId, 10)}
	ids := make([]int64, 0, len(todos))
	for _, todo := range todos {
		ids = append(ids, todo.TodoId)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		parts = append(parts, strconv.FormatInt(id, 10))
	}
	openCount := int64(0)
	for _, todo := range todos {
		if todo.Status == TODO_STATUS_OPEN {
			openCount++
		}
	}
	if err := s.bumpTask(c, request.Uid, taskId, task.Version, request.IdempotencyKey, ACTION_TYPE_RESOLVE_TODO, parts, func(updated *Task) {
		if openCount < 1 {
			return
		}
		if updated.TodoOpenCount >= openCount {
			updated.TodoOpenCount -= openCount
		} else {
			updated.TodoOpenCount = 0
		}
	}); err != nil {
		return nil, err
	}
	now := s.now().Unix()
	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		for i, todo := range todos {
			if err := s.saveTodoCategoryAliases(c, tx, request.Uid, todo, request.CategoryId, now); err != nil {
				return err
			}
			if todo.Status != TODO_STATUS_OPEN {
				continue
			}
			next := *todo
			next.Status = TODO_STATUS_RESOLVED
			next.Version = todo.Version + 1
			next.UpdatedUnixTime = now
			next.ResolvedUnixTime = &now
			updated, updateErr := tx.UpdateTodoCAS(request.Items[i].ExpectedVersion, &next)
			if updateErr != nil || !updated {
				return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetTask(c, request.Uid, taskId)
}

func (s *Service) saveTodoCategoryAliases(c core.Context, tx *RepositoryTransaction, uid int64, todo *Todo, categoryId int64, now int64) error {
	if todo == nil || todo.SubjectKind != SUBJECT_KIND_RAW_ROW || s.evidence == nil {
		return nil
	}
	row, err := s.evidence.FindRawImportRowById(c, uid, todo.SubjectId)
	if err != nil {
		return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if row == nil {
		return nil
	}
	batch, err := s.evidence.FindImportBatchById(c, uid, row.BatchId)
	if err != nil || batch == nil {
		return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, name := range categoryAliasCandidates(row, batch.SourceTypeSnapshot) {
		display := maskedCategoryAliasDisplay(name)
		if display == "" {
			continue
		}
		if err := tx.SaveUserCategoryAlias(&CategoryAliasMapping{
			Uid: uid, SourceType: batch.SourceTypeSnapshot, AliasKey: categoryAliasKey(name),
			AliasKeyVersion: CATEGORY_ALIAS_VERSION_V1, LedgerCategoryId: categoryId, MaskedDisplayName: display,
			CreatedUnixTime: now, UpdatedUnixTime: now, MappingId: s.generateId(),
		}); err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
	}
	return nil
}

func (s *Service) visibleCategory(c core.Context, uid int64, categoryId int64) bool {
	if s.categories == nil || categoryId < 1 {
		return false
	}
	leaves, err := s.categories.ListVisibleLeafCategories(c, uid)
	if err != nil {
		return false
	}
	for _, leaf := range leaves {
		if leaf.CategoryId == categoryId {
			return true
		}
	}
	return false
}

func canAssignTodoCategory(kind TodoKind) bool {
	return kind == TODO_KIND_UNCATEGORIZED || kind == TODO_KIND_TRANSFER_UNCLEAR
}

func (s *Service) todoView(c core.Context, uid int64, todo *Todo) *TodoView {
	view := todoView(todo)
	if view == nil || s.evidence == nil || todo.SubjectKind != SUBJECT_KIND_RAW_ROW {
		return view
	}
	row, err := s.evidence.FindRawImportRowById(c, uid, todo.SubjectId)
	if err != nil || row == nil {
		return view
	}
	attachTodoPreview(view, row)
	s.attachTodoCategory(c, uid, view, row)
	return view
}

func (s *Service) attachTodoCategory(c core.Context, uid int64, view *TodoView, row *importing.RawImportRow) {
	if s == nil || s.repository == nil || s.evidence == nil || view == nil || row == nil {
		return
	}
	batch, err := s.evidence.FindImportBatchById(c, uid, row.BatchId)
	if err != nil || batch == nil {
		return
	}
	view.SourceType = string(batch.SourceTypeSnapshot)
	view.Account = importing.QualifiedPaymentAccountDisplayName(batch.SourceTypeSnapshot, row.RawPaymentMethod)
	for _, name := range categoryAliasCandidates(row, batch.SourceTypeSnapshot) {
		mapping, lookupErr := s.repository.FindCategoryAlias(c, uid, batch.SourceTypeSnapshot, categoryAliasKey(name))
		if lookupErr != nil || mapping == nil || mapping.LedgerCategoryId < 1 {
			continue
		}
		view.CategoryId = mapping.LedgerCategoryId
		return
	}
}

func attachTodoPreview(view *TodoView, row *importing.RawImportRow) {
	if view == nil || row == nil {
		return
	}
	view.Label = todoPreviewLabel(row)
	view.Item = todoPreviewItem(row)
	view.BillType = maskedCategoryAliasDisplay(row.RawTransactionType)
	view.OrderId = strings.TrimSpace(row.SourceOrderId)
	view.MerchantOrderId = strings.TrimSpace(row.SourceMerchantOrderId)
	view.Currency = row.Currency
	view.UnixTime = row.NormalizedUnixTime
	view.Direction = string(row.NormalizedDirection)
	if row.NormalizedAmount != nil {
		view.Amount = strconv.FormatInt(*row.NormalizedAmount, 10)
	}
}

func todoView(todo *Todo) *TodoView {
	if todo == nil {
		return nil
	}
	return &TodoView{
		TodoId: todo.TodoId, TodoKind: todo.TodoKind, Status: todo.Status, SubjectKind: todo.SubjectKind,
		SubjectId: todo.SubjectId, ReasonCodes: decodeReasonCodes(todo.ReasonCodesJson), Version: todo.Version,
		CreatedUnixTime: todo.CreatedUnixTime, UpdatedUnixTime: todo.UpdatedUnixTime,
	}
}

const (
	todoMatchLimit        = 5
	todoMatchCasePages    = 2
	todoMatchCasePageSize = 100
)

func (s *Service) attachTodoMatches(c core.Context, uid int64, items []*TodoView) {
	if s == nil || s.reconciler == nil || uid < 1 || len(items) == 0 {
		return
	}
	needed := map[int64]struct{}{}
	uniquePair := false
	for _, item := range items {
		if item != nil && item.TodoKind == TODO_KIND_CROSS_SOURCE_AMBIGUOUS && item.SubjectKind == SUBJECT_KIND_RAW_ROW && item.SubjectId > 0 {
			needed[item.SubjectId] = struct{}{}
			if item.Status != TODO_STATUS_OPEN {
				uniquePair = true
			}
		}
	}
	if len(needed) == 0 {
		return
	}
	statuses := []reconciliation.CaseStatus{reconciliation.CASE_STATUS_OPEN}
	if uniquePair {
		statuses = []reconciliation.CaseStatus{reconciliation.CASE_STATUS_RESOLVED}
	}
	index := s.todoMatchIndex(c, uid, needed, statuses, uniquePair)
	for _, item := range items {
		if item == nil {
			continue
		}
		item.Matches = index[item.SubjectId]
	}
}

func (s *Service) todoMatchIndex(c core.Context, uid int64, needed map[int64]struct{}, statuses []reconciliation.CaseStatus, uniquePair bool) map[int64][]*TodoMatchView {
	index := map[int64][]*TodoMatchView{}
	seen := map[int64]map[int64]struct{}{}
	for _, status := range statuses {
		var cursor *reconciliation.CaseCursor
		for page := 0; page < todoMatchCasePages; page++ {
			result, err := s.reconciler.ListCases(c, reconciliation.ListCasesRequest{
				Uid: uid, Status: status, Cursor: cursor, Limit: todoMatchCasePageSize,
			})
			if err != nil || result == nil {
				return index
			}
			for _, summary := range result.Items {
				if summary == nil {
					continue
				}
				detail, getErr := s.reconciler.GetCase(c, uid, summary.CaseId)
				if getErr != nil || detail == nil {
					continue
				}
				s.collectTodoMatches(c, uid, detail, needed, index, seen, uniquePair)
			}
			if result.NextCursor == nil {
				break
			}
			cursor = result.NextCursor
		}
	}
	if uniquePair {
		for rowId, matches := range index {
			if len(matches) != 1 {
				delete(index, rowId)
			}
		}
	}
	return index
}

func (s *Service) collectTodoMatches(
	c core.Context,
	uid int64,
	detail *reconciliation.CaseDetail,
	needed map[int64]struct{},
	index map[int64][]*TodoMatchView,
	seen map[int64]map[int64]struct{},
	uniquePair bool,
) {
	if detail == nil {
		return
	}
	type matchRow struct {
		rowId   int64
		account string
		summary *reconciliation.CaseEvidenceSummary
	}
	rows := make([]matchRow, 0)
	for _, member := range detail.Members {
		if member == nil {
			continue
		}
		for _, evidence := range member.Evidence {
			if evidence == nil || evidence.RowId < 1 {
				continue
			}
			rows = append(rows, matchRow{rowId: evidence.RowId, account: member.MaskedSourceAccount, summary: evidence})
		}
	}
	for _, subject := range rows {
		if _, want := needed[subject.rowId]; !want {
			continue
		}
		others := make([]matchRow, 0, 1)
		for _, other := range rows {
			if other.rowId == subject.rowId || !sameMatchAmount(subject.summary, other.summary) {
				continue
			}
			others = append(others, other)
		}
		if uniquePair && len(others) != 1 {
			continue
		}
		if seen[subject.rowId] == nil {
			seen[subject.rowId] = map[int64]struct{}{}
		}
		for _, other := range others {
			if _, exists := seen[subject.rowId][other.rowId]; exists {
				continue
			}
			if len(index[subject.rowId]) >= todoMatchLimit {
				continue
			}
			seen[subject.rowId][other.rowId] = struct{}{}
			index[subject.rowId] = append(index[subject.rowId], s.todoMatchView(c, uid, other.summary))
		}
	}
}

func sameMatchAmount(left *reconciliation.CaseEvidenceSummary, right *reconciliation.CaseEvidenceSummary) bool {
	if left == nil || right == nil {
		return false
	}
	if left.NormalizedAmount != nil && right.NormalizedAmount != nil && *left.NormalizedAmount != *right.NormalizedAmount {
		return false
	}
	if left.Currency != "" && right.Currency != "" && left.Currency != right.Currency {
		return false
	}
	return true
}

func (s *Service) todoMatchView(c core.Context, uid int64, evidence *reconciliation.CaseEvidenceSummary) *TodoMatchView {
	view := &TodoMatchView{}
	if evidence == nil {
		return view
	}
	view.RowId = evidence.RowId
	view.SourceType = string(evidence.SourceType)
	view.Currency = evidence.Currency
	view.Direction = string(evidence.NormalizedDirection)
	view.UnixTime = cloneUnixTime(evidence.NormalizedUnixTime)
	if evidence.NormalizedAmount != nil {
		view.Amount = strconv.FormatInt(*evidence.NormalizedAmount, 10)
	}
	if s != nil && s.evidence != nil && evidence.RowId > 0 {
		row, err := s.evidence.FindRawImportRowById(c, uid, evidence.RowId)
		if err == nil && row != nil {
			sourceType := evidence.SourceType
			if sourceType == "" {
				if batch, batchErr := s.evidence.FindImportBatchById(c, uid, row.BatchId); batchErr == nil && batch != nil {
					sourceType = batch.SourceTypeSnapshot
				}
			}
			view.SourceType = string(sourceType)
			view.Label = todoPreviewLabel(row)
			view.Item = todoPreviewItem(row)
			view.BillType = maskedCategoryAliasDisplay(row.RawTransactionType)
			view.Account = importing.QualifiedPaymentAccountDisplayName(sourceType, row.RawPaymentMethod)
			view.OrderId = strings.TrimSpace(row.SourceOrderId)
			view.MerchantOrderId = strings.TrimSpace(row.SourceMerchantOrderId)
			if view.Currency == "" {
				view.Currency = row.Currency
			}
			if view.Direction == "" {
				view.Direction = string(row.NormalizedDirection)
			}
			if view.UnixTime == nil {
				view.UnixTime = cloneUnixTime(row.NormalizedUnixTime)
			}
			if view.Amount == "" && row.NormalizedAmount != nil {
				view.Amount = strconv.FormatInt(*row.NormalizedAmount, 10)
			}
		}
	}
	return view
}

func cloneUnixTime(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
