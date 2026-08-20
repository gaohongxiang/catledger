package billflow

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

type mergeCaseProjection struct {
	detail *reconciliation.CaseDetail
	rows   [2]int64
	status MergeGroupStatus
}

func (s *Service) ListMergeGroups(c core.Context, uid int64, taskId int64) (*MergeGroupListResult, error) {
	if s == nil || s.repository == nil || s.evidence == nil || s.reconciler == nil || uid < 1 || taskId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	rowIndex := make(map[int64]*importing.RawImportRow)
	sourceIndex := make(map[int64]importing.SourceType)
	taskRows := make(map[int64]struct{})
	rowIds := make([]int64, 0)
	var evidenceRowCount int64
	for _, member := range members {
		if member == nil {
			continue
		}
		batch, batchErr := s.evidence.FindImportBatchById(c, uid, member.BatchId)
		if batchErr != nil || batch == nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		rows, rowsErr := s.evidence.ListRawImportRows(c, uid, member.BatchId)
		if rowsErr != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, row := range rows {
			if row == nil || row.ProcessingState == importing.PROCESSING_STATE_IGNORED || row.ProcessingState == importing.PROCESSING_STATE_FAILED {
				continue
			}
			rowIndex[row.RowId] = row
			sourceIndex[row.RowId] = batch.SourceTypeSnapshot
			taskRows[row.RowId] = struct{}{}
			rowIds = append(rowIds, row.RowId)
			if isBillflowEconomicEvidenceRow(row) {
				evidenceRowCount++
			}
		}
	}
	if len(rowIds) == 0 {
		return &MergeGroupListResult{Items: []*MergeGroupView{}}, nil
	}
	details, err := s.reconciler.ListCasesForRows(c, uid, rowIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, detail := range details {
		if detail != nil {
			if err := s.loadCaseEvidenceRows(c, uid, detail, rowIndex, sourceIndex); err != nil {
				return nil, err
			}
		}
	}
	previewRows, previewCases, err := s.previewMergeSelections(c, uid, taskId)
	if err != nil {
		return nil, err
	}
	selectedRows := make(map[int64]struct{})
	selectedCaseIds := make(map[int64]struct{})
	for _, detail := range details {
		if detail == nil {
			continue
		}
		_, preview := previewCases[detail.CaseId]
		appliedSameEvent := detail.CurrentDecisionType != nil && detail.CurrentDecisionStatus != nil &&
			*detail.CurrentDecisionType == reconciliation.DECISION_TYPE_SAME_EVENT && *detail.CurrentDecisionStatus == reconciliation.DECISION_STATUS_APPLIED
		if !preview && !appliedSameEvent {
			continue
		}
		ids := caseRepresentativeRowIDs(detail, rowIndex, taskRows)
		inTask := false
		for _, rowId := range ids {
			selectedRows[rowId] = struct{}{}
			if _, exists := taskRows[rowId]; exists {
				inTask = true
			}
		}
		if inTask {
			selectedCaseIds[detail.CaseId] = struct{}{}
		}
	}
	projections := make([]mergeCaseProjection, 0, len(details))
	for _, detail := range details {
		appliedSameEvent := detail != nil && detail.CurrentDecisionType != nil && detail.CurrentDecisionStatus != nil &&
			*detail.CurrentDecisionType == reconciliation.DECISION_TYPE_SAME_EVENT && *detail.CurrentDecisionStatus == reconciliation.DECISION_STATUS_APPLIED
		if detail == nil || (detail.SuggestedRelationType != reconciliation.DECISION_TYPE_SAME_EVENT && !appliedSameEvent) {
			continue
		}
		ids := caseRepresentativeRowIDs(detail, rowIndex, taskRows)
		if len(ids) != 2 {
			continue
		}
		if _, left := taskRows[ids[0]]; !left {
			if _, right := taskRows[ids[1]]; !right {
				continue
			}
		}
		_, previewLeft := previewRows[ids[0]]
		_, previewRight := previewRows[ids[1]]
		_, previewCase := previewCases[detail.CaseId]
		preview := previewCase || (len(previewCases) == 0 && (previewLeft || previewRight))
		if !preview {
			_, leftSelected := selectedRows[ids[0]]
			_, rightSelected := selectedRows[ids[1]]
			if (leftSelected || rightSelected) && detail.Status == reconciliation.CASE_STATUS_OPEN && detail.CurrentDecisionId == nil {
				continue
			}
		}
		projections = append(projections, mergeCaseProjection{detail: detail, rows: [2]int64{ids[0], ids[1]}, status: mergeStatusForCase(detail, preview)})
	}
	result := buildMergeGroupViews(c, s, uid, projections, rowIndex, sourceIndex, taskRows)
	result.EvidenceRowCount = evidenceRowCount
	result.ConsolidatedRowCount = int64(len(selectedCaseIds))
	for _, group := range result.Items {
		if group == nil {
			continue
		}
		switch group.Status {
		case MERGE_GROUP_STATUS_PENDING, MERGE_GROUP_STATUS_DEFERRED, MERGE_GROUP_STATUS_ACTION_REQUIRED:
			result.MergeReviewCount++
		}
	}
	result.PlannedTransactionCount = result.EvidenceRowCount - result.ConsolidatedRowCount
	if result.PlannedTransactionCount < 0 {
		result.PlannedTransactionCount = 0
	}
	openTodos, err := s.listAllTodos(c, uid, taskId, TODO_STATUS_OPEN)
	if err != nil {
		return nil, err
	}
	for _, todo := range openTodos {
		if todo == nil {
			continue
		}
		switch todo.TodoKind {
		case TODO_KIND_UNCATEGORIZED:
			result.CategoryReviewCount++
		case TODO_KIND_CROSS_SOURCE_AMBIGUOUS:
			// MergeReviewCount uses connected task groups, not raw-row todo count.
		default:
			result.OtherReviewCount++
		}
	}
	result.EvidenceRows, result.Transactions = buildTransactionPlanViews(rowIndex, sourceIndex, taskRows, details, selectedCaseIds, openTodos)
	if int64(len(result.EvidenceRows)) != result.EvidenceRowCount || int64(len(result.Transactions)) != result.PlannedTransactionCount {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	return result, nil
}

func buildTransactionPlanViews(rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType, taskRows map[int64]struct{}, details []*reconciliation.CaseDetail, selectedCaseIds map[int64]struct{}, openTodos []*Todo) ([]*MergeGroupRowView, []*PlannedTransactionView) {
	evidence := make([]*MergeGroupRowView, 0, len(taskRows))
	for rowId := range taskRows {
		row := rows[rowId]
		if isBillflowEconomicEvidenceRow(row) {
			evidence = append(evidence, &MergeGroupRowView{TodoMatchView: planTodoMatchView(row, sources[rowId]), InTask: true})
		}
	}
	sortPlanRows(evidence)
	categoryRows := make(map[int64]struct{})
	relationRows := make(map[int64]struct{})
	for _, todo := range openTodos {
		if todo == nil || todo.SubjectKind != SUBJECT_KIND_RAW_ROW {
			continue
		}
		if todo.TodoKind == TODO_KIND_UNCATEGORIZED {
			categoryRows[todo.SubjectId] = struct{}{}
		} else if todo.TodoKind != TODO_KIND_CROSS_SOURCE_AMBIGUOUS {
			relationRows[todo.SubjectId] = struct{}{}
		}
	}
	detailById := make(map[int64]*reconciliation.CaseDetail)
	for _, detail := range details {
		if detail != nil {
			detailById[detail.CaseId] = detail
		}
	}
	consumed := make(map[int64]struct{})
	transactions := make([]*PlannedTransactionView, 0, len(evidence))
	for caseId := range selectedCaseIds {
		detail := detailById[caseId]
		ids := caseRepresentativeRowIDs(detail, rows, taskRows)
		if len(ids) != 2 {
			continue
		}
		inTaskIds := make([]int64, 0, 2)
		views := make([]*MergeGroupRowView, 0, 2)
		for _, rowId := range ids {
			_, inTask := taskRows[rowId]
			if inTask {
				consumed[rowId] = struct{}{}
				inTaskIds = append(inTaskIds, rowId)
			}
			if row := rows[rowId]; row != nil {
				views = append(views, &MergeGroupRowView{TodoMatchView: planTodoMatchView(row, sources[rowId]), InTask: inTask})
			}
		}
		if len(inTaskIds) != 2 {
			continue
		}
		canonicalId := preferredPlanRowId(ids, sources)
		transactions = append(transactions, plannedTransactionView(inTaskIds, canonicalId, views, categoryRows, relationRows))
	}
	for rowId := range taskRows {
		if _, exists := consumed[rowId]; exists {
			continue
		}
		row := rows[rowId]
		if !isBillflowEconomicEvidenceRow(row) {
			continue
		}
		view := &MergeGroupRowView{TodoMatchView: planTodoMatchView(row, sources[rowId]), InTask: true}
		transactions = append(transactions, plannedTransactionView([]int64{rowId}, rowId, []*MergeGroupRowView{view}, categoryRows, relationRows))
	}
	sort.SliceStable(transactions, func(i, j int) bool {
		left, right := int64(0), int64(0)
		if transactions[i].UnixTime != nil {
			left = *transactions[i].UnixTime
		}
		if transactions[j].UnixTime != nil {
			right = *transactions[j].UnixTime
		}
		if left != right {
			return left > right
		}
		return transactions[i].TransactionKey < transactions[j].TransactionKey
	})
	return evidence, transactions
}

func preferredPlanRowId(ids []int64, sources map[int64]importing.SourceType) int64 {
	for _, source := range []importing.SourceType{importing.SOURCE_TYPE_ALIPAY, importing.SOURCE_TYPE_WECHAT, importing.SOURCE_TYPE_BANK} {
		for _, rowId := range ids {
			if sources[rowId] == source {
				return rowId
			}
		}
	}
	if len(ids) > 0 {
		return ids[0]
	}
	return 0
}

func plannedTransactionView(rowIds []int64, canonicalId int64, evidence []*MergeGroupRowView, categoryRows map[int64]struct{}, relationRows map[int64]struct{}) *PlannedTransactionView {
	canonical := &TodoMatchView{}
	needsCategory := false
	needsRelation := false
	for _, row := range evidence {
		if row != nil && row.TodoMatchView != nil && row.RowId == canonicalId {
			canonical = row.TodoMatchView
		}
	}
	for _, rowId := range rowIds {
		if _, exists := categoryRows[rowId]; exists {
			needsCategory = true
		}
		if _, exists := relationRows[rowId]; exists {
			needsRelation = true
		}
	}
	sortedIds := append([]int64(nil), rowIds...)
	sort.Slice(sortedIds, func(i, j int) bool { return sortedIds[i] < sortedIds[j] })
	return &PlannedTransactionView{
		TransactionKey: mergeGroupId(sortedIds), TodoMatchView: canonical,
		EvidenceCount: int64(len(evidence)), EvidenceRows: evidence,
		NeedsCategory: needsCategory, NeedsRelation: needsRelation, Ready: !needsRelation,
	}
}

func planTodoMatchView(row *importing.RawImportRow, source importing.SourceType) *TodoMatchView {
	view := &TodoMatchView{RowId: row.RowId, SourceType: string(source), Currency: row.Currency, Direction: string(row.NormalizedDirection)}
	view.UnixTime = cloneUnixTime(row.NormalizedUnixTime)
	if row.NormalizedAmount != nil {
		view.Amount = strconv.FormatInt(*row.NormalizedAmount, 10)
	}
	view.Label = todoPreviewLabel(row)
	view.Item = todoPreviewItem(row)
	view.BillType = maskedCategoryAliasDisplay(row.RawTransactionType)
	view.Account = importing.QualifiedPaymentAccountDisplayName(source, row.RawPaymentMethod)
	view.OrderId = strings.TrimSpace(row.SourceOrderId)
	view.MerchantOrderId = strings.TrimSpace(row.SourceMerchantOrderId)
	return view
}

func sortPlanRows(rows []*MergeGroupRowView) {
	sort.SliceStable(rows, func(i, j int) bool {
		left, right := int64(0), int64(0)
		if rows[i] != nil && rows[i].UnixTime != nil {
			left = *rows[i].UnixTime
		}
		if rows[j] != nil && rows[j].UnixTime != nil {
			right = *rows[j].UnixTime
		}
		if left != right {
			return left > right
		}
		return rows[i].RowId < rows[j].RowId
	})
}

func isBillflowEconomicEvidenceRow(row *importing.RawImportRow) bool {
	if row == nil || row.ProcessingState == importing.PROCESSING_STATE_IGNORED || row.ProcessingState == importing.PROCESSING_STATE_FAILED ||
		row.ParseState != importing.PARSE_STATE_VALID || row.EconomicEffect == importing.ECONOMIC_EFFECT_CLOSED ||
		row.Disposition == importing.IMPORT_DISPOSITION_NON_POSTABLE {
		return false
	}
	return !strings.Contains(strings.TrimSpace(row.RawStatus), "失败")
}

func (s *Service) previewMergeSelections(c core.Context, uid int64, taskId int64) (map[int64]struct{}, map[int64]struct{}, error) {
	items, err := s.listAllTodos(c, uid, taskId, TODO_STATUS_RESOLVED)
	if err != nil {
		return nil, nil, err
	}
	rows := make(map[int64]struct{})
	cases := make(map[int64]struct{})
	for _, item := range items {
		if item == nil || item.TodoKind != TODO_KIND_CROSS_SOURCE_AMBIGUOUS || !hasReasonCode(item.ReasonCodesJson, "auto_merged") {
			continue
		}
		switch item.SubjectKind {
		case SUBJECT_KIND_RAW_ROW:
			rows[item.SubjectId] = struct{}{}
		case SUBJECT_KIND_RECONCILIATION_CASE:
			cases[item.SubjectId] = struct{}{}
		}
	}
	return rows, cases, nil
}

func mergeStatusForCase(detail *reconciliation.CaseDetail, preview bool) MergeGroupStatus {
	if detail == nil {
		return MERGE_GROUP_STATUS_ACTION_REQUIRED
	}
	if detail.Status == reconciliation.CASE_STATUS_ACTION_REQUIRED || (detail.CurrentDecisionStatus != nil && *detail.CurrentDecisionStatus == reconciliation.DECISION_STATUS_ACTION_REQUIRED) {
		return MERGE_GROUP_STATUS_ACTION_REQUIRED
	}
	if detail.Status == reconciliation.CASE_STATUS_DEFERRED || (detail.CurrentDecisionStatus != nil && *detail.CurrentDecisionStatus == reconciliation.DECISION_STATUS_DEFERRED) {
		return MERGE_GROUP_STATUS_DEFERRED
	}
	if detail.CurrentDecisionType != nil && detail.CurrentDecisionStatus != nil && *detail.CurrentDecisionStatus == reconciliation.DECISION_STATUS_APPLIED {
		switch *detail.CurrentDecisionType {
		case reconciliation.DECISION_TYPE_SAME_EVENT:
			return MERGE_GROUP_STATUS_MERGED
		case reconciliation.DECISION_TYPE_INDEPENDENT:
			return MERGE_GROUP_STATUS_INDEPENDENT
		case reconciliation.DECISION_TYPE_INTERNAL_TRANSFER:
			return MERGE_GROUP_STATUS_INTERNAL_TRANSFER
		case reconciliation.DECISION_TYPE_REFUND_REVERSAL:
			return MERGE_GROUP_STATUS_REFUND_REVERSAL
		case reconciliation.DECISION_TYPE_DEFER:
			return MERGE_GROUP_STATUS_DEFERRED
		}
	}
	// A current failed decision is historical execution evidence, not a user
	// decision. A fresh task preview may safely supersede it after the current
	// candidate rules have again selected this unique one-to-one pair.
	if preview && detail.Status == reconciliation.CASE_STATUS_OPEN {
		return MERGE_GROUP_STATUS_PREVIEW_MERGED
	}
	return MERGE_GROUP_STATUS_PENDING
}

func buildMergeGroupViews(c core.Context, s *Service, uid int64, cases []mergeCaseProjection, rows map[int64]*importing.RawImportRow, sources map[int64]importing.SourceType, taskRows map[int64]struct{}) *MergeGroupListResult {
	parent := make(map[int64]int64)
	var find func(int64) int64
	find = func(value int64) int64 {
		if parent[value] == 0 {
			parent[value] = value
		}
		if parent[value] != value {
			parent[value] = find(parent[value])
		}
		return parent[value]
	}
	union := func(left int64, right int64) {
		leftRoot, rightRoot := find(left), find(right)
		if leftRoot == rightRoot {
			return
		}
		if leftRoot < rightRoot {
			parent[rightRoot] = leftRoot
		} else {
			parent[leftRoot] = rightRoot
		}
	}
	for _, item := range cases {
		union(item.rows[0], item.rows[1])
	}
	caseGroups := make(map[int64][]mergeCaseProjection)
	rowGroups := make(map[int64]map[int64]struct{})
	for _, item := range cases {
		root := find(item.rows[0])
		caseGroups[root] = append(caseGroups[root], item)
		if rowGroups[root] == nil {
			rowGroups[root] = make(map[int64]struct{})
		}
		rowGroups[root][item.rows[0]] = struct{}{}
		rowGroups[root][item.rows[1]] = struct{}{}
	}
	result := &MergeGroupListResult{Items: make([]*MergeGroupView, 0, len(caseGroups))}
	for root, groupCases := range caseGroups {
		groupRowIds := make([]int64, 0, len(rowGroups[root]))
		for rowId := range rowGroups[root] {
			groupRowIds = append(groupRowIds, rowId)
		}
		sort.Slice(groupRowIds, func(i, j int) bool { return groupRowIds[i] < groupRowIds[j] })
		caseIds := make([]int64, 0, len(groupCases))
		reasons := make(map[string]struct{})
		for _, item := range groupCases {
			caseIds = append(caseIds, item.detail.CaseId)
			for _, reason := range item.detail.ReasonCodes {
				reasons[reason.Code] = struct{}{}
			}
		}
		sort.Slice(caseIds, func(i, j int) bool { return caseIds[i] < caseIds[j] })
		reasonCodes := make([]string, 0, len(reasons))
		for reason := range reasons {
			reasonCodes = append(reasonCodes, reason)
		}
		sort.Strings(reasonCodes)
		status, relation := aggregateMergeStatus(groupCases)
		view := &MergeGroupView{
			GroupId: mergeGroupId(groupRowIds), Status: status, RelationType: relation,
			CaseIds: caseIds, CandidateRuleVersion: reconciliation.CANDIDATE_RULE_VERSION_V5,
			ReasonCodes: reasonCodes, Rows: make([]*MergeGroupRowView, 0, len(groupRowIds)),
		}
		if len(caseIds) == 1 {
			view.PrimaryCaseId = &caseIds[0]
		}
		for _, rowId := range groupRowIds {
			row := rows[rowId]
			if row == nil {
				continue
			}
			source := sources[rowId]
			evidence := &reconciliation.CaseEvidenceSummary{RowId: rowId, SourceType: source, NormalizedAmount: row.NormalizedAmount, Currency: row.Currency, NormalizedDirection: row.NormalizedDirection, NormalizedUnixTime: row.NormalizedUnixTime}
			_, inTask := taskRows[rowId]
			view.Rows = append(view.Rows, &MergeGroupRowView{TodoMatchView: s.todoMatchView(c, uid, evidence), InTask: inTask})
		}
		sort.SliceStable(view.Rows, func(i, j int) bool {
			left, right := int64(0), int64(0)
			if view.Rows[i].UnixTime != nil {
				left = *view.Rows[i].UnixTime
			}
			if view.Rows[j].UnixTime != nil {
				right = *view.Rows[j].UnixTime
			}
			if left != right {
				return left > right
			}
			return view.Rows[i].RowId < view.Rows[j].RowId
		})
		result.Items = append(result.Items, view)
	}
	sort.Slice(result.Items, func(i, j int) bool {
		left, right := mergeGroupLatestTime(result.Items[i]), mergeGroupLatestTime(result.Items[j])
		if left != right {
			return left > right
		}
		return result.Items[i].GroupId < result.Items[j].GroupId
	})
	return result
}

func mergeGroupLatestTime(group *MergeGroupView) int64 {
	var latest int64
	if group == nil {
		return latest
	}
	for _, row := range group.Rows {
		if row != nil && row.UnixTime != nil && *row.UnixTime > latest {
			latest = *row.UnixTime
		}
	}
	return latest
}

func aggregateMergeStatus(items []mergeCaseProjection) (MergeGroupStatus, reconciliation.DecisionType) {
	if len(items) == 0 {
		return MERGE_GROUP_STATUS_PENDING, ""
	}
	status := items[0].status
	relation := mergeRelationType(items[0])
	for _, item := range items {
		if item.status == MERGE_GROUP_STATUS_ACTION_REQUIRED {
			return MERGE_GROUP_STATUS_ACTION_REQUIRED, relation
		}
		if item.status != status || mergeRelationType(item) != relation {
			return MERGE_GROUP_STATUS_PENDING, ""
		}
	}
	return status, relation
}

func mergeRelationType(item mergeCaseProjection) reconciliation.DecisionType {
	if item.detail != nil && item.detail.CurrentDecisionType != nil {
		return *item.detail.CurrentDecisionType
	}
	if item.status == MERGE_GROUP_STATUS_PREVIEW_MERGED {
		return reconciliation.DECISION_TYPE_SAME_EVENT
	}
	return ""
}

func mergeGroupId(rowIds []int64) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("billflow-merge-group-v2"))
	for _, rowId := range rowIds {
		var encoded [8]byte
		binary.BigEndian.PutUint64(encoded[:], uint64(rowId))
		_, _ = hash.Write(encoded[:])
	}
	return hex.EncodeToString(hash.Sum(nil))
}
