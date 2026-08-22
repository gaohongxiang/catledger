package organizer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	planCrossSourceWindowSeconds = int64(72 * 60 * 60)
	minimumStableReferenceRunes  = 6
)

const (
	reasonAlreadyPosted            = "already_posted"
	reasonAutoRefundRelation       = "auto_refund_relation"
	reasonAutoRepaymentPair        = "auto_repayment_pair"
	reasonAutoSameEvent            = "auto_same_event"
	reasonAutoTransferPair         = "auto_transfer_pair"
	reasonCategoryUnclassified     = "category_unclassified"
	reasonCoreFieldsConflict       = "core_fields_conflict"
	reasonCoreFieldsMissing        = "core_fields_missing"
	reasonEconomicNatureRequired   = "economic_nature_required"
	reasonEvidenceExcluded         = "evidence_excluded"
	reasonIdentityConflict         = "identity_conflict"
	reasonIdentityReviewRequired   = "identity_review_required"
	reasonLedgerAccountRequired    = "ledger_account_required"
	reasonRefundAmountExceeded     = "refund_amount_exceeded"
	reasonRefundRelationAmbiguous  = "refund_relation_ambiguous"
	reasonRefundRelationRequired   = "refund_relation_required"
	reasonRelationAmbiguous        = "relation_ambiguous"
	reasonRepaymentAccountRequired = "repayment_account_required"
	reasonTransferAccountRequired  = "transfer_account_required"
)

// PlanningSource 把一次更新冻结的来源快照与不可变解析证据交给规划器。
type PlanningSource struct {
	Source *FinanceUpdateSource
	Batch  *importing.ImportBatch
	Rows   []*importing.RawImportRow
}

// OrganizePlan 是同一后端计划产生的事件、证据、关系和守恒计数。
type OrganizePlan struct {
	Events                 []*EconomicEvent
	Evidence               []*EconomicEventEvidence
	Relations              []*EconomicEventRelation
	SourceCount            int64
	ValidEvidenceCount     int64
	DuplicateEvidenceCount int64
	FinalEventCount        int64
	ReadyEventCount        int64
	NeedsActionEventCount  int64
	ExcludedEventCount     int64
}

type planIdentifierGenerator func() int64

type planningRow struct {
	row     *importing.RawImportRow
	source  *PlanningSource
	account *models.Account
}

type planningGroup struct {
	rows         []*planningRow
	pairedNature EconomicNature
	sameEvent    bool
	ambiguous    bool
}

type groupSummary struct {
	representative *planningRow
	accountId      int64
	amount         int64
	currency       string
	direction      importing.NormalizedDirection
	unixTime       int64
	complete       bool
	conflict       bool
}

type plannedEvent struct {
	event *EconomicEvent
	group *planningGroup
}

type checkedIdentifierGenerator struct {
	next planIdentifierGenerator
	seen map[int64]struct{}
}

// BuildOrganizePlan 是无数据库副作用的统一整理入口。原始文本只参与内存比较，持久结果仅保存稳定代码和行 ID。
func BuildOrganizePlan(uid int64, updateId int64, sources []*PlanningSource, accounts map[int64]*models.Account, now int64, generateId func() int64) (*OrganizePlan, error) {
	if uid < 1 || updateId < 1 || now < 1 || generateId == nil {
		return nil, fmt.Errorf("invalid organizer planning request")
	}
	rows, err := validatePlanningSources(uid, updateId, sources, accounts)
	if err != nil {
		return nil, err
	}
	groups := buildIdentityGroups(rows)
	groups = mergeStrongSameEvents(groups)
	groups = pairTransfersAndRepayments(groups)

	ids := &checkedIdentifierGenerator{next: generateId, seen: make(map[int64]struct{})}
	plan := &OrganizePlan{SourceCount: int64(len(sources)), ValidEvidenceCount: int64(len(rows))}
	planned := make([]*plannedEvent, 0, len(groups))
	for _, group := range groups {
		item, evidence, buildErr := buildPlannedEvent(uid, updateId, group, now, ids)
		if buildErr != nil {
			return nil, buildErr
		}
		planned = append(planned, item)
		plan.Events = append(plan.Events, item.event)
		plan.Evidence = append(plan.Evidence, evidence...)
		plan.DuplicateEvidenceCount += int64(len(group.rows) - 1)
	}
	if err = resolveRefundRelations(uid, updateId, planned, plan, now, ids); err != nil {
		return nil, err
	}

	sort.Slice(plan.Events, func(i, j int) bool {
		left, right := plan.Events[i], plan.Events[j]
		if pointerInt64Value(left.EventUnixTime) != pointerInt64Value(right.EventUnixTime) {
			return pointerInt64Value(left.EventUnixTime) < pointerInt64Value(right.EventUnixTime)
		}
		return left.EventId < right.EventId
	})
	sort.Slice(plan.Evidence, func(i, j int) bool { return plan.Evidence[i].RowId < plan.Evidence[j].RowId })
	sort.Slice(plan.Relations, func(i, j int) bool { return plan.Relations[i].RelationId < plan.Relations[j].RelationId })
	plan.FinalEventCount = int64(len(plan.Events))
	for _, event := range plan.Events {
		switch event.Status {
		case EVENT_STATUS_READY:
			plan.ReadyEventCount++
		case EVENT_STATUS_NEEDS_ACTION:
			plan.NeedsActionEventCount++
		case EVENT_STATUS_EXCLUDED:
			plan.ExcludedEventCount++
		default:
			return nil, fmt.Errorf("organizer planner produced invalid initial event status")
		}
	}
	if plan.ValidEvidenceCount-plan.DuplicateEvidenceCount != plan.FinalEventCount ||
		plan.FinalEventCount != plan.ReadyEventCount+plan.NeedsActionEventCount+plan.ExcludedEventCount {
		return nil, fmt.Errorf("organizer planner conservation mismatch")
	}
	return plan, nil
}

func validatePlanningSources(uid int64, updateId int64, sources []*PlanningSource, accounts map[int64]*models.Account) ([]*planningRow, error) {
	rows := make([]*planningRow, 0)
	seenSources := make(map[int64]struct{})
	seenBatches := make(map[int64]struct{})
	seenRows := make(map[int64]struct{})
	for index, item := range sources {
		if item == nil || item.Source == nil || item.Batch == nil || item.Source.Uid != uid || item.Source.UpdateId != updateId ||
			item.Source.SourceOrder != int64(index) || item.Source.SourceId < 1 || item.Source.BatchId < 1 || item.Source.FileId < 1 ||
			item.Batch.Uid != uid || item.Batch.BatchId != item.Source.BatchId || item.Batch.FileId != item.Source.FileId ||
			item.Batch.SourceTypeSnapshot != importing.SourceType(item.Source.SourceTypeSnapshot) ||
			item.Batch.ParserVersion != importing.RuleVersion(item.Source.ParserVersion) ||
			item.Batch.NormalizationVersion != importing.RuleVersion(item.Source.NormalizationVersion) ||
			item.Batch.IdentityKeyVersion != importing.RuleVersion(item.Source.IdentityKeyVersion) {
			return nil, fmt.Errorf("organizer source snapshot mismatch")
		}
		if _, exists := seenSources[item.Source.SourceId]; exists {
			return nil, fmt.Errorf("duplicate organizer source")
		}
		if _, exists := seenBatches[item.Source.BatchId]; exists {
			return nil, fmt.Errorf("duplicate organizer batch")
		}
		seenSources[item.Source.SourceId] = struct{}{}
		seenBatches[item.Source.BatchId] = struct{}{}
		for _, row := range item.Rows {
			if row == nil || row.Uid != uid || row.BatchId != item.Source.BatchId || row.RowId < 1 {
				return nil, fmt.Errorf("organizer evidence owner mismatch")
			}
			if _, exists := seenRows[row.RowId]; exists {
				return nil, fmt.Errorf("duplicate organizer evidence row")
			}
			seenRows[row.RowId] = struct{}{}
			if row.ParseState != importing.PARSE_STATE_VALID {
				continue
			}
			var account *models.Account
			if row.LedgerAccountId != nil && *row.LedgerAccountId > 0 {
				account = accounts[*row.LedgerAccountId]
				if account == nil || account.Uid != uid || account.AccountId != *row.LedgerAccountId || account.Deleted {
					account = nil
				}
			}
			rows = append(rows, &planningRow{row: row, source: item, account: account})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].row.RowId < rows[j].row.RowId })
	return rows, nil
}

func buildIdentityGroups(rows []*planningRow) []*planningGroup {
	byKey := make(map[string]*planningGroup)
	keys := make([]string, 0)
	for _, item := range rows {
		key := identityGroupKey(item.row)
		group := byKey[key]
		if group == nil {
			group = &planningGroup{}
			byKey[key] = group
			keys = append(keys, key)
		}
		group.rows = append(group.rows, item)
	}
	sort.Strings(keys)
	groups := make([]*planningGroup, 0, len(keys))
	for _, key := range keys {
		groups = append(groups, byKey[key])
	}
	return groups
}

func identityGroupKey(row *importing.RawImportRow) string {
	if row.IdentityId != nil && *row.IdentityId > 0 {
		return "identity:" + strconv.FormatInt(*row.IdentityId, 10)
	}
	if isLowerHexSHA256(row.ObservedSourceIdentityKey) {
		return "observed:" + row.ObservedSourceIdentityKey
	}
	return "row:" + strconv.FormatInt(row.RowId, 10)
}

func mergeStrongSameEvents(groups []*planningGroup) []*planningGroup {
	if len(groups) < 2 {
		return groups
	}
	parent := newGroupUnion(len(groups))
	byReference := make(map[string][]int)
	for index, group := range groups {
		for reference := range groupStableReferences(group) {
			byReference[reference] = append(byReference[reference], index)
		}
	}
	for _, indexes := range byReference {
		if len(indexes) < 2 {
			continue
		}
		compatible := true
		for left := 0; left < len(indexes) && compatible; left++ {
			for right := left + 1; right < len(indexes); right++ {
				if !sameEventCompatible(groups[indexes[left]], groups[indexes[right]]) {
					compatible = false
					break
				}
			}
		}
		if compatible {
			for index := 1; index < len(indexes); index++ {
				parent.union(indexes[0], indexes[index])
			}
		}
	}
	return compactPlanningGroups(groups, parent, nil, nil)
}

func pairTransfersAndRepayments(groups []*planningGroup) []*planningGroup {
	if len(groups) < 2 {
		return groups
	}
	candidates := make([][]int, len(groups))
	natures := make(map[[2]int]EconomicNature)
	for left := 0; left < len(groups); left++ {
		for right := left + 1; right < len(groups); right++ {
			nature, matched := transferPairNature(groups[left], groups[right])
			if !matched {
				continue
			}
			candidates[left] = append(candidates[left], right)
			candidates[right] = append(candidates[right], left)
			natures[[2]int{left, right}] = nature
		}
	}
	parent := newGroupUnion(len(groups))
	pairNature := make(map[int]EconomicNature)
	ambiguous := make(map[int]bool)
	for index, matches := range candidates {
		if len(matches) > 1 {
			ambiguous[index] = true
			continue
		}
		if len(matches) != 1 {
			continue
		}
		other := matches[0]
		if len(candidates[other]) != 1 || candidates[other][0] != index || index > other {
			if len(candidates[other]) != 1 {
				ambiguous[index] = true
			}
			continue
		}
		key := [2]int{index, other}
		if index > other {
			key = [2]int{other, index}
		}
		parent.union(index, other)
		pairNature[parent.find(index)] = natures[key]
	}
	return compactPlanningGroups(groups, parent, pairNature, ambiguous)
}

func sameEventCompatible(left *planningGroup, right *planningGroup) bool {
	leftSummary, rightSummary := summarizeGroup(left), summarizeGroup(right)
	if !leftSummary.complete || !rightSummary.complete || leftSummary.conflict || rightSummary.conflict ||
		leftSummary.accountId != rightSummary.accountId || leftSummary.amount != rightSummary.amount ||
		leftSummary.currency != rightSummary.currency || leftSummary.direction != rightSummary.direction ||
		absoluteDifference(leftSummary.unixTime, rightSummary.unixTime) > planCrossSourceWindowSeconds ||
		leftSummary.direction == importing.NORMALIZED_DIRECTION_UNKNOWN || leftSummary.direction == importing.NORMALIZED_DIRECTION_NEUTRAL {
		return false
	}
	if groupsShareSourceAccount(left, right) {
		return false
	}
	return groupsHaveCompatiblePaymentSemantics(left, right)
}

func transferPairNature(left *planningGroup, right *planningGroup) (EconomicNature, bool) {
	leftSummary, rightSummary := summarizeGroup(left), summarizeGroup(right)
	if !leftSummary.complete || !rightSummary.complete || leftSummary.conflict || rightSummary.conflict ||
		leftSummary.accountId == rightSummary.accountId || leftSummary.amount != rightSummary.amount ||
		leftSummary.currency != rightSummary.currency || absoluteDifference(leftSummary.unixTime, rightSummary.unixTime) > planCrossSourceWindowSeconds ||
		!oppositeDirections(leftSummary.direction, rightSummary.direction) {
		return "", false
	}
	outflow, inflow := left, right
	outflowSummary, inflowSummary := leftSummary, rightSummary
	if leftSummary.direction == importing.NORMALIZED_DIRECTION_INCOME {
		outflow, inflow = right, left
		outflowSummary, inflowSummary = rightSummary, leftSummary
	}
	if isRepaymentGroup(inflow) && accountIsAsset(outflowSummary.representative.account) && accountIsLiability(inflowSummary.representative.account) {
		return ECONOMIC_NATURE_REPAYMENT, true
	}
	if groupTransferLike(outflow) && groupTransferLike(inflow) {
		return ECONOMIC_NATURE_INTERNAL_TRANSFER, true
	}
	return "", false
}

func compactPlanningGroups(groups []*planningGroup, parent *groupUnion, pairNatures map[int]EconomicNature, ambiguous map[int]bool) []*planningGroup {
	byRoot := make(map[int]*planningGroup)
	memberCounts := make(map[int]int)
	order := make([]int, 0)
	for index, group := range groups {
		root := parent.find(index)
		merged := byRoot[root]
		if merged == nil {
			merged = &planningGroup{}
			byRoot[root] = merged
			order = append(order, root)
		}
		merged.rows = append(merged.rows, group.rows...)
		merged.sameEvent = merged.sameEvent || group.sameEvent
		merged.ambiguous = merged.ambiguous || group.ambiguous || ambiguous[index]
		memberCounts[root]++
	}
	if pairNatures == nil {
		for root, count := range memberCounts {
			if count > 1 {
				byRoot[root].sameEvent = true
			}
		}
	}
	for root, nature := range pairNatures {
		byRoot[parent.find(root)].pairedNature = nature
	}
	result := make([]*planningGroup, 0, len(order))
	for _, root := range order {
		group := byRoot[root]
		sort.Slice(group.rows, func(i, j int) bool { return group.rows[i].row.RowId < group.rows[j].row.RowId })
		result = append(result, group)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].rows[0].row.RowId < result[j].rows[0].row.RowId })
	return result
}

func buildPlannedEvent(uid int64, updateId int64, group *planningGroup, now int64, ids *checkedIdentifierGenerator) (*plannedEvent, []*EconomicEventEvidence, error) {
	if group == nil || len(group.rows) < 1 {
		return nil, nil, fmt.Errorf("empty organizer planning group")
	}
	summary := summarizeGroup(group)
	representative := summary.representative
	eventId, err := ids.generate()
	if err != nil {
		return nil, nil, err
	}
	event := &EconomicEvent{
		Uid: uid, UpdateId: updateId, EventKey: eventKeyForRows(uid, updateId, group.rows), EventKeyVersion: EVENT_KEY_VERSION_V1,
		Status: EVENT_STATUS_NEEDS_ACTION, Version: 1, FlowDirection: flowDirection(summary.direction),
		EconomicNature: ECONOMIC_NATURE_UNKNOWN, RuleVersion: PLAN_VERSION_V1,
		FieldSourcesJson: fieldSourcesJSON(representative.row), ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, EventId: eventId,
	}
	if summary.accountId > 0 {
		value := summary.accountId
		event.LedgerAccountId = &value
	}
	if summary.amount >= 0 && representative.row.NormalizedAmount != nil {
		value := summary.amount
		event.Amount = &value
	}
	if summary.unixTime > 0 {
		value := summary.unixTime
		event.EventUnixTime = &value
	}
	if representative.row.NormalizedTimezoneUtcOffset != nil {
		value := *representative.row.NormalizedTimezoneUtcOffset
		event.TimezoneUtcOffset = &value
	}
	event.Currency = summary.currency

	reasons := make([]string, 0)
	if groupAllExcluded(group) {
		event.Status = EVENT_STATUS_EXCLUDED
		event.EconomicNature = excludedNature(group)
		reasons = append(reasons, reasonEvidenceExcluded)
		if groupAllLinked(group) {
			reasons = append(reasons, reasonAlreadyPosted)
		}
	} else if summary.conflict || groupHasIdentityConflict(group) {
		event.Status = EVENT_STATUS_NEEDS_ACTION
		reasons = append(reasons, reasonCoreFieldsConflict)
		if groupHasIdentityConflict(group) {
			reasons = append(reasons, reasonIdentityConflict)
		}
	} else {
		if group.sameEvent {
			reasons = append(reasons, reasonAutoSameEvent)
		}
		if !summary.complete {
			reasons = append(reasons, reasonCoreFieldsMissing)
		}
		if summary.accountId < 1 {
			reasons = append(reasons, reasonLedgerAccountRequired)
		}
		if groupNeedsIdentityReview(group) {
			reasons = append(reasons, reasonIdentityReviewRequired)
		}
		switch group.pairedNature {
		case ECONOMIC_NATURE_INTERNAL_TRANSFER, ECONOMIC_NATURE_REPAYMENT:
			configurePairedEvent(event, group, group.pairedNature)
			if group.pairedNature == ECONOMIC_NATURE_REPAYMENT {
				reasons = append(reasons, reasonAutoRepaymentPair)
			} else {
				reasons = append(reasons, reasonAutoTransferPair)
			}
		case "":
			classifySingleGroup(event, group, &reasons)
		default:
			return nil, nil, fmt.Errorf("invalid organizer paired nature")
		}
		if group.ambiguous {
			reasons = append(reasons, reasonRelationAmbiguous)
			event.Status = EVENT_STATUS_NEEDS_ACTION
		}
		if event.Status != EVENT_STATUS_NEEDS_ACTION && (event.LedgerAccountId == nil || event.EventUnixTime == nil || event.Amount == nil || event.Currency == "") {
			event.Status = EVENT_STATUS_NEEDS_ACTION
			reasons = append(reasons, reasonCoreFieldsMissing)
		}
		if event.EconomicNature == ECONOMIC_NATURE_UNKNOWN {
			event.Status = EVENT_STATUS_NEEDS_ACTION
			reasons = append(reasons, reasonEconomicNatureRequired)
		}
	}
	if event.Status == EVENT_STATUS_READY && event.CategoryId == nil && event.EconomicNature == ECONOMIC_NATURE_EXPENSE {
		reasons = append(reasons, reasonCategoryUnclassified)
	}
	event.ReasonCodesJson = reasonCodesJSON(reasons)

	evidence := make([]*EconomicEventEvidence, 0, len(group.rows))
	for index, item := range group.rows {
		evidenceId, idErr := ids.generate()
		if idErr != nil {
			return nil, nil, idErr
		}
		role := EVIDENCE_ROLE_DUPLICATE
		if index == 0 {
			role = EVIDENCE_ROLE_PRIMARY
		}
		evidence = append(evidence, &EconomicEventEvidence{
			Uid: uid, UpdateId: updateId, EventId: eventId, RowId: item.row.RowId,
			EvidenceRole: role, CreatedUnixTime: now, EvidenceId: evidenceId,
		})
	}
	return &plannedEvent{event: event, group: group}, evidence, nil
}

func classifySingleGroup(event *EconomicEvent, group *planningGroup, reasons *[]string) {
	row := summarizeGroup(group).representative.row
	switch {
	case row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND:
		event.EconomicNature = ECONOMIC_NATURE_REFUND
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonRefundRelationRequired)
	case isRepaymentGroup(group):
		event.EconomicNature = ECONOMIC_NATURE_REPAYMENT
		event.FlowDirection = FLOW_DIRECTION_NEUTRAL
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonRepaymentAccountRequired)
	case row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_FEE && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE:
		event.EconomicNature = ECONOMIC_NATURE_FEE
		event.Status = EVENT_STATUS_READY
	case row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_PAYMENT && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE:
		event.EconomicNature = ECONOMIC_NATURE_EXPENSE
		event.Status = EVENT_STATUS_READY
	case groupTransferLike(group):
		event.EconomicNature = ECONOMIC_NATURE_UNKNOWN
		event.FlowDirection = FLOW_DIRECTION_NEUTRAL
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonTransferAccountRequired)
	default:
		event.EconomicNature = ECONOMIC_NATURE_UNKNOWN
		event.Status = EVENT_STATUS_NEEDS_ACTION
	}
	if groupNeedsIdentityReview(group) {
		event.Status = EVENT_STATUS_NEEDS_ACTION
	}
}

func configurePairedEvent(event *EconomicEvent, group *planningGroup, nature EconomicNature) {
	var outflow, inflow *planningRow
	for _, item := range group.rows {
		switch item.row.NormalizedDirection {
		case importing.NORMALIZED_DIRECTION_EXPENSE:
			if outflow == nil || item.row.RowId < outflow.row.RowId {
				outflow = item
			}
		case importing.NORMALIZED_DIRECTION_INCOME:
			if inflow == nil || item.row.RowId < inflow.row.RowId {
				inflow = item
			}
		}
	}
	if outflow == nil || inflow == nil || outflow.row.LedgerAccountId == nil || inflow.row.LedgerAccountId == nil {
		event.Status = EVENT_STATUS_NEEDS_ACTION
		event.EconomicNature = nature
		return
	}
	sourceAccountId, destinationAccountId := *outflow.row.LedgerAccountId, *inflow.row.LedgerAccountId
	event.LedgerAccountId = &sourceAccountId
	event.CounterpartyLedgerAccountId = &destinationAccountId
	event.FlowDirection = FLOW_DIRECTION_NEUTRAL
	event.EconomicNature = nature
	event.Status = EVENT_STATUS_READY
	event.EventUnixTime = cloneInt64Pointer(outflow.row.NormalizedUnixTime)
	event.TimezoneUtcOffset = cloneInt16Pointer(outflow.row.NormalizedTimezoneUtcOffset)
	event.Amount = cloneInt64Pointer(outflow.row.NormalizedAmount)
	event.Currency = outflow.row.Currency
	event.FieldSourcesJson = fieldSourcesJSON(outflow.row)
}

func resolveRefundRelations(uid int64, updateId int64, planned []*plannedEvent, plan *OrganizePlan, now int64, ids *checkedIdentifierGenerator) error {
	type refundMatch struct {
		refund   *plannedEvent
		original *plannedEvent
		relation *EconomicEventRelation
	}
	matches := make([]*refundMatch, 0)
	for _, refund := range planned {
		if refund.event.EconomicNature != ECONOMIC_NATURE_REFUND || refund.event.Amount == nil || refund.event.EventUnixTime == nil || refund.event.LedgerAccountId == nil {
			continue
		}
		candidates := make([]*plannedEvent, 0)
		for _, original := range planned {
			if original == refund || original.event.EconomicNature != ECONOMIC_NATURE_EXPENSE || original.event.Status == EVENT_STATUS_EXCLUDED ||
				original.event.Amount == nil || original.event.EventUnixTime == nil || original.event.LedgerAccountId == nil ||
				*original.event.LedgerAccountId != *refund.event.LedgerAccountId || original.event.Currency != refund.event.Currency ||
				*original.event.Amount < *refund.event.Amount || *original.event.EventUnixTime > *refund.event.EventUnixTime ||
				!refundCandidateEvidenceMatch(refund.group, original.group) {
				continue
			}
			candidates = append(candidates, original)
		}
		if len(candidates) != 1 {
			reasons := decodeReasonCodes(refund.event.ReasonCodesJson)
			if len(candidates) > 1 {
				reasons = append(reasons, reasonRefundRelationAmbiguous)
			}
			refund.event.ReasonCodesJson = reasonCodesJSON(reasons)
			continue
		}
		original := candidates[0]
		relationId, err := ids.generate()
		if err != nil {
			return err
		}
		amount := *refund.event.Amount
		relation := &EconomicEventRelation{
			Uid: uid, UpdateId: updateId, RelationKey: relationKey(uid, RELATION_TYPE_REFUND_OF, refund.event.EventId, original.event.EventId),
			RelationKeyVersion: RELATION_KEY_VERSION_V1, RelationType: RELATION_TYPE_REFUND_OF,
			Status: RELATION_STATUS_CONFIRMED, Version: 1, SourceEventId: refund.event.EventId, TargetEventId: original.event.EventId,
			Amount: &amount, Currency: refund.event.Currency, RuleVersion: PLAN_VERSION_V1,
			ReasonCodesJson: reasonCodesJSON([]string{reasonAutoRefundRelation}), CreatedUnixTime: now, UpdatedUnixTime: now, RelationId: relationId,
		}
		matches = append(matches, &refundMatch{refund: refund, original: original, relation: relation})
	}

	totalByOriginal := make(map[int64]int64)
	for _, match := range matches {
		totalByOriginal[match.original.event.EventId] += *match.relation.Amount
	}
	for _, match := range matches {
		reasons := decodeReasonCodes(match.refund.event.ReasonCodesJson)
		if match.original.event.Amount == nil || totalByOriginal[match.original.event.EventId] > *match.original.event.Amount {
			match.relation.Status = RELATION_STATUS_PROPOSED
			match.relation.ReasonCodesJson = reasonCodesJSON([]string{reasonRefundAmountExceeded})
			match.refund.event.Status = EVENT_STATUS_NEEDS_ACTION
			reasons = append(reasons, reasonRefundAmountExceeded)
		} else if eventHasRequiredFields(match.refund.event) {
			match.refund.event.Status = EVENT_STATUS_READY
			reasons = removeReason(reasons, reasonRefundRelationRequired)
			reasons = append(reasons, reasonAutoRefundRelation)
		}
		match.refund.event.ReasonCodesJson = reasonCodesJSON(reasons)
		plan.Relations = append(plan.Relations, match.relation)
	}
	return nil
}

func summarizeGroup(group *planningGroup) groupSummary {
	result := groupSummary{representative: preferredPlanningRow(group.rows), amount: -1}
	if result.representative == nil {
		return result
	}
	row := result.representative.row
	if row.LedgerAccountId != nil && result.representative.account != nil {
		result.accountId = *row.LedgerAccountId
	}
	if row.NormalizedAmount != nil {
		result.amount = *row.NormalizedAmount
	}
	if row.NormalizedUnixTime != nil {
		result.unixTime = *row.NormalizedUnixTime
	}
	result.currency = row.Currency
	result.direction = row.NormalizedDirection
	result.complete = result.accountId > 0 && result.amount >= 0 && result.unixTime > 0 && len(result.currency) == 3 &&
		result.direction != importing.NORMALIZED_DIRECTION_UNKNOWN
	if result.representative.account != nil && result.currency != "" && result.representative.account.Currency != result.currency {
		result.conflict = true
	}
	for _, item := range group.rows {
		candidate := item.row
		if candidate.NormalizedAmount != nil && result.amount >= 0 && *candidate.NormalizedAmount != result.amount {
			result.conflict = true
		}
		if candidate.Currency != "" && result.currency != "" && candidate.Currency != result.currency {
			result.conflict = true
		}
		if candidate.LedgerAccountId != nil && item.account != nil && result.accountId > 0 && *candidate.LedgerAccountId != result.accountId && group.pairedNature == "" {
			result.conflict = true
		}
		if candidate.NormalizedUnixTime != nil && result.unixTime > 0 && *candidate.NormalizedUnixTime != result.unixTime && !group.sameEvent && group.pairedNature == "" {
			result.conflict = true
		}
		if item.account != nil && candidate.Currency != "" && item.account.Currency != candidate.Currency {
			result.conflict = true
		}
		if candidate.NormalizedDirection != importing.NORMALIZED_DIRECTION_UNKNOWN && result.direction != importing.NORMALIZED_DIRECTION_UNKNOWN &&
			candidate.NormalizedDirection != result.direction && group.pairedNature == "" {
			result.conflict = true
		}
	}
	return result
}

func preferredPlanningRow(rows []*planningRow) *planningRow {
	if len(rows) == 0 {
		return nil
	}
	items := append([]*planningRow(nil), rows...)
	sort.Slice(items, func(i, j int) bool {
		left, right := planningRowCompleteness(items[i]), planningRowCompleteness(items[j])
		if left != right {
			return left > right
		}
		return items[i].row.RowId < items[j].row.RowId
	})
	return items[0]
}

func planningRowCompleteness(item *planningRow) int {
	score := 0
	row := item.row
	if row.LedgerAccountId != nil && item.account != nil {
		score += 8
	}
	if row.NormalizedUnixTime != nil {
		score += 4
	}
	if row.NormalizedAmount != nil && row.Currency != "" {
		score += 4
	}
	if row.SourceTransactionId != "" || row.SourceOrderId != "" || row.SourceMerchantOrderId != "" {
		score += 2
	}
	if canonicalEvidenceText(row.RawCounterparty) != "" || canonicalEvidenceText(row.RawItem) != "" {
		score++
	}
	return score
}

func groupStableReferences(group *planningGroup) map[string]struct{} {
	result := make(map[string]struct{})
	for _, item := range group.rows {
		for _, value := range []string{item.row.SourceTransactionId, item.row.SourceOrderId, item.row.SourceMerchantOrderId} {
			value = canonicalEvidenceText(value)
			if len([]rune(value)) >= minimumStableReferenceRunes {
				result[value] = struct{}{}
			}
		}
	}
	return result
}

func groupsShareSourceAccount(left *planningGroup, right *planningGroup) bool {
	accounts := make(map[int64]struct{})
	for _, item := range left.rows {
		if item.source.Batch.SourceAccountId != nil {
			accounts[*item.source.Batch.SourceAccountId] = struct{}{}
		}
	}
	for _, item := range right.rows {
		if item.source.Batch.SourceAccountId != nil {
			if _, exists := accounts[*item.source.Batch.SourceAccountId]; exists {
				return true
			}
		}
	}
	return false
}

func groupsHaveCompatiblePaymentSemantics(left *planningGroup, right *planningGroup) bool {
	allowed := func(group *planningGroup) bool {
		for _, item := range group.rows {
			if item.row.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL ||
				(item.row.NormalizedTransactionType != importing.SOURCE_TRANSACTION_TYPE_PAYMENT && item.row.NormalizedTransactionType != importing.SOURCE_TRANSACTION_TYPE_FEE) {
				return false
			}
		}
		return true
	}
	return allowed(left) && allowed(right)
}

func groupTransferLike(group *planningGroup) bool {
	for _, item := range group.rows {
		switch item.row.NormalizedTransactionType {
		case importing.SOURCE_TRANSACTION_TYPE_TRANSFER, importing.SOURCE_TRANSACTION_TYPE_TOP_UP, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL:
			return true
		}
	}
	return false
}

func isRepaymentGroup(group *planningGroup) bool {
	for _, item := range group.rows {
		if item.account != nil && item.account.Category == models.ACCOUNT_CATEGORY_CREDIT_CARD &&
			item.row.NormalizedDirection == importing.NORMALIZED_DIRECTION_INCOME && repaymentSemanticSignal(item.row) {
			return true
		}
	}
	return false
}

func repaymentSemanticSignal(row *importing.RawImportRow) bool {
	text := canonicalEvidenceText(strings.Join([]string{row.RawTransactionType, row.RawCounterparty, row.RawItem, row.RawNote}, " "))
	for _, token := range []string{"信用卡还款", "还款", "款项转入", "repayment", "paymentreceived", "cardpayment"} {
		if strings.Contains(text, canonicalEvidenceText(token)) {
			return true
		}
	}
	return false
}

func groupAllExcluded(group *planningGroup) bool {
	for _, item := range group.rows {
		row := item.row
		if row.ProcessingState != importing.PROCESSING_STATE_IGNORED && row.ProcessingState != importing.PROCESSING_STATE_LINKED &&
			row.Disposition != importing.IMPORT_DISPOSITION_NON_POSTABLE && row.SemanticEligibility != importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE &&
			row.EconomicEffect != importing.ECONOMIC_EFFECT_CLOSED && row.EconomicEffect != importing.ECONOMIC_EFFECT_FAILED {
			return false
		}
	}
	return true
}

func groupAllLinked(group *planningGroup) bool {
	for _, item := range group.rows {
		if item.row.ProcessingState != importing.PROCESSING_STATE_LINKED {
			return false
		}
	}
	return true
}

func groupHasIdentityConflict(group *planningGroup) bool {
	for _, item := range group.rows {
		if item.row.IdentityState == importing.IDENTITY_STATE_IDENTITY_CONFLICT {
			return true
		}
	}
	return false
}

func groupNeedsIdentityReview(group *planningGroup) bool {
	for _, item := range group.rows {
		if item.row.IdentityState == importing.IDENTITY_STATE_BATCH_LOCAL || item.row.IdentityState == importing.IDENTITY_STATE_IDENTITY_CONFLICT ||
			item.row.SemanticEligibility == importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED || item.row.Disposition == importing.IMPORT_DISPOSITION_REVIEW_REQUIRED {
			return true
		}
	}
	return false
}

func excludedNature(group *planningGroup) EconomicNature {
	row := summarizeGroup(group).representative.row
	if row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND {
		return ECONOMIC_NATURE_REFUND
	}
	if row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_FEE {
		return ECONOMIC_NATURE_FEE
	}
	if row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE {
		return ECONOMIC_NATURE_EXPENSE
	}
	return ECONOMIC_NATURE_BALANCE_ADJUSTMENT
}

func refundCandidateEvidenceMatch(refund *planningGroup, original *planningGroup) bool {
	refundRefs, originalRefs := groupStableReferences(refund), groupStableReferences(original)
	for reference := range refundRefs {
		if _, exists := originalRefs[reference]; exists {
			return true
		}
	}
	refundMerchant := groupMerchantSignature(refund)
	return refundMerchant != "" && refundMerchant == groupMerchantSignature(original)
}

func groupMerchantSignature(group *planningGroup) string {
	row := summarizeGroup(group).representative.row
	counterparty := canonicalEvidenceText(row.RawCounterparty)
	if counterparty == "" {
		return ""
	}
	return counterparty + "|" + canonicalEvidenceText(row.RawItem)
}

func eventHasRequiredFields(event *EconomicEvent) bool {
	return event.LedgerAccountId != nil && *event.LedgerAccountId > 0 && event.EventUnixTime != nil && *event.EventUnixTime > 0 &&
		event.Amount != nil && *event.Amount >= 0 && len(event.Currency) == 3 && event.EconomicNature != ECONOMIC_NATURE_UNKNOWN
}

func eventKeyForRows(uid int64, updateId int64, rows []*planningRow) string {
	ids := make([]string, len(rows))
	for index, item := range rows {
		ids[index] = strconv.FormatInt(item.row.RowId, 10)
	}
	sort.Strings(ids)
	return stablePlanDigest("event", strconv.FormatInt(uid, 10), strconv.FormatInt(updateId, 10), strings.Join(ids, ","))
}

func relationKey(uid int64, relationType RelationType, sourceEventId int64, targetEventId int64) string {
	return stablePlanDigest("relation", strconv.FormatInt(uid, 10), string(relationType), strconv.FormatInt(sourceEventId, 10), strconv.FormatInt(targetEventId, 10))
}

func stablePlanDigest(parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}

func fieldSourcesJSON(row *importing.RawImportRow) string {
	ref := "row:" + strconv.FormatInt(row.RowId, 10)
	fields := map[string]string{"direction": ref, "economic_nature": ref}
	if row.LedgerAccountId != nil {
		fields["ledger_account"] = ref
	}
	if row.NormalizedUnixTime != nil {
		fields["event_time"] = ref
	}
	if row.NormalizedAmount != nil {
		fields["amount"] = ref
	}
	if row.Currency != "" {
		fields["currency"] = ref
	}
	encoded, _ := json.Marshal(fields)
	return string(encoded)
}

func reasonCodesJSON(reasons []string) string {
	unique := make(map[string]struct{})
	for _, reason := range reasons {
		if reason != "" {
			unique[reason] = struct{}{}
		}
	}
	items := make([]string, 0, len(unique))
	for reason := range unique {
		items = append(items, reason)
	}
	sort.Strings(items)
	encoded, _ := json.Marshal(items)
	return string(encoded)
}

func decodeReasonCodes(encoded string) []string {
	items := make([]string, 0)
	_ = json.Unmarshal([]byte(encoded), &items)
	return items
}

func removeReason(reasons []string, removed string) []string {
	result := reasons[:0]
	for _, reason := range reasons {
		if reason != removed {
			result = append(result, reason)
		}
	}
	return result
}

func canonicalEvidenceText(value string) string {
	value = strings.ToLower(norm.NFKC.String(strings.TrimSpace(value)))
	var builder strings.Builder
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func flowDirection(direction importing.NormalizedDirection) FlowDirection {
	switch direction {
	case importing.NORMALIZED_DIRECTION_INCOME:
		return FLOW_DIRECTION_INFLOW
	case importing.NORMALIZED_DIRECTION_EXPENSE:
		return FLOW_DIRECTION_OUTFLOW
	default:
		return FLOW_DIRECTION_NEUTRAL
	}
}

func oppositeDirections(left importing.NormalizedDirection, right importing.NormalizedDirection) bool {
	return (left == importing.NORMALIZED_DIRECTION_EXPENSE && right == importing.NORMALIZED_DIRECTION_INCOME) ||
		(left == importing.NORMALIZED_DIRECTION_INCOME && right == importing.NORMALIZED_DIRECTION_EXPENSE)
}

func accountIsAsset(account *models.Account) bool {
	return account != nil && account.Category.IsAsset()
}

func accountIsLiability(account *models.Account) bool {
	return account != nil && account.Category.IsLiability()
}

func absoluteDifference(left int64, right int64) int64 {
	if left >= right {
		return left - right
	}
	return right - left
}

func pointerInt64Value(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneInt16Pointer(value *int16) *int16 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func (g *checkedIdentifierGenerator) generate() (int64, error) {
	id := g.next()
	if id < 1 {
		return 0, fmt.Errorf("organizer identifier generator returned an invalid id")
	}
	if _, exists := g.seen[id]; exists {
		return 0, fmt.Errorf("organizer identifier generator returned a duplicate id")
	}
	g.seen[id] = struct{}{}
	return id, nil
}

type groupUnion struct {
	parent []int
}

func newGroupUnion(size int) *groupUnion {
	parent := make([]int, size)
	for index := range parent {
		parent[index] = index
	}
	return &groupUnion{parent: parent}
}

func (u *groupUnion) find(value int) int {
	if u.parent[value] != value {
		u.parent[value] = u.find(u.parent[value])
	}
	return u.parent[value]
}

func (u *groupUnion) union(left int, right int) {
	leftRoot, rightRoot := u.find(left), u.find(right)
	if leftRoot == rightRoot {
		return
	}
	if leftRoot < rightRoot {
		u.parent[rightRoot] = leftRoot
	} else {
		u.parent[leftRoot] = rightRoot
	}
}
