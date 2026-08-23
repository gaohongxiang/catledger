package organizer_test

import (
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestBuildOrganizePlanConservesEvidenceAndRequiresStrongMergeEvidence(t *testing.T) {
	const uid = int64(101)
	account := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)
	first := plannerSource(uid, 501, 0, 601, 701, importing.SOURCE_TYPE_ALIPAY)
	second := plannerSource(uid, 501, 1, 602, 702, importing.SOURCE_TYPE_BANK)
	first.Rows = []*importing.RawImportRow{
		plannerRow(uid, 701, 101, 1001, 11, 1000, 1700000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 701, 102, 1002, 11, 2500, 1700000100, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 701, 103, 1003, 11, 3000, 1700000200, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 701, 104, 1004, 11, 4000, 1700000300, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 701, 105, 1005, 11, 5000, 1700000400, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 701, 106, 1006, 11, 6000, 1700000500, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_UNKNOWN),
	}
	first.Rows[0].SourceOrderId = "ORDER-STRONG-0001"
	first.Rows[1].RawCounterparty = "同一商户"
	first.Rows[3].ParseState = importing.PARSE_STATE_INVALID
	first.Rows[4].ProcessingState = importing.PROCESSING_STATE_IGNORED
	first.Rows[4].Disposition = importing.IMPORT_DISPOSITION_NON_POSTABLE
	first.Rows[5].RawCounterparty = "商户甲"
	first.Rows[5].SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED
	first.Rows[5].Disposition = importing.IMPORT_DISPOSITION_REVIEW_REQUIRED
	second.Rows = []*importing.RawImportRow{
		plannerRow(uid, 702, 201, 2001, 11, 1000, 1700000005, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 702, 202, 2002, 11, 2500, 1700000100, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 702, 203, 2003, 11, 6000, 1700000500, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_UNKNOWN),
	}
	second.Rows[0].SourceMerchantOrderId = "ORDER-STRONG-0001"
	second.Rows[1].RawCounterparty = "同一商户"
	second.Rows[2].RawCounterparty = "商户乙"

	plan, err := organizer.BuildOrganizePlan(uid, 501, []*organizer.PlanningSource{first, second}, map[int64]*models.Account{11: account}, 1700001000, sequentialPlannerIds(9000))
	if err != nil {
		t.Fatalf("build organizer plan: %v", err)
	}
	if plan.ValidEvidenceCount != 8 || plan.DuplicateEvidenceCount != 2 || plan.FinalEventCount != 6 ||
		plan.ReadyEventCount != 4 || plan.NeedsActionEventCount != 1 || plan.ExcludedEventCount != 1 {
		t.Fatalf("unexpected conservation counts: %+v", plan)
	}
	merged := findEventByAmount(plan.Events, 1000)
	if merged == nil || merged.Status != organizer.EVENT_STATUS_READY || merged.EconomicNature != organizer.ECONOMIC_NATURE_EXPENSE ||
		!strings.Contains(merged.ReasonCodesJson, "auto_same_event") {
		t.Fatalf("strong cross-source event was not merged: %+v", merged)
	}
	if countEventsByAmount(plan.Events, 2500) != 1 {
		t.Fatalf("matching cross-source text was not treated as strong evidence: %+v", plan.Events)
	}
	if countEventsByAmount(plan.Events, 6000) != 2 {
		t.Fatalf("same amount/time with conflicting text was merged: %+v", plan.Events)
	}
	inflow := findEventByAmount(plan.Events, 3000)
	if inflow == nil || inflow.Status != organizer.EVENT_STATUS_NEEDS_ACTION || inflow.EconomicNature != organizer.ECONOMIC_NATURE_UNKNOWN {
		t.Fatalf("direction-only inflow was treated as income: %+v", inflow)
	}
	excluded := findEventByAmount(plan.Events, 5000)
	if excluded == nil || excluded.Status != organizer.EVENT_STATUS_EXCLUDED {
		t.Fatalf("explicitly ignored evidence was not isolated: %+v", excluded)
	}
}

func TestBuildOrganizePlanPairsRepaymentsTransfersAndIsolatesAmbiguity(t *testing.T) {
	const uid = int64(202)
	asset := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)
	credit := plannerAccount(uid, 22, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	savings := plannerAccount(uid, 33, models.ACCOUNT_CATEGORY_SAVINGS_ACCOUNT)
	source := plannerSource(uid, 502, 0, 603, 703, importing.SOURCE_TYPE_BANK)
	source.Rows = []*importing.RawImportRow{
		plannerRow(uid, 703, 1, 3001, 11, 5000, 1700010000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_TRANSFER),
		plannerRow(uid, 703, 2, 3002, 22, 5000, 1700010010, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER),
		plannerRow(uid, 703, 3, 3003, 11, 8000, 1700020000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_TRANSFER),
		plannerRow(uid, 703, 4, 3004, 33, 8000, 1700020010, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_TOP_UP),
		plannerRow(uid, 703, 5, 3005, 11, 9000, 1700030000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_TRANSFER),
		plannerRow(uid, 703, 6, 3006, 33, 9000, 1700030010, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_TOP_UP),
		plannerRow(uid, 703, 7, 3007, 33, 9000, 1700030020, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_TOP_UP),
	}
	source.Rows[1].RawCounterparty = "信用卡账单还款"
	plan, err := organizer.BuildOrganizePlan(uid, 502, []*organizer.PlanningSource{source}, map[int64]*models.Account{11: asset, 22: credit, 33: savings}, 1700040000, sequentialPlannerIds(10000))
	if err != nil {
		t.Fatalf("build transfer plan: %v", err)
	}
	if plan.ValidEvidenceCount != 7 || plan.DuplicateEvidenceCount != 2 || plan.FinalEventCount != 5 ||
		plan.ReadyEventCount != 2 || plan.NeedsActionEventCount != 3 {
		t.Fatalf("unexpected transfer conservation: %+v", plan)
	}
	repayment := findEventByNature(plan.Events, organizer.ECONOMIC_NATURE_REPAYMENT)
	if repayment == nil || repayment.Status != organizer.EVENT_STATUS_READY || repayment.FlowDirection != organizer.FLOW_DIRECTION_NEUTRAL ||
		repayment.LedgerAccountId == nil || *repayment.LedgerAccountId != 11 || repayment.CounterpartyLedgerAccountId == nil || *repayment.CounterpartyLedgerAccountId != 22 {
		t.Fatalf("credit repayment pair mismatch: %+v", repayment)
	}
	transfer := findEventByNature(plan.Events, organizer.ECONOMIC_NATURE_INTERNAL_TRANSFER)
	if transfer == nil || transfer.Status != organizer.EVENT_STATUS_READY || transfer.CounterpartyLedgerAccountId == nil || *transfer.CounterpartyLedgerAccountId != 33 {
		t.Fatalf("internal transfer pair mismatch: %+v", transfer)
	}
	for _, event := range plan.Events {
		if event.Amount != nil && *event.Amount == 9000 && (event.Status != organizer.EVENT_STATUS_NEEDS_ACTION || !strings.Contains(event.ReasonCodesJson, "relation_ambiguous")) {
			t.Fatalf("ambiguous transfer was not isolated: %+v", event)
		}
	}
}

func TestBuildOrganizePlanPreservesExactAmbiguousSameEventComponent(t *testing.T) {
	const uid = int64(242)
	const updateId = int64(542)
	account := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	sources := []*organizer.PlanningSource{
		plannerSource(uid, updateId, 0, 641, 741, importing.SOURCE_TYPE_ALIPAY),
		plannerSource(uid, updateId, 1, 642, 742, importing.SOURCE_TYPE_WECHAT),
		plannerSource(uid, updateId, 2, 643, 743, importing.SOURCE_TYPE_BANK),
	}
	for index, source := range sources {
		row := plannerRow(uid, source.Batch.BatchId, int64(11+index), int64(3411+index), 11, 4350,
			1703010000+int64(index), importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
		row.RawCounterparty = "1688 平台商家"
		row.RawItem = "同一商品"
		source.Rows = []*importing.RawImportRow{row}
	}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, sources, map[int64]*models.Account{11: account},
		1703020000, sequentialPlannerIds(10400))
	if err != nil {
		t.Fatalf("build ambiguous same-event plan: %v", err)
	}
	if plan.FinalEventCount != 3 || plan.NeedsActionEventCount != 3 || plan.ReadyEventCount != 0 ||
		len(plan.SameEventCandidateGroups) != 1 {
		t.Fatalf("ambiguous same-event component mismatch: %+v", plan)
	}
	for key, eventIds := range plan.SameEventCandidateGroups {
		if len(key) != 64 || len(eventIds) != 3 {
			t.Fatalf("same-event candidate key mismatch: key=%q events=%v", key, eventIds)
		}
	}
	for _, event := range plan.Events {
		if event.Status != organizer.EVENT_STATUS_NEEDS_ACTION || !strings.Contains(event.ReasonCodesJson, "relation_ambiguous") {
			t.Fatalf("ambiguous same-event member escaped review: %+v", event)
		}
	}
}

func TestBuildOrganizePlanMergesBalancedDateOnlyBankEvidence(t *testing.T) {
	const uid = int64(252)
	bank := plannerSource(uid, 552, 0, 653, 753, importing.SOURCE_TYPE_BANK)
	detail := plannerSource(uid, 552, 1, 654, 754, importing.SOURCE_TYPE_ALIPAY)
	bankRow := plannerRow(uid, 753, 1, 3501, 11, 8800, 1704067200, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	detailRow := plannerRow(uid, 754, 2, 3502, 11, 8800, 1704110400, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	zeroOffset := int16(0)
	bankRow.NormalizedTimezoneUtcOffset = &zeroOffset
	detailRow.NormalizedTimezoneUtcOffset = &zeroOffset
	bankRow.RawCounterparty = "月结摘要"
	detailRow.RawCounterparty = "渠道商户"
	bank.Rows = []*importing.RawImportRow{bankRow}
	detail.Rows = []*importing.RawImportRow{detailRow}
	plan, err := organizer.BuildOrganizePlan(uid, 552, []*organizer.PlanningSource{bank, detail},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)}, 1704200000, sequentialPlannerIds(10500))
	if err != nil {
		t.Fatalf("build balanced statement plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 || plan.ReadyEventCount != 1 ||
		!strings.Contains(plan.Events[0].ReasonCodesJson, "auto_same_event") {
		t.Fatalf("balanced statement evidence was not merged: %+v", plan)
	}
}

func TestBuildOrganizePlanSplitsLegacyV1ContentFingerprintRows(t *testing.T) {
	const uid = int64(262)
	const updateId = int64(562)
	source := plannerSource(uid, updateId, 0, 655, 755, importing.SOURCE_TYPE_BANK)
	rows := make([]*importing.RawImportRow, 0, 4)
	locators := []string{"v1:pdf:1:17", "v1:pdf:1:19", "v1:pdf:1:38", "v1:pdf:1:40"}
	for index := 0; index < 4; index++ {
		row := plannerRow(uid, 755, int64(21+index), 3601, 11, 4350, 1704067200,
			importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
		row.SourceLocator = locators[index]
		row.RawCounterparty = "支付宝朱永灵"
		row.RawItem = "相同内容"
		rows = append(rows, row)
	}
	source.Rows = rows

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704200000, sequentialPlannerIds(10600))
	if err != nil {
		t.Fatalf("build legacy content-fingerprint plan: %v", err)
	}
	if plan.ValidEvidenceCount != 4 || plan.DuplicateEvidenceCount != 0 || plan.FinalEventCount != 4 ||
		plan.ReadyEventCount != 4 || plan.NeedsActionEventCount != 0 {
		t.Fatalf("legacy v1 physical rows were still collapsed: %+v", plan)
	}
}

func TestBuildOrganizePlanReusesLegacyV1PhysicalRecordAcrossReparse(t *testing.T) {
	const uid = int64(265)
	const updateId = int64(565)
	const fileId = int64(659)
	firstSource := plannerSource(uid, updateId, 0, fileId, 759, importing.SOURCE_TYPE_BANK)
	secondSource := plannerSource(uid, updateId, 1, fileId, 760, importing.SOURCE_TYPE_BANK)
	secondSource.Source.SourceAccountId = clonePlannerInt64(firstSource.Source.SourceAccountId)
	secondSource.Batch.SourceAccountId = clonePlannerInt64(firstSource.Batch.SourceAccountId)
	first := plannerRow(uid, firstSource.Batch.BatchId, 61, 4001, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	second := plannerRow(uid, secondSource.Batch.BatchId, 62, 4002, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	for _, row := range []*importing.RawImportRow{first, second} {
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
		row.SourceLocator = "v1:pdf:1:17"
		row.RawCounterparty = "支付宝朱永灵"
	}
	firstSource.Rows = []*importing.RawImportRow{first}
	secondSource.Rows = []*importing.RawImportRow{second}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{firstSource, secondSource},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704200000, sequentialPlannerIds(10650))
	if err != nil {
		t.Fatalf("build legacy physical-record reparse plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 ||
		plan.ReadyEventCount != 1 || len(plan.Evidence) != 2 {
		t.Fatalf("legacy same-locator reparse was not reused: %+v", plan)
	}
}

func TestBuildOrganizePlanReusesPhysicalRecordWhenReparseAddsStableIdentifier(t *testing.T) {
	const uid = int64(266)
	const updateId = int64(566)
	const fileId = int64(660)
	firstSource := plannerSource(uid, updateId, 0, fileId, 761, importing.SOURCE_TYPE_BANK)
	secondSource := plannerSource(uid, updateId, 1, fileId, 762, importing.SOURCE_TYPE_BANK)
	secondSource.Source.SourceAccountId = clonePlannerInt64(firstSource.Source.SourceAccountId)
	secondSource.Batch.SourceAccountId = clonePlannerInt64(firstSource.Batch.SourceAccountId)
	physical := plannerRow(uid, firstSource.Batch.BatchId, 63, 4011, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	stable := plannerRow(uid, secondSource.Batch.BatchId, 64, 4012, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	for _, source := range []*organizer.PlanningSource{firstSource, secondSource} {
		source.Source.IdentityKeyVersion = organizer.RuleVersion(importing.IDENTITY_KEY_VERSION_V2)
		source.Batch.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V2
	}
	physical.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V2
	stable.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
	stable.SourceTransactionId = "newly-extracted-stable-id"
	for _, row := range []*importing.RawImportRow{physical, stable} {
		row.SourceLocator = "v1:pdf:1:19"
		row.RawCounterparty = "支付宝朱永灵"
	}
	firstSource.Rows = []*importing.RawImportRow{physical}
	secondSource.Rows = []*importing.RawImportRow{stable}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{firstSource, secondSource},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704200000, sequentialPlannerIds(10675))
	if err != nil {
		t.Fatalf("build upgraded physical-record identity plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 ||
		plan.ReadyEventCount != 1 || len(plan.Evidence) != 2 {
		t.Fatalf("stable identifier upgrade duplicated one physical record: %+v", plan)
	}
}

func TestBuildOrganizePlanDoesNotReusePhysicalRecordAcrossSourceAccounts(t *testing.T) {
	const uid = int64(267)
	const updateId = int64(567)
	const fileId = int64(661)
	firstSource := plannerSource(uid, updateId, 0, fileId, 763, importing.SOURCE_TYPE_BANK)
	secondSource := plannerSource(uid, updateId, 1, fileId, 764, importing.SOURCE_TYPE_BANK)
	first := plannerRow(uid, firstSource.Batch.BatchId, 65, 4021, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	second := plannerRow(uid, secondSource.Batch.BatchId, 66, 4022, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	for _, row := range []*importing.RawImportRow{first, second} {
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
		row.SourceLocator = "v1:pdf:1:20"
		row.RawCounterparty = "支付宝朱永灵"
	}
	firstSource.Rows = []*importing.RawImportRow{first}
	secondSource.Rows = []*importing.RawImportRow{second}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{firstSource, secondSource},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704200000, sequentialPlannerIds(10690))
	if err != nil {
		t.Fatalf("build cross-account physical-record plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 0 || plan.FinalEventCount != 2 ||
		plan.ReadyEventCount != 2 || len(plan.Evidence) != 2 {
		t.Fatalf("same locator across source accounts was merged: %+v", plan)
	}
}

func TestBuildOrganizePlanKeepsLegacyV1StableTransactionIdentity(t *testing.T) {
	const uid = int64(263)
	const updateId = int64(563)
	source := plannerSource(uid, updateId, 0, 656, 756, importing.SOURCE_TYPE_ALIPAY)
	first := plannerRow(uid, 756, 31, 3701, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	second := plannerRow(uid, 756, 32, 3701, 11, 4350, 1704067200,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	for _, row := range []*importing.RawImportRow{first, second} {
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
		row.SourceTransactionId = "stable-transaction-001"
	}
	source.Rows = []*importing.RawImportRow{first, second}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)},
		1704200000, sequentialPlannerIds(10700))
	if err != nil {
		t.Fatalf("build legacy stable-identity plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 ||
		plan.ReadyEventCount != 1 {
		t.Fatalf("legacy stable source identity was not preserved: %+v", plan)
	}
}

func TestBuildOrganizePlanPreservesMultiplicityAcrossTwoByTwoSources(t *testing.T) {
	const uid = int64(264)
	const updateId = int64(564)
	bank := plannerSource(uid, updateId, 0, 657, 757, importing.SOURCE_TYPE_BANK)
	detail := plannerSource(uid, updateId, 1, 658, 758, importing.SOURCE_TYPE_ALIPAY)
	zeroOffset := int16(0)
	bank.Rows = []*importing.RawImportRow{
		plannerRow(uid, 757, 41, 3801, 11, 4350, 1704067200, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_OTHER),
		plannerRow(uid, 757, 42, 3802, 11, 4350, 1704067200, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_OTHER),
	}
	detail.Rows = []*importing.RawImportRow{
		plannerRow(uid, 758, 51, 3901, 11, 4350, 1704110400, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
		plannerRow(uid, 758, 52, 3902, 11, 4350, 1704114000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
	}
	for _, row := range bank.Rows {
		row.NormalizedTimezoneUtcOffset = &zeroOffset
		row.RawCounterparty = "支付宝朱永灵"
	}
	for index, row := range detail.Rows {
		row.NormalizedTimezoneUtcOffset = &zeroOffset
		row.RawCounterparty = "支付宝朱永灵"
		row.SourceTransactionId = []string{"alipay-001", "alipay-002"}[index]
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
	}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{bank, detail},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704200000, sequentialPlannerIds(10800))
	if err != nil {
		t.Fatalf("build two-by-two cross-source plan: %v", err)
	}
	if plan.ValidEvidenceCount != 4 || plan.DuplicateEvidenceCount != 2 || plan.FinalEventCount != 2 ||
		plan.ReadyEventCount != 2 || len(plan.Evidence) != 4 {
		t.Fatalf("cross-source multiplicity was not preserved: %+v", plan)
	}
	for _, event := range plan.Events {
		if !strings.Contains(event.ReasonCodesJson, "auto_same_event") {
			t.Fatalf("balanced pair was not recorded as one event with supporting evidence: %+v", event)
		}
	}
}

func TestBuildOrganizePlanLinksUniqueRefundsAndRejectsExcess(t *testing.T) {
	for _, test := range []struct {
		name              string
		refundAmounts     []int64
		wantReady         int64
		wantNeedsAction   int64
		wantRelationState organizer.RelationStatus
	}{
		{name: "within original amount", refundAmounts: []int64{400, 500}, wantReady: 3, wantRelationState: organizer.RELATION_STATUS_CONFIRMED},
		{name: "exceeds original amount", refundAmounts: []int64{600, 500}, wantReady: 1, wantNeedsAction: 2, wantRelationState: organizer.RELATION_STATUS_PROPOSED},
	} {
		t.Run(test.name, func(t *testing.T) {
			const uid = int64(303)
			source := plannerSource(uid, 503, 0, 604, 704, importing.SOURCE_TYPE_ALIPAY)
			source.Rows = []*importing.RawImportRow{
				plannerRow(uid, 704, 1, 4001, 11, 1000, 1700100000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
				plannerRow(uid, 704, 2, 4002, 11, test.refundAmounts[0], 1700200000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
				plannerRow(uid, 704, 3, 4003, 11, test.refundAmounts[1], 1700300000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT),
			}
			for _, row := range source.Rows {
				row.RawCounterparty = "示例商户"
				row.RawItem = "商品"
			}
			source.Rows[1].EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
			source.Rows[2].EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
			plan, err := organizer.BuildOrganizePlan(uid, 503, []*organizer.PlanningSource{source}, map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1700400000, sequentialPlannerIds(11000))
			if err != nil {
				t.Fatalf("build refund plan: %v", err)
			}
			if plan.ReadyEventCount != test.wantReady || plan.NeedsActionEventCount != test.wantNeedsAction || len(plan.Relations) != 2 {
				t.Fatalf("unexpected refund plan: %+v", plan)
			}
			for _, relation := range plan.Relations {
				if relation.RelationType != organizer.RELATION_TYPE_REFUND_OF || relation.Status != test.wantRelationState {
					t.Fatalf("refund relation mismatch: %+v", relation)
				}
			}
		})
	}
}

func TestBuildOrganizePlanUsesExplicitPartialRefundEvidence(t *testing.T) {
	const uid = int64(353)
	source := plannerSource(uid, 553, 0, 655, 755, importing.SOURCE_TYPE_WECHAT)
	original := plannerRow(uid, 755, 1, 4501, 11, 1000, 1700100000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	refund := plannerRow(uid, 755, 2, 4502, 11, 400, 1700200000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	original.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	refund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	original.RawStatus = "退款 ￥4.00"
	original.RawCounterparty = "示例商户"
	refund.RawCounterparty = "示例商户"
	original.RawItem = "原商品"
	refund.RawItem = "退款记录"
	source.Rows = []*importing.RawImportRow{original, refund}
	plan, err := organizer.BuildOrganizePlan(uid, 553, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1700300000, sequentialPlannerIds(11500))
	if err != nil {
		t.Fatalf("build explicit refund plan: %v", err)
	}
	if plan.FinalEventCount != 2 || plan.ReadyEventCount != 2 || plan.NeedsActionEventCount != 0 || len(plan.Relations) != 1 ||
		plan.Relations[0].RelationType != organizer.RELATION_TYPE_REFUND_OF || plan.Relations[0].Status != organizer.RELATION_STATUS_CONFIRMED {
		t.Fatalf("explicit partial refund was not linked: %+v", plan)
	}
}

func TestBuildOrganizePlanIsolatesIdentityConflictAndMissingAccount(t *testing.T) {
	const uid = int64(404)
	source := plannerSource(uid, 504, 0, 605, 705, importing.SOURCE_TYPE_BANK)
	first := plannerRow(uid, 705, 1, 5001, 11, 1000, 1701000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	conflict := plannerRow(uid, 705, 2, 5001, 11, 2000, 1701000000, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	missingAccount := plannerRow(uid, 705, 3, 5003, 99, 3000, 1701000100, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	first.IdentityState = importing.IDENTITY_STATE_IDENTITY_CONFLICT
	conflict.IdentityState = importing.IDENTITY_STATE_IDENTITY_CONFLICT
	source.Rows = []*importing.RawImportRow{first, conflict, missingAccount}
	plan, err := organizer.BuildOrganizePlan(uid, 504, []*organizer.PlanningSource{source}, map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1701001000, sequentialPlannerIds(12000))
	if err != nil {
		t.Fatalf("build conflict plan: %v", err)
	}
	if plan.ValidEvidenceCount != 3 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 2 || plan.NeedsActionEventCount != 2 {
		t.Fatalf("conflict conservation mismatch: %+v", plan)
	}
	for _, event := range plan.Events {
		if event.Status != organizer.EVENT_STATUS_NEEDS_ACTION {
			t.Fatalf("conflicted event escaped isolation: %+v", event)
		}
	}
}

func plannerSource(uid int64, updateId int64, order int64, fileId int64, batchId int64, sourceType importing.SourceType) *organizer.PlanningSource {
	sourceAccountId := batchId + 10000
	return &organizer.PlanningSource{
		Source: &organizer.FinanceUpdateSource{
			Uid: uid, UpdateId: updateId, SourceOrder: order, FileId: fileId, BatchId: batchId, SourceAccountId: &sourceAccountId,
			SourceTypeSnapshot: string(sourceType), ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1",
			IdentityKeyVersion: "identity-v1", CreatedUnixTime: 10, SourceId: batchId + 20000,
		},
		Batch: &importing.ImportBatch{
			Uid: uid, FileId: fileId, SourceAccountId: &sourceAccountId, Status: importing.IMPORT_BATCH_STATUS_READY,
			SourceTypeSnapshot: sourceType, ParserVersion: "parser-v1", NormalizationVersion: "normalization-v1",
			IdentityKeyVersion: "identity-v1", BatchId: batchId,
		},
	}
}

func plannerRow(uid int64, batchId int64, rowId int64, identityId int64, ledgerAccountId int64, amount int64, unixTime int64, direction importing.NormalizedDirection, transactionType importing.SourceTransactionType) *importing.RawImportRow {
	offset := int16(480)
	return &importing.RawImportRow{
		Uid: uid, BatchId: batchId, ParseState: importing.PARSE_STATE_VALID, IdentityState: importing.IDENTITY_STATE_NEW,
		ProcessingState: importing.PROCESSING_STATE_PENDING, IdentityId: &identityId, NormalizedUnixTime: &unixTime,
		NormalizedTimezoneUtcOffset: &offset, NormalizedAmount: &amount, Currency: "CNY", NormalizedDirection: direction,
		NormalizedTransactionType: transactionType, EconomicEffect: importing.ECONOMIC_EFFECT_NORMAL,
		LedgerAccountId: &ledgerAccountId, SemanticEligibility: importing.SEMANTIC_ELIGIBILITY_POSTABLE,
		Disposition: importing.IMPORT_DISPOSITION_POSTABLE, IdentityKeyVersion: importing.IDENTITY_KEY_VERSION_V2, RowId: rowId,
	}
}

func clonePlannerInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func plannerAccount(uid int64, accountId int64, category models.AccountCategory) *models.Account {
	return &models.Account{Uid: uid, AccountId: accountId, Category: category, Currency: "CNY"}
}

func sequentialPlannerIds(start int64) func() int64 {
	return func() int64 {
		start++
		return start
	}
}

func findEventByAmount(events []*organizer.EconomicEvent, amount int64) *organizer.EconomicEvent {
	for _, event := range events {
		if event.Amount != nil && *event.Amount == amount {
			return event
		}
	}
	return nil
}

func countEventsByAmount(events []*organizer.EconomicEvent, amount int64) int {
	count := 0
	for _, event := range events {
		if event.Amount != nil && *event.Amount == amount {
			count++
		}
	}
	return count
}

func findEventByNature(events []*organizer.EconomicEvent, nature organizer.EconomicNature) *organizer.EconomicEvent {
	for _, event := range events {
		if event.EconomicNature == nature {
			return event
		}
	}
	return nil
}
