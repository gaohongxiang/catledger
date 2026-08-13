package reconciliation

import (
	"encoding/json"
	"fmt"
	"sort"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type caseRepository struct {
	store *datastore.DataStore
}

type caseMemberRows struct {
	member        *CaseMember
	identity      *importing.SourceIdentity
	sourceAccount *importing.SourceAccount
	rows          []*importing.RawImportRow
	limitReached  bool
}

type evidenceLinkReference struct {
	rowId                      int64
	transactionId              int64
	relationRole               string
	creationMethod             string
	ruleVersion                string
	transactionUpdatedUnixTime int64
	groupId                    int64
	origin                     string
}

func newCaseRepository(store *datastore.DataStore) (*caseRepository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("reconciliation case repository requires a user data store")
	}
	return &caseRepository{store: store}, nil
}

func (r *caseRepository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("reconciliation case repository requires a positive uid")
	}
	return r.store.Choose(uid), nil
}

func (r *caseRepository) listCases(c core.Context, uid int64, status CaseStatus, cursor *CaseCursor, limit int) (*CasePage, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()

	cases := make([]*Case, 0, limit+1)
	query := sess.Where("uid=? AND status=?", uid, status)
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND case_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.CaseId)
	}
	if err := query.Desc("updated_unix_time", "case_id").Limit(limit + 1).Find(&cases); err != nil {
		return nil, fmt.Errorf("list reconciliation cases: %w", err)
	}

	hasMore := len(cases) > limit
	if hasMore {
		cases = cases[:limit]
	}
	items := make([]*CaseSummary, 0, len(cases))
	for _, value := range cases {
		summary, err := newCaseSummary(value)
		if err != nil {
			return nil, err
		}
		items = append(items, summary)
	}

	page := &CasePage{Items: items}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		page.NextCursor = &CaseCursor{UpdatedUnixTime: last.UpdatedUnixTime, CaseId: last.CaseId}
	}
	return page, nil
}

func (r *caseRepository) getCase(c core.Context, uid int64, caseId int64) (*CaseDetail, error) {
	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()

	caseRecord := new(Case)
	found, err := sess.Where("uid=? AND case_id=?", uid, caseId).Get(caseRecord)
	if err != nil {
		return nil, fmt.Errorf("find reconciliation case: %w", err)
	}
	if !found {
		return nil, nil
	}

	members, err := loadCaseMemberRows(sess, uid, caseRecord, caseDetailRowsPerMemberLimit)
	if err != nil {
		return nil, err
	}
	rowIds := memberRowIds(members)
	links, relationshipLimitReached, err := loadEvidenceLinkReferences(sess, uid, rowIds, caseDetailRelationshipLimit)
	if err != nil {
		return nil, err
	}
	linksByRow := make(map[int64][]*evidenceLinkReference)
	for _, link := range links {
		linksByRow[link.rowId] = append(linksByRow[link.rowId], link)
	}

	batchIds := make([]int64, 0, len(rowIds))
	for _, member := range members {
		for _, row := range member.rows {
			batchIds = append(batchIds, row.BatchId)
		}
	}
	batches, files, err := loadEvidenceBatchesAndFiles(sess, uid, batchIds)
	if err != nil {
		return nil, err
	}

	details := make([]*CaseMemberDetail, 0, len(members))
	for _, member := range members {
		detail := &CaseMemberDetail{
			MemberId:             member.member.MemberId,
			MemberOrder:          member.member.MemberOrder,
			MemberKind:           member.member.MemberKind,
			MemberRole:           member.member.MemberRole,
			SourceType:           member.sourceAccount.SourceType,
			MaskedSourceAccount:  member.sourceAccount.MaskedDisplayName,
			EvidenceLimitReached: member.limitReached,
			Evidence:             make([]*CaseEvidenceSummary, 0, len(member.rows)),
		}
		for _, row := range member.rows {
			batch := batches[row.BatchId]
			file := files[batch.FileId]
			evidence := &CaseEvidenceSummary{
				RowId:                       row.RowId,
				BatchId:                     row.BatchId,
				RowNumber:                   row.RowNumber,
				SourceType:                  batch.SourceTypeSnapshot,
				FileExtension:               file.FileExtension,
				NormalizedUnixTime:          cloneInt64(row.NormalizedUnixTime),
				NormalizedTimezoneUtcOffset: cloneInt16(row.NormalizedTimezoneUtcOffset),
				NormalizedAmount:            cloneInt64(row.NormalizedAmount),
				Currency:                    row.Currency,
				NormalizedDirection:         row.NormalizedDirection,
				NormalizedTransactionType:   row.NormalizedTransactionType,
				EconomicEffect:              row.EconomicEffect,
				ParseState:                  row.ParseState,
				IdentityState:               row.IdentityState,
				Disposition:                 row.Disposition,
				ProcessingState:             row.ProcessingState,
				Transactions:                make([]*CaseTransactionReference, 0, len(linksByRow[row.RowId])),
			}
			for _, link := range linksByRow[row.RowId] {
				evidence.Transactions = append(evidence.Transactions, &CaseTransactionReference{
					TransactionId:              link.transactionId,
					RelationRole:               link.relationRole,
					CreationMethod:             link.creationMethod,
					RuleVersion:                link.ruleVersion,
					TransactionUpdatedUnixTime: link.transactionUpdatedUnixTime,
				})
			}
			detail.Evidence = append(detail.Evidence, evidence)
		}
		details = append(details, detail)
	}

	summary, err := newCaseSummary(caseRecord)
	if err != nil {
		return nil, err
	}
	return &CaseDetail{CaseSummary: summary, Members: details, RelationshipLimitReached: relationshipLimitReached}, nil
}

func newCaseSummary(value *Case) (*CaseSummary, error) {
	if value == nil || value.CaseId < 1 || value.Uid < 1 || !isCaseStatus(value.Status) || value.Version < 1 || value.MemberCount != 2 {
		return nil, fmt.Errorf("reconciliation case invariant mismatch")
	}
	reasons := make([]CaseReason, 0)
	if len(value.ReasonCodesJson) > 4096 || json.Unmarshal([]byte(value.ReasonCodesJson), &reasons) != nil {
		return nil, fmt.Errorf("decode reconciliation case reasons")
	}
	for _, reason := range reasons {
		if err := validateSafeReasonCode(reason.Code); err != nil {
			return nil, err
		}
	}
	return &CaseSummary{
		CaseId:                value.CaseId,
		Status:                value.Status,
		Version:               value.Version,
		MemberCount:           value.MemberCount,
		SuggestedRelationType: value.SuggestedRelationType,
		CandidateScore:        value.CandidateScore,
		ReasonCodes:           reasons,
		CurrentDecisionId:     cloneInt64(value.CurrentDecisionId),
		CreatedUnixTime:       value.CreatedUnixTime,
		LastEvaluatedUnixTime: value.LastEvaluatedUnixTime,
		UpdatedUnixTime:       value.UpdatedUnixTime,
	}, nil
}

func loadCaseMemberRows(sess *xorm.Session, uid int64, caseRecord *Case, limit int) ([]*caseMemberRows, error) {
	if sess == nil || uid < 1 || caseRecord == nil || caseRecord.Uid != uid || caseRecord.MemberCount != 2 || limit < 1 {
		return nil, fmt.Errorf("invalid reconciliation case member query")
	}
	members := make([]*CaseMember, 0, 2)
	if err := sess.Where("uid=? AND case_id=?", uid, caseRecord.CaseId).Asc("member_order").Find(&members); err != nil {
		return nil, fmt.Errorf("list reconciliation case members: %w", err)
	}
	if len(members) != 2 {
		return nil, fmt.Errorf("reconciliation case member invariant mismatch")
	}

	result := make([]*caseMemberRows, 0, 2)
	for index, member := range members {
		if member == nil || member.Uid != uid || member.CaseId != caseRecord.CaseId || member.MemberOrder != int64(index+1) || member.MemberRefId < 1 {
			return nil, fmt.Errorf("reconciliation case member invariant mismatch")
		}
		entry := &caseMemberRows{member: member}
		switch member.MemberKind {
		case MEMBER_KIND_SOURCE_IDENTITY:
			identity := new(importing.SourceIdentity)
			found, err := sess.Where("uid=? AND identity_id=?", uid, member.MemberRefId).Get(identity)
			if err != nil || !found || identity.SourceAccountId < 1 || identity.IdentityKind == importing.IDENTITY_KIND_BATCH_LOCAL {
				return nil, fmt.Errorf("reconciliation source identity invariant mismatch")
			}
			entry.identity = identity
			if err = sess.Where("uid=? AND identity_id=?", uid, identity.IdentityId).Desc("created_unix_time", "row_id").Limit(limit + 1).Find(&entry.rows); err != nil {
				return nil, fmt.Errorf("list reconciliation identity rows: %w", err)
			}
			entry.sourceAccount = new(importing.SourceAccount)
			found, err = sess.Where("uid=? AND source_account_id=?", uid, identity.SourceAccountId).Get(entry.sourceAccount)
			if err != nil || !found {
				return nil, fmt.Errorf("reconciliation source account invariant mismatch")
			}
		case MEMBER_KIND_RAW_ROW:
			row := new(importing.RawImportRow)
			found, err := sess.Where("uid=? AND row_id=?", uid, member.MemberRefId).Get(row)
			if err != nil || !found || row.IdentityState != importing.IDENTITY_STATE_BATCH_LOCAL {
				return nil, fmt.Errorf("reconciliation batch-local member invariant mismatch")
			}
			entry.rows = []*importing.RawImportRow{row}
			batch := new(importing.ImportBatch)
			found, err = sess.Where("uid=? AND batch_id=?", uid, row.BatchId).Get(batch)
			if err != nil || !found || batch.SourceAccountId == nil || *batch.SourceAccountId < 1 {
				return nil, fmt.Errorf("reconciliation batch-local source invariant mismatch")
			}
			entry.sourceAccount = new(importing.SourceAccount)
			found, err = sess.Where("uid=? AND source_account_id=?", uid, *batch.SourceAccountId).Get(entry.sourceAccount)
			if err != nil || !found {
				return nil, fmt.Errorf("reconciliation source account invariant mismatch")
			}
		default:
			return nil, fmt.Errorf("invalid reconciliation member kind")
		}
		if len(entry.rows) == 0 {
			return nil, fmt.Errorf("reconciliation member has no evidence rows")
		}
		if len(entry.rows) > limit {
			entry.rows = entry.rows[:limit]
			entry.limitReached = true
		}
		result = append(result, entry)
	}
	if result[0].sourceAccount.SourceAccountId == result[1].sourceAccount.SourceAccountId {
		return nil, fmt.Errorf("reconciliation members share a source account")
	}
	return result, nil
}

func memberRowIds(members []*caseMemberRows) []int64 {
	seen := make(map[int64]struct{})
	result := make([]int64, 0)
	for _, member := range members {
		for _, row := range member.rows {
			if _, exists := seen[row.RowId]; !exists {
				seen[row.RowId] = struct{}{}
				result = append(result, row.RowId)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func loadEvidenceLinkReferences(sess *xorm.Session, uid int64, rowIds []int64, limit int) ([]*evidenceLinkReference, bool, error) {
	if sess == nil || uid < 1 || limit < 1 {
		return nil, false, fmt.Errorf("invalid reconciliation evidence link query")
	}
	if len(rowIds) == 0 {
		return []*evidenceLinkReference{}, false, nil
	}

	legacy := make([]*importing.RawRowTransactionLink, 0)
	if err := sess.Where("uid=?", uid).In("row_id", rowIds).Asc("link_id").Limit(limit + 1).Find(&legacy); err != nil {
		return nil, false, fmt.Errorf("list posting evidence links: %w", err)
	}
	result := make([]*evidenceLinkReference, 0, len(legacy))
	for _, link := range legacy {
		result = append(result, &evidenceLinkReference{
			rowId: link.RowId, transactionId: link.TransactionId,
			relationRole: string(link.RelationRole), creationMethod: string(link.CreationMethod),
			ruleVersion: string(link.RuleVersion), transactionUpdatedUnixTime: link.TransactionUpdatedUnixTime,
			groupId: link.PostingId, origin: "v002",
		})
	}

	active := make([]*TransactionLink, 0)
	query := sess.Table(new(TransactionLink)).Alias("l").
		Join("INNER", "pf_reconciliation_decision", "pf_reconciliation_decision.uid=l.uid AND pf_reconciliation_decision.decision_id=l.decision_id").
		Join("INNER", "pf_reconciliation_case", "pf_reconciliation_case.uid=l.uid AND pf_reconciliation_case.current_decision_id=l.decision_id").
		Where("l.uid=? AND pf_reconciliation_decision.uid=? AND pf_reconciliation_case.uid=?", uid, uid, uid).
		In("l.row_id", rowIds).Asc("l.link_id").Limit(limit + 1)
	if err := query.Find(&active); err != nil {
		return nil, false, fmt.Errorf("list active reconciliation evidence links: %w", err)
	}
	for _, link := range active {
		result = append(result, &evidenceLinkReference{
			rowId: link.RowId, transactionId: link.TransactionId,
			relationRole: string(link.RelationRole), creationMethod: string(link.CreationMethod),
			ruleVersion: string(link.RuleVersion), transactionUpdatedUnixTime: link.TransactionUpdatedUnixTime,
			groupId: link.DecisionId, origin: "v003",
		})
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].rowId != result[j].rowId {
			return result[i].rowId < result[j].rowId
		}
		if result[i].transactionId != result[j].transactionId {
			return result[i].transactionId < result[j].transactionId
		}
		if result[i].relationRole != result[j].relationRole {
			return result[i].relationRole < result[j].relationRole
		}
		if result[i].origin != result[j].origin {
			return result[i].origin < result[j].origin
		}
		return result[i].groupId < result[j].groupId
	})
	limitReached := len(result) > limit || len(legacy) > limit || len(active) > limit
	if len(result) > limit {
		result = result[:limit]
	}
	return result, limitReached, nil
}

func loadEvidenceBatchesAndFiles(sess *xorm.Session, uid int64, batchIds []int64) (map[int64]*importing.ImportBatch, map[int64]*importing.ImportFile, error) {
	uniqueBatches := make(map[int64]struct{})
	for _, id := range batchIds {
		if id > 0 {
			uniqueBatches[id] = struct{}{}
		}
	}
	ids := make([]int64, 0, len(uniqueBatches))
	for id := range uniqueBatches {
		ids = append(ids, id)
	}
	batchesSlice := make([]*importing.ImportBatch, 0, len(ids))
	if len(ids) > 0 {
		if err := sess.Where("uid=?", uid).In("batch_id", ids).Find(&batchesSlice); err != nil {
			return nil, nil, fmt.Errorf("load reconciliation evidence batches: %w", err)
		}
	}
	batches := make(map[int64]*importing.ImportBatch, len(batchesSlice))
	fileSet := make(map[int64]struct{})
	for _, batch := range batchesSlice {
		batches[batch.BatchId] = batch
		fileSet[batch.FileId] = struct{}{}
	}
	if len(batches) != len(ids) {
		return nil, nil, fmt.Errorf("reconciliation evidence batch invariant mismatch")
	}
	fileIds := make([]int64, 0, len(fileSet))
	for id := range fileSet {
		fileIds = append(fileIds, id)
	}
	filesSlice := make([]*importing.ImportFile, 0, len(fileIds))
	if len(fileIds) > 0 {
		if err := sess.Where("uid=?", uid).In("file_id", fileIds).Find(&filesSlice); err != nil {
			return nil, nil, fmt.Errorf("load reconciliation evidence files: %w", err)
		}
	}
	files := make(map[int64]*importing.ImportFile, len(filesSlice))
	for _, file := range filesSlice {
		files[file.FileId] = file
	}
	if len(files) != len(fileIds) {
		return nil, nil, fmt.Errorf("reconciliation evidence file invariant mismatch")
	}
	return batches, files, nil
}
