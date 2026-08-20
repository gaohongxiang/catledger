package billflow

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"

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
	previewSubjects, err := s.previewMergeSubjects(c, uid, taskId)
	if err != nil {
		return nil, err
	}
	projections := make([]mergeCaseProjection, 0, len(details))
	for _, detail := range details {
		ids := caseRepresentativeRowIDs(detail, rowIndex, taskRows)
		if len(ids) != 2 {
			continue
		}
		if _, left := taskRows[ids[0]]; !left {
			if _, right := taskRows[ids[1]]; !right {
				continue
			}
		}
		_, previewLeft := previewSubjects[ids[0]]
		_, previewRight := previewSubjects[ids[1]]
		preview := previewLeft || previewRight
		projections = append(projections, mergeCaseProjection{detail: detail, rows: [2]int64{ids[0], ids[1]}, status: mergeStatusForCase(detail, preview)})
	}
	return buildMergeGroupViews(c, s, uid, projections, rowIndex, sourceIndex, taskRows), nil
}

func (s *Service) previewMergeSubjects(c core.Context, uid int64, taskId int64) (map[int64]struct{}, error) {
	items, err := s.listAllTodos(c, uid, taskId, TODO_STATUS_RESOLVED)
	if err != nil {
		return nil, err
	}
	result := make(map[int64]struct{})
	for _, item := range items {
		if item != nil && item.TodoKind == TODO_KIND_CROSS_SOURCE_AMBIGUOUS && item.SubjectKind == SUBJECT_KIND_RAW_ROW && hasReasonCode(item.ReasonCodesJson, "auto_merged") {
			result[item.SubjectId] = struct{}{}
		}
	}
	return result, nil
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
	if preview && detail.Status == reconciliation.CASE_STATUS_OPEN && detail.CurrentDecisionId == nil {
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
			CaseIds: caseIds, CandidateRuleVersion: reconciliation.CANDIDATE_RULE_VERSION_V2,
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
