package organizer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/installments"
)

const (
	planCrossSourceWindowSeconds    = int64(72 * 60 * 60)
	planHighConfidenceWindowSeconds = int64(48 * 60 * 60)
	minimumStableReferenceRunes     = 6
)

const (
	reasonAlreadyPosted                  = "already_posted"
	reasonAutoRefundRelation             = "auto_refund_relation"
	reasonAutoRepaymentPair              = "auto_repayment_pair"
	reasonAutoSameEvent                  = "auto_same_event"
	reasonAutoTransferPair               = "auto_transfer_pair"
	reasonCategoryUnclassified           = "category_unclassified"
	reasonCoreFieldsConflict             = "core_fields_conflict"
	reasonCoreFieldsMissing              = "core_fields_missing"
	reasonEconomicNatureRequired         = "economic_nature_required"
	reasonEvidenceExcluded               = "evidence_excluded"
	reasonIdentityConflict               = "identity_conflict"
	reasonIdentityReviewRequired         = "identity_review_required"
	reasonInstallmentOriginRequired      = "installment_origin_required"
	reasonInstallmentCompositionRequired = "installment_composition_required"
	reasonInstallmentInterest            = "installment_interest"
	reasonInstallmentFee                 = "installment_fee"
	reasonLedgerAccountRequired          = "ledger_account_required"
	reasonRefundAmountExceeded           = "refund_amount_exceeded"
	reasonRefundRelationAmbiguous        = "refund_relation_ambiguous"
	reasonRefundRelationRequired         = "refund_relation_required"
	reasonRefundRelationUnlinked         = "refund_relation_unlinked"
	reasonRelationAmbiguous              = "relation_ambiguous"
	reasonRepaymentAccountRequired       = "repayment_account_required"
	reasonTransferAccountRequired        = "transfer_account_required"
	reasonTransactionClosed              = "transaction_closed"
	reasonTransactionFailed              = "transaction_failed"
)

// PlanningSource 把一次更新冻结的来源快照与不可变解析证据交给规划器。
type PlanningSource struct {
	Source         *FinanceUpdateSource
	Batch          *importing.ImportBatch
	Rows           []*importing.RawImportRow
	FundsMovements map[int64]*PlanningFundsMovement
}

// PlanningFundsMovement 是解析器投影经现有账户映射解析后的内存输入，不单独持久化。
type PlanningFundsMovement struct {
	Kind                importing.SourceFundsMovementKind
	FromLedgerAccountId *int64
	ToLedgerAccountId   *int64
	RuleVersion         importing.RuleVersion
}

// OrganizePlan 是同一后端计划产生的事件、证据、关系和守恒计数。
type OrganizePlan struct {
	Events                   []*EconomicEvent
	Evidence                 []*EconomicEventEvidence
	Relations                []*EconomicEventRelation
	SameEventCandidateGroups map[string][]int64
	SourceCount              int64
	ValidEvidenceCount       int64
	DuplicateEvidenceCount   int64
	FinalEventCount          int64
	ReadyEventCount          int64
	NeedsActionEventCount    int64
	ExcludedEventCount       int64
}

type planIdentifierGenerator func() int64

type planningRow struct {
	row           *importing.RawImportRow
	source        *PlanningSource
	account       *models.Account
	fundsMovement *PlanningFundsMovement
}

type planningGroup struct {
	rows                  []*planningRow
	pairedNature          EconomicNature
	sameEvent             bool
	ambiguous             bool
	sameEventCandidateKey string
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

type planningPair struct {
	left  int
	right int
}

type checkedIdentifierGenerator struct {
	next planIdentifierGenerator
	seen map[int64]struct{}
}

// BuildOrganizePlan 是无数据库副作用的统一整理入口。原始文本只参与内存比较，持久结果仅保存稳定代码和行 ID。
func BuildOrganizePlan(uid int64, updateId int64, sources []*PlanningSource, accounts map[int64]*models.Account, now int64, generateId func() int64, categoryIndexes ...*categoryIndex) (*OrganizePlan, error) {
	if uid < 1 || updateId < 1 || now < 1 || generateId == nil || len(categoryIndexes) > 1 {
		return nil, fmt.Errorf("invalid organizer planning request")
	}
	var categories *categoryIndex
	if len(categoryIndexes) == 1 {
		categories = categoryIndexes[0]
	}
	rows, err := validatePlanningSources(uid, updateId, sources, accounts)
	if err != nil {
		return nil, err
	}
	groups := buildIdentityGroups(rows)
	groups = mergeStrongSameEvents(groups)
	groups = mergeHighConfidenceSameEvents(groups)
	groups = mergeProjectedRepaymentEvidence(groups)
	groups = pairTransfersAndRepayments(groups)

	ids := &checkedIdentifierGenerator{next: generateId, seen: make(map[int64]struct{})}
	plan := &OrganizePlan{
		SourceCount: int64(len(sources)), ValidEvidenceCount: int64(len(rows)),
		SameEventCandidateGroups: make(map[string][]int64),
	}
	planned := make([]*plannedEvent, 0, len(groups))
	for _, group := range groups {
		item, evidence, buildErr := buildPlannedEvent(uid, updateId, group, now, ids, categories)
		if buildErr != nil {
			return nil, buildErr
		}
		planned = append(planned, item)
		plan.Events = append(plan.Events, item.event)
		plan.Evidence = append(plan.Evidence, evidence...)
		plan.DuplicateEvidenceCount += int64(len(group.rows) - 1)
		if group.sameEventCandidateKey != "" {
			plan.SameEventCandidateGroups[group.sameEventCandidateKey] = append(
				plan.SameEventCandidateGroups[group.sameEventCandidateKey], item.event.EventId,
			)
		}
	}
	if err = validateSameEventCandidateGroups(plan); err != nil {
		return nil, err
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

func validateSameEventCandidateGroups(plan *OrganizePlan) error {
	if plan == nil {
		return fmt.Errorf("same-event candidate plan is nil")
	}
	events := make(map[int64]*EconomicEvent, len(plan.Events))
	for _, event := range plan.Events {
		if event == nil || event.EventId < 1 {
			return fmt.Errorf("same-event candidate event is invalid")
		}
		events[event.EventId] = event
	}
	seen := make(map[int64]struct{})
	for key, eventIds := range plan.SameEventCandidateGroups {
		if !isLowerHexSHA256(key) || len(eventIds) < 2 {
			return fmt.Errorf("same-event candidate group is invalid")
		}
		sort.Slice(eventIds, func(i, j int) bool { return eventIds[i] < eventIds[j] })
		for _, eventId := range eventIds {
			if _, exists := seen[eventId]; exists {
				return fmt.Errorf("same-event candidate event belongs to multiple groups")
			}
			event := events[eventId]
			if event == nil || event.Status != EVENT_STATUS_NEEDS_ACTION ||
				!containsReasonCode(event.ReasonCodesJson, reasonRelationAmbiguous) {
				return fmt.Errorf("same-event candidate event snapshot is invalid")
			}
			seen[eventId] = struct{}{}
		}
	}
	return nil
}

func containsReasonCode(encoded string, wanted string) bool {
	for _, reason := range decodeReasonCodes(encoded) {
		if reason == wanted {
			return true
		}
	}
	return false
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
		sourceRows := make(map[int64]struct{}, len(item.Rows))
		for _, row := range item.Rows {
			if row != nil {
				sourceRows[row.RowId] = struct{}{}
			}
		}
		for rowId := range item.FundsMovements {
			if _, exists := sourceRows[rowId]; !exists {
				return nil, fmt.Errorf("organizer funds movement row mismatch")
			}
		}
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
			movement := item.FundsMovements[row.RowId]
			if movementErr := validatePlanningFundsMovement(uid, row, movement, accounts); movementErr != nil {
				return nil, movementErr
			}
			rows = append(rows, &planningRow{row: row, source: item, account: account, fundsMovement: movement})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].row.RowId < rows[j].row.RowId })
	return rows, nil
}

func validatePlanningFundsMovement(uid int64, row *importing.RawImportRow, movement *PlanningFundsMovement, accounts map[int64]*models.Account) error {
	if movement == nil {
		return nil
	}
	if movement.RuleVersion != importing.SOURCE_FUNDS_RULE_VERSION_V1 ||
		(movement.Kind != importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER && movement.Kind != importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT) {
		return fmt.Errorf("organizer funds movement is invalid")
	}
	validateAccount := func(accountId *int64) error {
		if accountId == nil {
			return nil
		}
		if *accountId < 1 {
			return fmt.Errorf("organizer funds movement account is invalid")
		}
		account := accounts[*accountId]
		if account == nil || account.Uid != uid || account.AccountId != *accountId || account.Deleted ||
			(row.Currency != "" && account.Currency != row.Currency) {
			return fmt.Errorf("organizer funds movement account mismatch")
		}
		return nil
	}
	if err := validateAccount(movement.FromLedgerAccountId); err != nil {
		return err
	}
	return validateAccount(movement.ToLedgerAccountId)
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
	if row == nil || !canGroupByPersistedSourceIdentity(row) {
		if row == nil {
			return "row:nil"
		}
		return "row:" + strconv.FormatInt(row.RowId, 10)
	}
	if row.IdentityId != nil && *row.IdentityId > 0 {
		return "identity:" + strconv.FormatInt(*row.IdentityId, 10)
	}
	if isLowerHexSHA256(row.ObservedSourceIdentityKey) {
		return "observed:" + row.ObservedSourceIdentityKey
	}
	return "row:" + strconv.FormatInt(row.RowId, 10)
}

// canGroupByPersistedSourceIdentity prevents legacy identity-v1 content
// fingerprints from collapsing different physical rows before cross-source
// matching. V2 rows use stable source identifiers or file+locator identities;
// V1 rows are trusted only when their raw identifiers prove the stable kind.
func canGroupByPersistedSourceIdentity(row *importing.RawImportRow) bool {
	if row == nil {
		return false
	}
	switch row.IdentityKeyVersion {
	case importing.IDENTITY_KEY_VERSION_V2:
		return true
	case importing.IDENTITY_KEY_VERSION_V1:
		_, stable := importing.ResolveStableSourceIdentityKind(importing.SourceIdentifiers{
			TransactionId:   row.SourceTransactionId,
			OrderId:         row.SourceOrderId,
			MerchantOrderId: row.SourceMerchantOrderId,
		})
		return stable
	default:
		return false
	}
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

// mergeHighConfidenceSameEvents 处理没有共享订单号、但具备跨来源强结构证据的同一事件。
// 普通明细必须同时满足账户、金额、方向、时间和文本；只有日期的银行月结行还要求
// 交易日或记账日与平台明细同日、等额桶两侧数量相等且存在完整一一匹配，不能仅凭金额和时间合并。
func mergeHighConfidenceSameEvents(groups []*planningGroup) []*planningGroup {
	if len(groups) < 2 {
		return groups
	}
	candidates := make([]planningPair, 0)
	dateOnlyCandidates := make([]planningPair, 0)
	for left := 0; left < len(groups); left++ {
		for right := left + 1; right < len(groups); right++ {
			dateOnly, matched := highConfidenceSameEvent(groups[left], groups[right])
			if !matched {
				continue
			}
			item := planningPair{left: left, right: right}
			if dateOnly {
				dateOnlyCandidates = append(dateOnlyCandidates, item)
			} else {
				candidates = append(candidates, item)
			}
		}
	}

	parent := newGroupUnion(len(groups))
	selected := make(map[int]struct{})
	selectPair := func(item planningPair) {
		if _, exists := selected[item.left]; exists {
			return
		}
		if _, exists := selected[item.right]; exists {
			return
		}
		selected[item.left] = struct{}{}
		selected[item.right] = struct{}{}
		parent.union(item.left, item.right)
	}

	degrees := make(map[int]int)
	for _, item := range candidates {
		degrees[item.left]++
		degrees[item.right]++
	}
	for _, item := range candidates {
		if degrees[item.left] == 1 && degrees[item.right] == 1 {
			selectPair(item)
		}
	}
	selectBalancedDateOnlyPairs(dateOnlyCandidates, groups, selected, selectPair)

	allCandidates := append(append([]planningPair(nil), candidates...), dateOnlyCandidates...)
	ambiguous := make(map[int]bool)
	for _, item := range allCandidates {
		if _, ok := selected[item.left]; !ok {
			ambiguous[item.left] = true
		}
		if _, ok := selected[item.right]; !ok {
			ambiguous[item.right] = true
		}
	}
	assignSameEventCandidateKeys(groups, allCandidates, ambiguous)
	return compactPlanningGroups(groups, parent, nil, ambiguous)
}

func assignSameEventCandidateKeys(groups []*planningGroup, candidates []planningPair, ambiguous map[int]bool) {
	if len(groups) < 2 || len(candidates) == 0 || len(ambiguous) == 0 {
		return
	}
	components := newGroupUnion(len(groups))
	for _, candidate := range candidates {
		if !ambiguous[candidate.left] || !ambiguous[candidate.right] {
			continue
		}
		components.union(candidate.left, candidate.right)
	}
	byRoot := make(map[int][]int)
	for index := range groups {
		if !ambiguous[index] {
			continue
		}
		byRoot[components.find(index)] = append(byRoot[components.find(index)], index)
	}
	for _, indexes := range byRoot {
		if len(indexes) < 2 {
			continue
		}
		members := make([]string, 0, len(indexes))
		for _, index := range indexes {
			members = append(members, planningGroupCandidateIdentity(groups[index]))
		}
		sort.Strings(members)
		key := stablePlanDigest(
			"same-event-candidate-group",
			string(SAME_EVENT_CANDIDATE_KEY_VERSION_V1),
			strings.Join(members, "\x00"),
		)
		for _, index := range indexes {
			groups[index].sameEventCandidateKey = key
		}
	}
}

func planningGroupCandidateIdentity(group *planningGroup) string {
	if group == nil {
		return ""
	}
	identities := make([]string, 0, len(group.rows))
	for _, item := range group.rows {
		if item == nil || item.row == nil {
			continue
		}
		identities = append(identities, identityGroupKey(item.row))
	}
	sort.Strings(identities)
	identities = uniquePlanningStrings(identities)
	return stablePlanDigest(
		"same-event-candidate-member",
		string(SAME_EVENT_CANDIDATE_KEY_VERSION_V1),
		strings.Join(identities, "\x00"),
	)
}

func uniquePlanningStrings(values []string) []string {
	if len(values) < 2 {
		return values
	}
	result := values[:0]
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}

func highConfidenceSameEvent(left *planningGroup, right *planningGroup) (bool, bool) {
	leftSummary, rightSummary := summarizeGroup(left), summarizeGroup(right)
	if !leftSummary.complete || !rightSummary.complete || leftSummary.conflict || rightSummary.conflict ||
		leftSummary.accountId != rightSummary.accountId || leftSummary.amount != rightSummary.amount ||
		leftSummary.currency != rightSummary.currency || leftSummary.direction != rightSummary.direction ||
		leftSummary.direction == importing.NORMALIZED_DIRECTION_UNKNOWN || leftSummary.direction == importing.NORMALIZED_DIRECTION_NEUTRAL ||
		groupsShareSourceAccount(left, right) || groupsShareSourceType(left, right) ||
		!groupsHaveOrdinaryPaymentSemantics(left, right) {
		return false, false
	}
	leftRow, rightRow := leftSummary.representative.row, rightSummary.representative.row
	leftDateOnly, rightDateOnly := rowHasDateOnlyTime(leftRow), rowHasDateOnlyTime(rightRow)
	if leftDateOnly != rightDateOnly {
		return true, sharedCivilDate(leftRow, rightRow) != "" &&
			(groupHasSourceType(left, importing.SOURCE_TYPE_BANK) || groupHasSourceType(right, importing.SOURCE_TYPE_BANK))
	}
	return false, absoluteDifference(leftSummary.unixTime, rightSummary.unixTime) <= planHighConfidenceWindowSeconds &&
		groupsHaveSimilarEvidenceText(left, right)
}

func selectBalancedDateOnlyPairs(candidates []planningPair, groups []*planningGroup, selected map[int]struct{}, selectPair func(planningPair)) {
	type bucketKey struct {
		accountId int64
		amount    int64
		currency  string
		direction importing.NormalizedDirection
		date      string
	}
	buckets := make(map[bucketKey][]planningPair)
	for _, item := range candidates {
		left := summarizeGroup(groups[item.left])
		date := sharedCivilDate(left.representative.row, summarizeGroup(groups[item.right]).representative.row)
		if date == "" {
			continue
		}
		key := bucketKey{accountId: left.accountId, amount: left.amount, currency: left.currency, direction: left.direction, date: date}
		buckets[key] = append(buckets[key], item)
	}
	for _, items := range buckets {
		leftNodes, rightNodes := make(map[int]struct{}), make(map[int]struct{})
		edges := make(map[int][]int)
		for _, item := range items {
			left, right := item.left, item.right
			if groupHasSourceType(groups[left], importing.SOURCE_TYPE_BANK) {
				left, right = right, left
			}
			if groupHasSourceType(groups[left], importing.SOURCE_TYPE_BANK) || !groupHasSourceType(groups[right], importing.SOURCE_TYPE_BANK) {
				continue
			}
			leftNodes[left] = struct{}{}
			rightNodes[right] = struct{}{}
			edges[left] = append(edges[left], right)
		}
		if len(leftNodes) < 1 || len(leftNodes) != len(rightNodes) {
			continue
		}
		leftOrder := make([]int, 0, len(leftNodes))
		for node := range leftNodes {
			leftOrder = append(leftOrder, node)
			sort.Ints(edges[node])
		}
		sort.Ints(leftOrder)
		assigned := make(map[int]int)
		var match func(int, map[int]struct{}) bool
		match = func(left int, seen map[int]struct{}) bool {
			for _, right := range edges[left] {
				if _, used := selected[left]; used {
					continue
				}
				if _, used := selected[right]; used {
					continue
				}
				if _, visited := seen[right]; visited {
					continue
				}
				seen[right] = struct{}{}
				previous, occupied := assigned[right]
				if !occupied || match(previous, seen) {
					assigned[right] = left
					return true
				}
			}
			return false
		}
		complete := true
		for _, left := range leftOrder {
			if !match(left, make(map[int]struct{})) {
				complete = false
				break
			}
		}
		if !complete || len(assigned) != len(leftNodes) {
			continue
		}
		for right, left := range assigned {
			selectPair(planningPair{left: left, right: right})
		}
	}
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

// mergeProjectedRepaymentEvidence 把支付宝/微信已经确定双边账户的还款，与银行账单中
// 同一笔单边流水收敛为一个事件。平台投影保留还款语义，银行行只作为附加证据；
// 每个账户侧只有唯一候选时才自动归并，多候选继续交给同一事件裁决。
func mergeProjectedRepaymentEvidence(groups []*planningGroup) []*planningGroup {
	if len(groups) < 2 {
		return groups
	}
	type candidate struct {
		projected int
		bank      int
		side      int64
	}
	candidates := make([]candidate, 0)
	byProjectedSide := make(map[[2]int64]int)
	byBank := make(map[int]int)
	for projected := range groups {
		movement, ok := summarizeProjectedFundsMovement(groups[projected])
		if !ok || movement.Kind != importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT ||
			movement.FromLedgerAccountId == nil || movement.ToLedgerAccountId == nil ||
			*movement.FromLedgerAccountId == *movement.ToLedgerAccountId ||
			groupHasSourceType(groups[projected], importing.SOURCE_TYPE_BANK) {
			continue
		}
		for bank := range groups {
			if bank == projected {
				continue
			}
			side, matched := projectedRepaymentEvidenceSide(groups[projected], groups[bank], movement)
			if !matched {
				continue
			}
			candidates = append(candidates, candidate{projected: projected, bank: bank, side: side})
			byProjectedSide[[2]int64{int64(projected), side}]++
			byBank[bank]++
		}
	}
	if len(candidates) == 0 {
		return groups
	}

	parent := newGroupUnion(len(groups))
	ambiguous := make(map[int]bool)
	candidatePairs := make([]planningPair, 0, len(candidates))
	for _, item := range candidates {
		candidatePairs = append(candidatePairs, planningPair{left: item.projected, right: item.bank})
		if byProjectedSide[[2]int64{int64(item.projected), item.side}] == 1 && byBank[item.bank] == 1 {
			parent.union(item.projected, item.bank)
			continue
		}
		ambiguous[item.projected] = true
		ambiguous[item.bank] = true
	}
	assignSameEventCandidateKeys(groups, candidatePairs, ambiguous)
	return compactPlanningGroups(groups, parent, nil, ambiguous)
}

func projectedRepaymentEvidenceSide(projected *planningGroup, bank *planningGroup, movement *PlanningFundsMovement) (int64, bool) {
	if projected == nil || bank == nil || movement == nil || projected.ambiguous || bank.ambiguous ||
		projected.sameEventCandidateKey != "" || bank.sameEventCandidateKey != "" ||
		!groupHasOnlySourceType(bank, importing.SOURCE_TYPE_BANK) || groupHasProjectedFundsMovement(bank) ||
		groupsShareSourceAccount(projected, bank) {
		return 0, false
	}
	projectedSummary, bankSummary := summarizeGroup(projected), summarizeGroup(bank)
	if projectedSummary.conflict || bankSummary.conflict || !bankSummary.complete ||
		projectedSummary.amount < 0 || projectedSummary.unixTime < 1 || projectedSummary.currency == "" ||
		projectedSummary.amount != bankSummary.amount || projectedSummary.currency != bankSummary.currency ||
		absoluteDifference(projectedSummary.unixTime, bankSummary.unixTime) > planCrossSourceWindowSeconds ||
		!groupHasRepaymentSemanticSignal(bank) {
		return 0, false
	}
	if bankSummary.accountId == pointerInt64Value(movement.ToLedgerAccountId) &&
		bankSummary.direction == importing.NORMALIZED_DIRECTION_INCOME && accountIsLiability(bankSummary.representative.account) {
		return bankSummary.accountId, true
	}
	if bankSummary.accountId == pointerInt64Value(movement.FromLedgerAccountId) &&
		bankSummary.direction == importing.NORMALIZED_DIRECTION_EXPENSE && accountIsAsset(bankSummary.representative.account) {
		return bankSummary.accountId, true
	}
	return 0, false
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
	if left == nil || right == nil || left.ambiguous || right.ambiguous ||
		left.sameEventCandidateKey != "" || right.sameEventCandidateKey != "" {
		return "", false
	}
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
		if group.sameEventCandidateKey != "" {
			if merged.sameEventCandidateKey == "" {
				merged.sameEventCandidateKey = group.sameEventCandidateKey
			} else if merged.sameEventCandidateKey != group.sameEventCandidateKey {
				merged.sameEventCandidateKey = "invalid"
			}
		}
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

func buildPlannedEvent(uid int64, updateId int64, group *planningGroup, now int64, ids *checkedIdentifierGenerator, categories *categoryIndex) (*plannedEvent, []*EconomicEventEvidence, error) {
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
		reasons = append(reasons, excludedTransactionReasons(group)...)
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
		if !summary.complete && !projectedGroupCoreComplete(group, summary) {
			reasons = append(reasons, reasonCoreFieldsMissing)
		}
		if summary.accountId < 1 && !groupHasResolvedFundsSource(group) {
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
	if event.CategoryId == nil && event.Status != EVENT_STATUS_EXCLUDED {
		if match := categories.mapped(group, event.EconomicNature); match.categoryId > 0 {
			value := match.categoryId
			event.CategoryId = &value
			event.FieldSourcesJson = setCategoryFieldSource(event.FieldSourcesJson, match.sourceRef)
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
	installment := detectPlanningInstallment(group)
	switch {
	case installment.Matched && installment.Component == installments.COMPONENT_TYPE_INTEREST:
		event.EconomicNature = ECONOMIC_NATURE_FEE
		event.Status = EVENT_STATUS_READY
		*reasons = append(*reasons, reasonInstallmentInterest)
	case installment.Matched && installment.Component == installments.COMPONENT_TYPE_FEE:
		event.EconomicNature = ECONOMIC_NATURE_FEE
		event.Status = EVENT_STATUS_READY
		*reasons = append(*reasons, reasonInstallmentFee)
	case installment.Matched && installment.Component == installments.COMPONENT_TYPE_PRINCIPAL:
		// 分期本金只证明债务计划的推进，不能再次记成日常消费。
		// 在可靠关联到原消费、借款或既有合同前保持待确认。
		event.EconomicNature = ECONOMIC_NATURE_UNKNOWN
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonInstallmentOriginRequired)
	case installment.Matched && installment.PeriodNumber != nil:
		event.EconomicNature = ECONOMIC_NATURE_UNKNOWN
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonInstallmentCompositionRequired)
	case groupHasEconomicEffect(group, importing.ECONOMIC_EFFECT_REFUND) && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE:
		event.EconomicNature = ECONOMIC_NATURE_EXPENSE
		event.Status = EVENT_STATUS_READY
	case groupHasEconomicEffect(group, importing.ECONOMIC_EFFECT_REFUND):
		event.EconomicNature = ECONOMIC_NATURE_REFUND
		event.Status = EVENT_STATUS_READY
		*reasons = append(*reasons, reasonRefundRelationUnlinked)
	case configureProjectedFundsEvent(event, group):
		if event.Status == EVENT_STATUS_NEEDS_ACTION {
			if event.EconomicNature == ECONOMIC_NATURE_REPAYMENT {
				*reasons = append(*reasons, reasonRepaymentAccountRequired)
			} else {
				*reasons = append(*reasons, reasonTransferAccountRequired)
			}
		}
	case isRepaymentGroup(group):
		// 信用卡账单的还款流入已经证明还入的负债账户，未知的是资金来源。
		// 事件字段统一保持 ledger=转出、counterparty=转入，避免界面反向询问用户。
		targetAccountId := cloneInt64Pointer(event.LedgerAccountId)
		event.LedgerAccountId = nil
		event.CounterpartyLedgerAccountId = targetAccountId
		event.EconomicNature = ECONOMIC_NATURE_REPAYMENT
		event.FlowDirection = FLOW_DIRECTION_NEUTRAL
		event.Status = EVENT_STATUS_NEEDS_ACTION
		*reasons = append(*reasons, reasonRepaymentAccountRequired)
	case row.NormalizedTransactionType == importing.SOURCE_TRANSACTION_TYPE_FEE && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE:
		event.EconomicNature = ECONOMIC_NATURE_FEE
		event.Status = EVENT_STATUS_READY
	case row.EconomicEffect == importing.ECONOMIC_EFFECT_NORMAL && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_EXPENSE && !groupTransferLike(group):
		event.EconomicNature = ECONOMIC_NATURE_EXPENSE
		event.Status = EVENT_STATUS_READY
	case row.EconomicEffect == importing.ECONOMIC_EFFECT_NORMAL && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_INCOME && !groupTransferLike(group):
		event.EconomicNature = ECONOMIC_NATURE_INCOME
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

func detectPlanningInstallment(group *planningGroup) installments.Detection {
	result := installments.Detection{}
	if group == nil {
		return result
	}
	for _, item := range group.rows {
		if item == nil || item.row == nil {
			continue
		}
		row := item.row
		detected := installments.Detect(installments.Evidence{
			RowId: row.RowId, IdentityId: row.IdentityId, SourceOrderId: row.SourceOrderId,
			SourceMerchantId: row.SourceMerchantOrderId, RawTransactionType: row.RawTransactionType,
			RawCounterparty: row.RawCounterparty, RawItem: row.RawItem, RawNote: row.RawNote,
			LedgerAccountId: row.LedgerAccountId,
		})
		if !detected.Matched {
			continue
		}
		if !result.Matched {
			result = detected
			continue
		}
		if result.Component != "" && detected.Component != "" && result.Component != detected.Component {
			result.Component = installments.COMPONENT_TYPE_UNKNOWN
		} else if result.Component == "" {
			result.Component = detected.Component
		}
		if result.Funding != "" && detected.Funding != "" && result.Funding != detected.Funding {
			result.Funding = installments.FUNDING_TYPE_UNKNOWN
		} else if result.Funding == "" {
			result.Funding = detected.Funding
		}
		if result.PeriodNumber == nil {
			result.PeriodNumber = cloneInt64Pointer(detected.PeriodNumber)
		} else if detected.PeriodNumber != nil && *result.PeriodNumber != *detected.PeriodNumber {
			result.PeriodNumber = nil
		}
		if result.TermCount == nil {
			result.TermCount = cloneInt64Pointer(detected.TermCount)
		} else if detected.TermCount != nil && *result.TermCount != *detected.TermCount {
			result.TermCount = nil
		}
	}
	return result
}

func configureProjectedFundsEvent(event *EconomicEvent, group *planningGroup) bool {
	movement, ok := summarizeProjectedFundsMovement(group)
	if !ok {
		return false
	}
	event.FlowDirection = FLOW_DIRECTION_NEUTRAL
	switch movement.Kind {
	case importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER:
		event.EconomicNature = ECONOMIC_NATURE_INTERNAL_TRANSFER
	case importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT:
		event.EconomicNature = ECONOMIC_NATURE_REPAYMENT
	default:
		return false
	}
	event.LedgerAccountId = cloneInt64Pointer(movement.FromLedgerAccountId)
	event.CounterpartyLedgerAccountId = cloneInt64Pointer(movement.ToLedgerAccountId)
	event.Status = EVENT_STATUS_NEEDS_ACTION
	if event.LedgerAccountId != nil && event.CounterpartyLedgerAccountId != nil &&
		*event.LedgerAccountId != *event.CounterpartyLedgerAccountId {
		event.Status = EVENT_STATUS_READY
	}
	return true
}

func summarizeProjectedFundsMovement(group *planningGroup) (*PlanningFundsMovement, bool) {
	if group == nil || len(group.rows) < 1 {
		return nil, false
	}
	var result *PlanningFundsMovement
	for _, item := range group.rows {
		if item.fundsMovement == nil {
			continue
		}
		if result == nil {
			copy := *item.fundsMovement
			result = &copy
			continue
		}
		if result.Kind != item.fundsMovement.Kind || result.RuleVersion != item.fundsMovement.RuleVersion ||
			pointerInt64Value(result.FromLedgerAccountId) != pointerInt64Value(item.fundsMovement.FromLedgerAccountId) ||
			pointerInt64Value(result.ToLedgerAccountId) != pointerInt64Value(item.fundsMovement.ToLedgerAccountId) {
			return nil, false
		}
	}
	return result, result != nil
}

func groupHasResolvedFundsSource(group *planningGroup) bool {
	movement, ok := summarizeProjectedFundsMovement(group)
	return ok && movement.FromLedgerAccountId != nil
}

func projectedGroupCoreComplete(group *planningGroup, summary groupSummary) bool {
	movement, ok := summarizeProjectedFundsMovement(group)
	return ok && movement.FromLedgerAccountId != nil && movement.ToLedgerAccountId != nil &&
		summary.amount >= 0 && summary.unixTime > 0 && len(summary.currency) == 3 &&
		summary.direction != importing.NORMALIZED_DIRECTION_UNKNOWN
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
			// 不为了强行关联而阻塞一笔来源已明确的退款。
			// 累计金额超出原消费时只放弃该自动关系，保留未关联退款语义。
			continue
		} else if eventHasRequiredFields(match.refund.event) {
			match.refund.event.Status = EVENT_STATUS_READY
			reasons = removeReason(reasons, reasonRefundRelationUnlinked)
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
	result.direction = effectivePlanningDirection(row)
	result.complete = result.accountId > 0 && result.amount >= 0 && result.unixTime > 0 && len(result.currency) == 3 &&
		result.direction != importing.NORMALIZED_DIRECTION_UNKNOWN
	_, hasProjectedFunds := summarizeProjectedFundsMovement(group)
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
		if candidate.LedgerAccountId != nil && item.account != nil && result.accountId > 0 && *candidate.LedgerAccountId != result.accountId &&
			group.pairedNature == "" && !hasProjectedFunds {
			result.conflict = true
		}
		if candidate.NormalizedUnixTime != nil && result.unixTime > 0 && *candidate.NormalizedUnixTime != result.unixTime && !group.sameEvent && group.pairedNature == "" {
			result.conflict = true
		}
		if item.account != nil && candidate.Currency != "" && item.account.Currency != candidate.Currency {
			result.conflict = true
		}
		candidateDirection := effectivePlanningDirection(candidate)
		if candidateDirection != importing.NORMALIZED_DIRECTION_UNKNOWN && result.direction != importing.NORMALIZED_DIRECTION_UNKNOWN &&
			candidateDirection != result.direction && group.pairedNature == "" && !hasProjectedFunds {
			result.conflict = true
		}
	}
	return result
}

func effectivePlanningDirection(row *importing.RawImportRow) importing.NormalizedDirection {
	if row == nil {
		return importing.NORMALIZED_DIRECTION_UNKNOWN
	}
	if row.EconomicEffect == importing.ECONOMIC_EFFECT_REFUND && row.NormalizedDirection == importing.NORMALIZED_DIRECTION_NEUTRAL {
		return importing.NORMALIZED_DIRECTION_INCOME
	}
	return row.NormalizedDirection
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
	if item.fundsMovement != nil {
		score += 16
	}
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

func groupsShareSourceType(left *planningGroup, right *planningGroup) bool {
	types := make(map[string]struct{})
	for _, item := range left.rows {
		types[item.source.Source.SourceTypeSnapshot] = struct{}{}
	}
	for _, item := range right.rows {
		if _, exists := types[item.source.Source.SourceTypeSnapshot]; exists {
			return true
		}
	}
	return false
}

func groupHasSourceType(group *planningGroup, sourceType importing.SourceType) bool {
	for _, item := range group.rows {
		if item.source.Source.SourceTypeSnapshot == string(sourceType) {
			return true
		}
	}
	return false
}

func groupHasOnlySourceType(group *planningGroup, sourceType importing.SourceType) bool {
	if group == nil || len(group.rows) == 0 {
		return false
	}
	for _, item := range group.rows {
		if item.source.Source.SourceTypeSnapshot != string(sourceType) {
			return false
		}
	}
	return true
}

func groupHasProjectedFundsMovement(group *planningGroup) bool {
	for _, item := range group.rows {
		if item.fundsMovement != nil {
			return true
		}
	}
	return false
}

func groupsHaveOrdinaryPaymentSemantics(left *planningGroup, right *planningGroup) bool {
	allowed := func(group *planningGroup) importing.EconomicEffect {
		var effect importing.EconomicEffect
		for _, item := range group.rows {
			if item.row.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL && item.row.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND {
				return ""
			}
			if effect == "" {
				effect = item.row.EconomicEffect
			} else if effect != item.row.EconomicEffect {
				return ""
			}
			switch item.row.NormalizedTransactionType {
			case importing.SOURCE_TRANSACTION_TYPE_TRANSFER, importing.SOURCE_TRANSACTION_TYPE_TOP_UP, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL:
				return ""
			}
		}
		return effect
	}
	leftEffect, rightEffect := allowed(left), allowed(right)
	if leftEffect == "" || rightEffect == "" {
		return false
	}
	if leftEffect == rightEffect {
		return true
	}
	// 通用银行表格只可靠表达入账方向，平台明细才能明确说明原消费发生了
	// 部分退款。两侧其余强条件已由 highConfidenceSameEvent 校验；这里只
	// 允许纯银行 normal 与非银行 refund 互补，不把两个普通来源猜成退款。
	return (leftEffect == importing.ECONOMIC_EFFECT_NORMAL && groupHasOnlySourceType(left, importing.SOURCE_TYPE_BANK) &&
		rightEffect == importing.ECONOMIC_EFFECT_REFUND && !groupHasOnlySourceType(right, importing.SOURCE_TYPE_BANK)) ||
		(rightEffect == importing.ECONOMIC_EFFECT_NORMAL && groupHasOnlySourceType(right, importing.SOURCE_TYPE_BANK) &&
			leftEffect == importing.ECONOMIC_EFFECT_REFUND && !groupHasOnlySourceType(left, importing.SOURCE_TYPE_BANK))
}

func groupHasEconomicEffect(group *planningGroup, effect importing.EconomicEffect) bool {
	if group == nil {
		return false
	}
	for _, item := range group.rows {
		if item != nil && item.row != nil && item.row.EconomicEffect == effect {
			return true
		}
	}
	return false
}

func groupsHaveSimilarEvidenceText(left *planningGroup, right *planningGroup) bool {
	leftRow := summarizeGroup(left).representative.row
	rightRow := summarizeGroup(right).representative.row
	pairs := [][2]string{
		{leftRow.RawCounterparty, rightRow.RawCounterparty},
		{leftRow.RawItem, rightRow.RawItem},
		{strings.Join([]string{leftRow.RawCounterparty, leftRow.RawItem}, " "), strings.Join([]string{rightRow.RawCounterparty, rightRow.RawItem}, " ")},
	}
	for _, pair := range pairs {
		leftText := canonicalEvidenceText(pair[0])
		rightText := canonicalEvidenceText(pair[1])
		if len([]rune(leftText)) >= 3 && len([]rune(rightText)) >= 3 &&
			(leftText == rightText || strings.Contains(leftText, rightText) || strings.Contains(rightText, leftText)) {
			return true
		}
	}
	return false
}

func rowHasDateOnlyTime(row *importing.RawImportRow) bool {
	if row == nil || row.NormalizedUnixTime == nil {
		return false
	}
	local := time.Unix(*row.NormalizedUnixTime, 0).In(time.FixedZone("organizer-row", rowTimezoneSeconds(row)))
	return local.Hour() == 0 && local.Minute() == 0 && local.Second() == 0
}

func rowCivilDate(row *importing.RawImportRow) string {
	if row == nil || row.NormalizedUnixTime == nil {
		return ""
	}
	return time.Unix(*row.NormalizedUnixTime, 0).In(time.FixedZone("organizer-row", rowTimezoneSeconds(row))).Format(time.DateOnly)
}

// sharedCivilDate 同时核对银行交易日与记账日。平台退款常在银行交易日次日入账；
// 记账日只扩展日期候选，最终仍须通过账户、金额、币种、方向和一一对应约束。
func sharedCivilDate(left *importing.RawImportRow, right *importing.RawImportRow) string {
	leftDates, rightDates := rowCivilDates(left), rowCivilDates(right)
	shared := make([]string, 0, 2)
	for date := range leftDates {
		if _, exists := rightDates[date]; exists {
			shared = append(shared, date)
		}
	}
	if len(shared) == 0 {
		return ""
	}
	sort.Strings(shared)
	return shared[0]
}

func rowCivilDates(row *importing.RawImportRow) map[string]struct{} {
	dates := make(map[string]struct{}, 2)
	if date := rowCivilDate(row); date != "" {
		dates[date] = struct{}{}
	}
	if row == nil {
		return dates
	}
	note := strings.TrimSpace(row.RawNote)
	for _, layout := range []string{"2006/01/02", time.DateOnly} {
		if parsed, err := time.Parse(layout, note); err == nil {
			dates[parsed.Format(time.DateOnly)] = struct{}{}
			break
		}
	}
	return dates
}

func rowTimezoneSeconds(row *importing.RawImportRow) int {
	if row != nil && row.NormalizedTimezoneUtcOffset != nil {
		return int(*row.NormalizedTimezoneUtcOffset) * 60
	}
	return 0
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

func groupHasRepaymentSemanticSignal(group *planningGroup) bool {
	for _, item := range group.rows {
		if repaymentSemanticSignal(item.row) {
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

func excludedTransactionReasons(group *planningGroup) []string {
	reasons := make([]string, 0, 2)
	for _, item := range group.rows {
		switch item.row.EconomicEffect {
		case importing.ECONOMIC_EFFECT_CLOSED:
			reasons = appendUniqueReasons(reasons, reasonTransactionClosed)
		case importing.ECONOMIC_EFFECT_FAILED:
			reasons = appendUniqueReasons(reasons, reasonTransactionFailed)
		}
	}
	return reasons
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
		if item.row.IdentityState == importing.IDENTITY_STATE_BATCH_LOCAL || item.row.IdentityState == importing.IDENTITY_STATE_IDENTITY_CONFLICT {
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
	if groupsHaveExplicitSourceRefund(original, refund) {
		return true
	}
	refundRefs, originalRefs := groupStableReferences(refund), groupStableReferences(original)
	for reference := range refundRefs {
		if _, exists := originalRefs[reference]; exists {
			return true
		}
	}
	refundMerchant := groupMerchantSignature(refund)
	return refundMerchant != "" && refundMerchant == groupMerchantSignature(original)
}

func groupsHaveExplicitSourceRefund(original *planningGroup, refund *planningGroup) bool {
	for _, left := range original.rows {
		for _, right := range refund.rows {
			if explicitSourceRefundRows(left.row, right.row) {
				return true
			}
		}
	}
	return false
}

func explicitSourceRefundRows(original *importing.RawImportRow, refund *importing.RawImportRow) bool {
	if original == nil || refund == nil || original.NormalizedAmount == nil || refund.NormalizedAmount == nil ||
		original.NormalizedUnixTime == nil || refund.NormalizedUnixTime == nil || original.Currency == "" || original.Currency != refund.Currency ||
		original.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND || refund.EconomicEffect != importing.ECONOMIC_EFFECT_REFUND ||
		original.NormalizedDirection != importing.NORMALIZED_DIRECTION_EXPENSE || refund.NormalizedDirection != importing.NORMALIZED_DIRECTION_INCOME ||
		*refund.NormalizedUnixTime < *original.NormalizedUnixTime || *refund.NormalizedUnixTime-*original.NormalizedUnixTime > planCrossSourceWindowSeconds ||
		*refund.NormalizedAmount < 1 || *refund.NormalizedAmount > *original.NormalizedAmount {
		return false
	}
	expected, ok := explicitRefundAmountFromStatus(original.RawStatus)
	return ok && expected == *refund.NormalizedAmount && canonicalEvidenceText(original.RawCounterparty) != "" &&
		canonicalEvidenceText(original.RawCounterparty) == canonicalEvidenceText(refund.RawCounterparty)
}

func explicitRefundAmountFromStatus(status string) (int64, bool) {
	status = strings.TrimSpace(status)
	index := strings.IndexAny(status, "¥￥")
	if index < 0 || index+1 >= len(status) {
		return 0, false
	}
	var number strings.Builder
	dotSeen := false
	for _, char := range status[index+1:] {
		switch {
		case char >= '0' && char <= '9':
			number.WriteRune(char)
		case char == '.' && !dotSeen:
			dotSeen = true
			number.WriteRune(char)
		case number.Len() > 0:
			goto parsed
		}
	}
parsed:
	parts := strings.Split(number.String(), ".")
	if len(parts) < 1 || len(parts) > 2 || parts[0] == "" {
		return 0, false
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole < 0 || whole > (1<<63-1)/100 {
		return 0, false
	}
	fraction := int64(0)
	if len(parts) == 2 {
		if len(parts[1]) < 1 || len(parts[1]) > 2 {
			return 0, false
		}
		if len(parts[1]) == 1 {
			parts[1] += "0"
		}
		fraction, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, false
		}
	}
	return whole*100 + fraction, true
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

func setCategoryFieldSource(encoded string, source string) string {
	if source == "" {
		return encoded
	}
	fields := make(map[string]string)
	_ = json.Unmarshal([]byte(encoded), &fields)
	fields["category"] = source
	value, _ := json.Marshal(fields)
	return string(value)
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
