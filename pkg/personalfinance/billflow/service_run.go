package billflow

import (
	"sort"
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
	} else if !canRerunOrganize(task.Status) {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	action, created, err := s.beginAction(c, request.Uid, request.TaskId, request.ExpectedVersion, actionType, request.IdempotencyKey, []string{
		string(actionType), strconv.FormatInt(request.TaskId, 10), strconv.FormatInt(request.ExpectedVersion, 10),
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
	if len(accounts.NeedsCreate) > 0 {
		if err := s.refreshAccountStatus(c, request.Uid, request.TaskId); err != nil {
			return nil, err
		}
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}

	members, err := s.repository.ListMembers(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	shouldPost := confirmPost || task.ConfirmPolicy == CONFIRM_POLICY_AUTO_POST
	plan, err := s.buildOrganizePlan(c, request.Uid, request.TaskId, members, createdIP(request.CreatedIp), shouldPost)
	if err != nil {
		return nil, err
	}

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
				IdempotencyKey: "billflow-" + strconv.FormatInt(request.TaskId, 10) + "-" + strconv.FormatInt(batchId, 10) + "-" + strconv.FormatInt(request.ExpectedVersion, 10),
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
	commands    map[int64][]importing.PostingIdentityCommand
	todos       []Todo
	mergedPairs []sameEventPair
	posted      int64
}

func (s *Service) buildOrganizePlan(c core.Context, uid int64, taskId int64, members []*TaskMember, createdIp string, applyReconciliation bool) (*organizePlan, error) {
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

	categories, err := s.loadCategoryIndex(c, uid, sourceByBatch, rowsByBatch)
	if err != nil {
		return nil, err
	}

	ambiguousRows, mergedRows, pairs, reconciledPostCount, err := s.autoReconcile(c, uid, taskId, batchIds, rowsByBatch, sourceByBatch, categories, createdIp, applyReconciliation)
	if err != nil {
		return nil, err
	}
	plan.mergedPairs = pairs
	plan.posted += reconciledPostCount
	rowIndex := make(map[int64]*importing.RawImportRow)
	sourceIndex := make(map[int64]importing.SourceType)
	for batchId, rows := range rowsByBatch {
		for _, row := range rows {
			if row != nil {
				rowIndex[row.RowId] = row
				sourceIndex[row.RowId] = sourceByBatch[batchId]
			}
		}
	}
	for _, pair := range pairs {
		if !pairNeedsLedgerEvent(pair, rowIndex) {
			continue
		}
		canonical := preferredSameEventRow(rowIndex[pair.left], rowIndex[pair.right], sourceIndex, categories)
		if canonical == nil {
			continue
		}
		todoKind, _ := s.classifyRow(canonical, sourceIndex[canonical.RowId], false, categories)
		if todoKind == "" {
			continue
		}
		plan.todos = append(plan.todos, Todo{
			Uid: uid, TaskId: taskId, TodoKind: todoKind, Status: TODO_STATUS_OPEN,
			SubjectKind: SUBJECT_KIND_RAW_ROW, SubjectId: canonical.RowId, ReasonCodesJson: "[]",
		})
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

	for batchId, rows := range rowsByBatch {
		sourceType := sourceByBatch[batchId]
		grouped := map[int64][]*importing.RawImportRow{}
		for _, row := range rows {
			if row == nil || row.ProcessingState != importing.PROCESSING_STATE_PENDING || mergedRows[row.RowId] {
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
		if _, mapped := categories.mapped(sourceType, row); mapped {
			return "", true
		}
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
		if _, mapped := categories.mapped(sourceType, row); mapped {
			return "", true
		}
		return todoKind, false
	}
	if _, mapped := categories.mapped(sourceType, row); !mapped {
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
	if id, mapped := categories.mapped(sourceType, row); mapped {
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

func (s *Service) autoReconcile(
	c core.Context,
	uid int64,
	taskId int64,
	batchIds []int64,
	rowsByBatch map[int64][]*importing.RawImportRow,
	sourceByBatch map[int64]importing.SourceType,
	categories *categoryIndex,
	createdIp string,
	apply bool,
) (map[int64]bool, map[int64]bool, []sameEventPair, int64, error) {
	ambiguous := map[int64]bool{}
	merged := map[int64]bool{}
	if s.reconciler == nil {
		return ambiguous, merged, nil, 0, nil
	}
	rowIndex := map[int64]*importing.RawImportRow{}
	sourceIndex := map[int64]importing.SourceType{}
	taskRows := map[int64]struct{}{}
	for _, rows := range rowsByBatch {
		for _, row := range rows {
			if row != nil {
				rowIndex[row.RowId] = row
				sourceIndex[row.RowId] = sourceByBatch[row.BatchId]
				taskRows[row.RowId] = struct{}{}
			}
		}
	}
	caseIds := map[int64]struct{}{}
	for _, batchId := range batchIds {
		result, err := s.reconciler.GenerateCandidates(c, reconciliation.GenerateCandidatesRequest{Uid: uid, BatchId: batchId})
		if err != nil {
			return nil, nil, nil, 0, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		if result == nil {
			continue
		}
		for _, summary := range result.Cases {
			if summary == nil {
				continue
			}
			caseIds[summary.CaseId] = struct{}{}
		}
	}
	orderedCaseIds := make([]int64, 0, len(caseIds))
	for caseId := range caseIds {
		orderedCaseIds = append(orderedCaseIds, caseId)
	}
	sort.Slice(orderedCaseIds, func(i, j int) bool { return orderedCaseIds[i] < orderedCaseIds[j] })
	cases := make([]*reconciliation.CaseDetail, 0, len(orderedCaseIds))
	for _, caseId := range orderedCaseIds {
		detail, getErr := s.reconciler.GetCase(c, uid, caseId)
		if getErr != nil || detail == nil {
			continue
		}
		cases = append(cases, detail)
	}
	pairs := make([]sameEventPair, 0, len(cases))
	for _, detail := range cases {
		if detail == nil {
			continue
		}
		if err := s.loadCaseEvidenceRows(c, uid, detail, rowIndex, sourceIndex); err != nil {
			continue
		}
		if detail.Status == reconciliation.CASE_STATUS_DEFERRED || detail.Status == reconciliation.CASE_STATUS_ACTION_REQUIRED {
			markTaskCaseRows(ambiguous, detail, taskRows)
			continue
		}
		if detail.Status != reconciliation.CASE_STATUS_OPEN {
			continue
		}
		markTaskCaseRows(ambiguous, detail, taskRows)
		if detail.SuggestedRelationType != reconciliation.DECISION_TYPE_SAME_EVENT {
			continue
		}
		ids := caseRepresentativeRowIDs(detail, rowIndex, taskRows)
		if len(ids) != 2 {
			continue
		}
		_, leftInTask := taskRows[ids[0]]
		_, rightInTask := taskRows[ids[1]]
		if !leftInTask && rightInTask {
			ids[0], ids[1] = ids[1], ids[0]
		}
		if !s.highConfidenceSameEventRows(rowIndex[ids[0]], rowIndex[ids[1]]) {
			continue
		}
		pairs = append(pairs, sameEventPair{
			detail: detail,
			left:   ids[0],
			right:  ids[1],
			delta:  pairTimeDistance(rowIndex[ids[0]], rowIndex[ids[1]]),
		})
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].delta != pairs[j].delta {
			return pairs[i].delta < pairs[j].delta
		}
		return pairs[i].detail.CaseId < pairs[j].detail.CaseId
	})
	selectedPairs := selectAutomaticSameEventPairs(pairs, rowIndex, sourceIndex)
	decidedPairs := make([]sameEventPair, 0, len(selectedPairs))
	var posted int64
	for _, pair := range selectedPairs {
		if !apply {
			merged[pair.left] = true
			merged[pair.right] = true
			delete(ambiguous, pair.left)
			delete(ambiguous, pair.right)
			decidedPairs = append(decidedPairs, pair)
			if pairNeedsLedgerEvent(pair, rowIndex) {
				posted++
			}
			continue
		}
		result, err := s.reconciler.DecideCase(c, reconciliation.DecideCaseRequest{
			Uid: uid, CaseId: pair.detail.CaseId, ExpectedCaseVersion: pair.detail.Version,
			DecisionType:   reconciliation.DECISION_TYPE_SAME_EVENT,
			IdempotencyKey: "billflow-recon-" + strconv.FormatInt(taskId, 10) + "-" + strconv.FormatInt(pair.detail.CaseId, 10),
			CreatedIp:      createdIp,
			PrimaryDraft:   s.sameEventDraft(pair, rowIndex, sourceIndex, categories),
		}, time.UTC)
		if err != nil || result == nil || result.Status != reconciliation.DECISION_STATUS_APPLIED {
			continue
		}
		merged[pair.left] = true
		merged[pair.right] = true
		delete(ambiguous, pair.left)
		delete(ambiguous, pair.right)
		decidedPairs = append(decidedPairs, pair)
		if pairNeedsLedgerEvent(pair, rowIndex) {
			posted++
		}
	}
	return ambiguous, merged, decidedPairs, posted, nil
}

type sameDayMergeBucket struct {
	ledgerAccountId int64
	amount          int64
	currency        string
	direction       importing.NormalizedDirection
	civilDate       string
}

// selectAutomaticSameEventPairs 先选普通唯一边，再处理信用卡月结单的同日等量桶，
// 最后才接受退款跨记账日后仍唯一的一对一。等量桶只决定“有 N 个重复事件”，
// 每个详细渠道行仍对应一个独立正式交易，不会把 N 笔压成一笔。
func selectAutomaticSameEventPairs(pairs []sameEventPair, rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType) []sameEventPair {
	selected := make([]sameEventPair, 0, len(pairs))
	paired := make(map[int64]struct{})
	selectPair := func(pair sameEventPair) {
		if _, exists := paired[pair.left]; exists {
			return
		}
		if _, exists := paired[pair.right]; exists {
			return
		}
		paired[pair.left] = struct{}{}
		paired[pair.right] = struct{}{}
		selected = append(selected, pair)
	}

	sameDay := make([]sameEventPair, 0, len(pairs))
	crossDayRefund := make([]sameEventPair, 0, len(pairs))
	for _, pair := range pairs {
		left, right := rows[pair.left], rows[pair.right]
		if left == nil || right == nil {
			continue
		}
		if rowCivilDateForMerge(left) == rowCivilDateForMerge(right) {
			sameDay = append(sameDay, pair)
		} else if left.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND || right.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND {
			crossDayRefund = append(crossDayRefund, pair)
		}
	}

	selectUniquePairs := func(candidates []sameEventPair) {
		degrees := make(map[int64]int)
		for _, pair := range candidates {
			if _, exists := paired[pair.left]; exists {
				continue
			}
			if _, exists := paired[pair.right]; exists {
				continue
			}
			degrees[pair.left]++
			degrees[pair.right]++
		}
		for _, pair := range candidates {
			if degrees[pair.left] == 1 && degrees[pair.right] == 1 {
				selectPair(pair)
			}
		}
	}

	buckets := make(map[sameDayMergeBucket][]sameEventPair)
	statementCases := make(map[int64]struct{})
	for _, pair := range sameDay {
		left, right := rows[pair.left], rows[pair.right]
		if left == nil || right == nil || left.NormalizedAmount == nil || left.LedgerAccountId == nil ||
			sources[pair.left] == sources[pair.right] ||
			(sources[pair.left] != importing.SOURCE_TYPE_BANK && sources[pair.right] != importing.SOURCE_TYPE_BANK) {
			continue
		}
		bucket := sameDayMergeBucket{
			ledgerAccountId: *left.LedgerAccountId,
			amount:          *left.NormalizedAmount,
			currency:        left.Currency,
			direction:       effectiveMergeDirection(left),
			civilDate:       rowCivilDateForMerge(left),
		}
		buckets[bucket] = append(buckets[bucket], pair)
		statementCases[pair.detail.CaseId] = struct{}{}
	}

	for _, bucketPairs := range buckets {
		for _, pair := range selectBalancedStatementBucket(bucketPairs, rows, sources) {
			selectPair(pair)
		}
	}
	remainingSameDay := make([]sameEventPair, 0, len(sameDay))
	for _, pair := range sameDay {
		if _, statementPair := statementCases[pair.detail.CaseId]; !statementPair {
			remainingSameDay = append(remainingSameDay, pair)
		}
	}
	selectUniquePairs(remainingSameDay)

	selectUniquePairs(crossDayRefund)
	sort.SliceStable(selected, func(i, j int) bool {
		if selected[i].delta != selected[j].delta {
			return selected[i].delta < selected[j].delta
		}
		return selected[i].detail.CaseId < selected[j].detail.CaseId
	})
	return selected
}

func selectBalancedStatementBucket(pairs []sameEventPair, rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType) []sameEventPair {
	bankRows := make(map[int64]struct{})
	detailRows := make(map[int64]struct{})
	edges := make(map[int64][]sameEventPair)
	for _, pair := range pairs {
		bankId, detailId := pair.left, pair.right
		if sources[bankId] != importing.SOURCE_TYPE_BANK {
			bankId, detailId = detailId, bankId
		}
		if sources[bankId] != importing.SOURCE_TYPE_BANK || sources[detailId] == importing.SOURCE_TYPE_BANK {
			continue
		}
		bankRows[bankId] = struct{}{}
		detailRows[detailId] = struct{}{}
		edges[detailId] = append(edges[detailId], pair)
	}
	if len(bankRows) < 1 || len(bankRows) != len(detailRows) {
		return nil
	}
	detailIds := make([]int64, 0, len(detailRows))
	for rowId := range detailRows {
		detailIds = append(detailIds, rowId)
	}
	sort.Slice(detailIds, func(i, j int) bool {
		left, right := rows[detailIds[i]], rows[detailIds[j]]
		if left != nil && right != nil && left.NormalizedUnixTime != nil && right.NormalizedUnixTime != nil && *left.NormalizedUnixTime != *right.NormalizedUnixTime {
			return *left.NormalizedUnixTime < *right.NormalizedUnixTime
		}
		return detailIds[i] < detailIds[j]
	})
	for detailId := range edges {
		sort.SliceStable(edges[detailId], func(i, j int) bool {
			if edges[detailId][i].delta != edges[detailId][j].delta {
				return edges[detailId][i].delta < edges[detailId][j].delta
			}
			return edges[detailId][i].detail.CaseId < edges[detailId][j].detail.CaseId
		})
	}
	assigned := make(map[int64]sameEventPair)
	var match func(int64, map[int64]struct{}) bool
	match = func(detailId int64, seen map[int64]struct{}) bool {
		for _, pair := range edges[detailId] {
			bankId := pair.left
			if sources[bankId] != importing.SOURCE_TYPE_BANK {
				bankId = pair.right
			}
			if _, exists := seen[bankId]; exists {
				continue
			}
			seen[bankId] = struct{}{}
			previous, occupied := assigned[bankId]
			previousDetailId := previous.left
			if occupied && sources[previousDetailId] == importing.SOURCE_TYPE_BANK {
				previousDetailId = previous.right
			}
			if !occupied || match(previousDetailId, seen) {
				assigned[bankId] = pair
				return true
			}
		}
		return false
	}
	for _, detailId := range detailIds {
		if !match(detailId, make(map[int64]struct{})) {
			return nil
		}
	}
	if len(assigned) != len(detailRows) {
		return nil
	}
	result := make([]sameEventPair, 0, len(assigned))
	for _, pair := range assigned {
		result = append(result, pair)
	}
	return result
}

func rowCivilDateForMerge(row *importing.RawImportRow) string {
	if row == nil || row.NormalizedUnixTime == nil {
		return ""
	}
	offset := 0
	if row.NormalizedTimezoneUtcOffset != nil {
		offset = int(*row.NormalizedTimezoneUtcOffset) * 60
	}
	return time.Unix(*row.NormalizedUnixTime, 0).In(time.FixedZone("billflow-row", offset)).Format(time.DateOnly)
}

func pairNeedsLedgerEvent(pair sameEventPair, rows map[int64]*importing.RawImportRow) bool {
	left, right := rows[pair.left], rows[pair.right]
	return left != nil && right != nil &&
		left.ProcessingState == importing.PROCESSING_STATE_PENDING &&
		right.ProcessingState == importing.PROCESSING_STATE_PENDING
}

func (s *Service) loadCaseEvidenceRows(c core.Context, uid int64, detail *reconciliation.CaseDetail, rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType) error {
	if s == nil || s.evidence == nil || detail == nil {
		return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, member := range detail.Members {
		if member == nil {
			continue
		}
		for _, evidence := range member.Evidence {
			if evidence == nil || evidence.RowId < 1 {
				continue
			}
			row := rows[evidence.RowId]
			if row == nil {
				var err error
				row, err = s.evidence.FindRawImportRowById(c, uid, evidence.RowId)
				if err != nil || row == nil {
					return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
				}
				rows[row.RowId] = row
			}
			if _, exists := sources[row.RowId]; !exists {
				batch, err := s.evidence.FindImportBatchById(c, uid, row.BatchId)
				if err != nil || batch == nil {
					return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
				}
				sources[row.RowId] = batch.SourceTypeSnapshot
			}
		}
	}
	return nil
}

func (s *Service) sameEventDraft(pair sameEventPair, rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType, categories *categoryIndex) *importing.LedgerTransactionDraft {
	left, right := rows[pair.left], rows[pair.right]
	selected := preferredSameEventRow(left, right, sources, categories)
	if selected == nil || selected.LedgerAccountId == nil || selected.NormalizedAmount == nil || selected.NormalizedUnixTime == nil {
		return nil
	}
	txType := models.TRANSACTION_TYPE_EXPENSE
	if effectiveMergeDirection(selected) == importing.NORMALIZED_DIRECTION_INCOME {
		txType = models.TRANSACTION_TYPE_INCOME
	} else if effectiveMergeDirection(selected) != importing.NORMALIZED_DIRECTION_EXPENSE {
		return nil
	}
	categoryId := int64(0)
	allowUncategorized := true
	if id, ok := categories.mapped(sources[selected.RowId], selected); ok {
		categoryId = id
		allowUncategorized = false
	}
	offset := int16(0)
	if selected.NormalizedTimezoneUtcOffset != nil {
		offset = *selected.NormalizedTimezoneUtcOffset
	}
	return &importing.LedgerTransactionDraft{
		Type: txType, CategoryId: categoryId, AllowUncategorized: allowUncategorized,
		UnixTime: *selected.NormalizedUnixTime, TimezoneUtcOffset: offset,
		SourceAccountId: *selected.LedgerAccountId, SourceAmount: *selected.NormalizedAmount,
	}
}

func preferredSameEventRow(left *importing.RawImportRow, right *importing.RawImportRow, sources map[int64]importing.SourceType, categories *categoryIndex) *importing.RawImportRow {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	_, leftMapped := categories.mapped(sources[left.RowId], left)
	_, rightMapped := categories.mapped(sources[right.RowId], right)
	if leftMapped != rightMapped {
		if leftMapped {
			return left
		}
		return right
	}
	if sources[left.RowId] == importing.SOURCE_TYPE_BANK && sources[right.RowId] != importing.SOURCE_TYPE_BANK {
		return right
	}
	return left
}

type sameEventPair struct {
	detail      *reconciliation.CaseDetail
	left, right int64
	delta       int64
}

func markTaskCaseRows(ambiguous map[int64]bool, detail *reconciliation.CaseDetail, taskRows map[int64]struct{}) {
	if detail == nil {
		return
	}
	for _, rowId := range caseEvidenceRowIDs(detail) {
		if _, exists := taskRows[rowId]; exists {
			ambiguous[rowId] = true
		}
	}
}

func caseRepresentativeRowIDs(detail *reconciliation.CaseDetail, rows map[int64]*importing.RawImportRow, taskRows map[int64]struct{}) []int64 {
	if detail == nil || len(detail.Members) != 2 {
		return nil
	}
	result := make([]int64, 0, 2)
	for _, member := range detail.Members {
		if member == nil {
			return nil
		}
		var selected *importing.RawImportRow
		selectedRank := -1
		for _, evidence := range member.Evidence {
			if evidence == nil {
				continue
			}
			row := rows[evidence.RowId]
			if row == nil {
				continue
			}
			rank := mergeRepresentativeRank(row, taskRows)
			if selected == nil || rank > selectedRank || (rank == selectedRank && row.RowId > selected.RowId) {
				selected = row
				selectedRank = rank
			}
		}
		if selected == nil {
			return nil
		}
		result = append(result, selected.RowId)
	}
	return result
}

func mergeRepresentativeRank(row *importing.RawImportRow, taskRows map[int64]struct{}) int {
	if row == nil {
		return -1
	}
	_, inTask := taskRows[row.RowId]
	if inTask && row.ProcessingState == importing.PROCESSING_STATE_PENDING {
		return 4
	}
	if inTask {
		return 3
	}
	if row.ProcessingState == importing.PROCESSING_STATE_LINKED {
		return 2
	}
	return 1
}

func caseEvidenceRowIDs(detail *reconciliation.CaseDetail) []int64 {
	if detail == nil {
		return nil
	}
	seen := map[int64]struct{}{}
	ids := make([]int64, 0, 2)
	for _, member := range detail.Members {
		if member == nil {
			continue
		}
		for _, evidence := range member.Evidence {
			if evidence == nil || evidence.RowId < 1 {
				continue
			}
			if _, exists := seen[evidence.RowId]; exists {
				continue
			}
			seen[evidence.RowId] = struct{}{}
			ids = append(ids, evidence.RowId)
		}
	}
	return ids
}

func pairTimeDistance(left *importing.RawImportRow, right *importing.RawImportRow) int64 {
	if left == nil || right == nil || left.NormalizedUnixTime == nil || right.NormalizedUnixTime == nil {
		return 1 << 62
	}
	delta := *left.NormalizedUnixTime - *right.NormalizedUnixTime
	if delta < 0 {
		return -delta
	}
	return delta
}

func (s *Service) highConfidenceSameEventRows(first *importing.RawImportRow, second *importing.RawImportRow) bool {
	if first == nil || second == nil || first.NormalizedAmount == nil || second.NormalizedAmount == nil ||
		first.NormalizedUnixTime == nil || second.NormalizedUnixTime == nil || first.LedgerAccountId == nil || second.LedgerAccountId == nil ||
		*first.LedgerAccountId < 1 || *second.LedgerAccountId < 1 {
		return false
	}
	return first.Currency == second.Currency && *first.NormalizedAmount == *second.NormalizedAmount &&
		reconciliation.CrossSourceComparisonMatch(first, second, HIGH_CONFIDENCE_WINDOW_SECONDS) &&
		*first.LedgerAccountId == *second.LedgerAccountId &&
		compatibleBillflowRows(first, second)
}

func compatibleBillflowRows(left *importing.RawImportRow, right *importing.RawImportRow) bool {
	if left == nil || right == nil {
		return false
	}
	return effectiveMergeDirection(left) == effectiveMergeDirection(right)
}

func effectiveMergeDirection(row *importing.RawImportRow) importing.NormalizedDirection {
	if row == nil {
		return importing.NORMALIZED_DIRECTION_UNKNOWN
	}
	if row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_NEUTRAL {
		return importing.NORMALIZED_DIRECTION_INCOME
	}
	return row.NormalizedDirection
}

func canRerunOrganize(status TaskStatus) bool {
	return status == TASK_STATUS_RECEIVING || status == TASK_STATUS_AWAITING_CONFIRM || status == TASK_STATUS_READY
}

func todoIdentityKey(kind TodoKind, subjectKind SubjectKind, subjectId int64) string {
	return string(kind) + "\x00" + string(subjectKind) + "\x00" + strconv.FormatInt(subjectId, 10)
}

func (s *Service) persistOrganizeResult(c core.Context, request RunTaskRequest, action *Action, task *Task, plan *organizePlan, posted int64, status TaskStatus) error {
	if task == nil || action == nil || plan == nil || task.Version != request.ExpectedVersion {
		return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	now := s.now().Unix()
	keep := map[string]struct{}{}
	for _, todo := range plan.todos {
		keep[todoIdentityKey(todo.TodoKind, todo.SubjectKind, todo.SubjectId)] = struct{}{}
	}
	mergedSubjects := map[int64]struct{}{}
	for _, pair := range plan.mergedPairs {
		mergedSubjects[pair.left] = struct{}{}
		mergedSubjects[pair.right] = struct{}{}
	}
	return s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		openTodos, err := tx.ListOpenTodos(request.TaskId)
		if err != nil {
			return err
		}
		for _, existing := range openTodos {
			if existing == nil || existing.TodoKind != TODO_KIND_CROSS_SOURCE_AMBIGUOUS {
				continue
			}
			if _, stillNeeded := keep[todoIdentityKey(existing.TodoKind, existing.SubjectKind, existing.SubjectId)]; stillNeeded {
				continue
			}
			next := *existing
			next.Status = TODO_STATUS_RESOLVED
			next.Version = existing.Version + 1
			next.UpdatedUnixTime = now
			next.ResolvedUnixTime = &now
			updated, updateErr := tx.UpdateTodoCAS(existing.Version, &next)
			if updateErr != nil || !updated {
				return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
			}
		}
		for _, todo := range plan.todos {
			existing, err := tx.FindTodoBySubject(request.TaskId, todo.TodoKind, todo.SubjectKind, todo.SubjectId)
			if err != nil {
				return err
			}
			if existing != nil {
				if todo.TodoKind == TODO_KIND_CROSS_SOURCE_AMBIGUOUS && existing.Status != TODO_STATUS_OPEN {
					if _, merged := mergedSubjects[todo.SubjectId]; !merged {
						next := *existing
						next.Status = TODO_STATUS_OPEN
						next.Version = existing.Version + 1
						next.UpdatedUnixTime = now
						next.ResolvedUnixTime = nil
						updated, updateErr := tx.UpdateTodoCAS(existing.Version, &next)
						if updateErr != nil || !updated {
							return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
						}
					}
				}
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
		for _, pair := range plan.mergedPairs {
			if err := s.ensureResolvedMergeTodo(tx, request, pair, now); err != nil {
				return err
			}
		}
		nextTask := cloneTask(task)
		nextTask.Status = status
		if posted > 0 {
			nextTask.AutoPostedCount = posted
		} else {
			nextTask.AutoPostedCount = plan.posted
		}
		nextTask.TodoOpenCount = int64(len(plan.todos))
		nextTask.Version = task.Version + 1
		nextTask.UpdatedUnixTime = now
		nextTask.CurrentActionId = &action.ActionId
		updated, updateErr := tx.UpdateTaskCAS(request.ExpectedVersion, nextTask)
		if updateErr != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		applied := cloneAction(action)
		applied.Status = ACTION_STATUS_APPLIED
		applied.AppliedTaskVersion = nextTask.Version
		applied.UpdatedUnixTime = now
		applied.CompletedUnixTime = &now
		updated, updateErr = tx.UpdateAction(applied)
		if updateErr != nil || !updated {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		return nil
	})
}

func (s *Service) ensureResolvedMergeTodo(tx *RepositoryTransaction, request RunTaskRequest, pair sameEventPair, now int64) error {
	if pair.detail == nil || pair.detail.CaseId < 1 {
		return nil
	}
	existing, err := tx.FindTodoBySubject(request.TaskId, TODO_KIND_CROSS_SOURCE_AMBIGUOUS, SUBJECT_KIND_RECONCILIATION_CASE, pair.detail.CaseId)
	if err != nil {
		return err
	}
	if existing != nil {
		if existing.Status == TODO_STATUS_DISMISSED || (existing.Status == TODO_STATUS_RESOLVED && hasReasonCode(existing.ReasonCodesJson, "auto_merged")) {
			return nil
		}
		next := *existing
		next.Status = TODO_STATUS_RESOLVED
		next.ReasonCodesJson = encodeReasonCodes([]string{"auto_merged"})
		next.Version = existing.Version + 1
		next.UpdatedUnixTime = now
		next.ResolvedUnixTime = &now
		updated, updateErr := tx.UpdateTodoCAS(existing.Version, &next)
		if updateErr != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	}
	item := Todo{
		Uid: request.Uid, TaskId: request.TaskId, TodoKind: TODO_KIND_CROSS_SOURCE_AMBIGUOUS, Status: TODO_STATUS_OPEN,
		SubjectKind: SUBJECT_KIND_RECONCILIATION_CASE, SubjectId: pair.detail.CaseId, ReasonCodesJson: encodeReasonCodes([]string{"auto_merged"}),
		Version: 1, CreatedUnixTime: now, UpdatedUnixTime: now, TodoId: s.generateId(),
	}
	if err := tx.InsertTodo(&item); err != nil {
		return err
	}
	next := item
	next.Status = TODO_STATUS_RESOLVED
	next.Version = 2
	next.UpdatedUnixTime = now
	next.ResolvedUnixTime = &now
	updated, updateErr := tx.UpdateTodoCAS(1, &next)
	if updateErr != nil || !updated {
		return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	return nil
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
	if fallback := sourceCategoryLeafFallback(sourceType, name); fallback != "" {
		if id, ok := index.leaves[canonicalCategoryName(fallback)]; ok {
			return id, true
		}
	}
	return 0, false
}

func (index *categoryIndex) mapped(sourceType importing.SourceType, row *importing.RawImportRow) (int64, bool) {
	for _, name := range categoryAliasCandidates(row, sourceType) {
		if id, ok := index.lookup(sourceType, name); ok {
			return id, true
		}
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
			for _, name := range categoryAliasCandidates(row, sourceType) {
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
	}
	return index, nil
}

func createdIP(value string) string {
	if value == "" {
		return "127.0.0.1"
	}
	return value
}
