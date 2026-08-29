package organizer_test

import (
	"strings"
	"testing"

	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

func TestBuildOrganizePlanConservesEvidenceAndUsesNormalizedIncome(t *testing.T) {
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
		plan.ReadyEventCount != 5 || plan.NeedsActionEventCount != 0 || plan.ExcludedEventCount != 1 {
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
	if inflow == nil || inflow.Status != organizer.EVENT_STATUS_READY || inflow.EconomicNature != organizer.ECONOMIC_NATURE_INCOME {
		t.Fatalf("normalized ordinary inflow was not treated as income: %+v", inflow)
	}
	excluded := findEventByAmount(plan.Events, 5000)
	if excluded == nil || excluded.Status != organizer.EVENT_STATUS_EXCLUDED {
		t.Fatalf("explicitly ignored evidence was not isolated: %+v", excluded)
	}
}

func TestBuildOrganizePlanKeepsClosedAndFailedReasonsForAudit(t *testing.T) {
	const uid = int64(102)
	source := plannerSource(uid, 505, 0, 605, 705, importing.SOURCE_TYPE_ALIPAY)
	closed := plannerRow(uid, 705, 107, 1007, 11, 100, 1700000600, importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	failed := plannerRow(uid, 705, 108, 1008, 11, 200, 1700000700, importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	closed.EconomicEffect = importing.ECONOMIC_EFFECT_CLOSED
	closed.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE
	closed.Disposition = importing.IMPORT_DISPOSITION_NON_POSTABLE
	closed.ProcessingState = importing.PROCESSING_STATE_IGNORED
	failed.EconomicEffect = importing.ECONOMIC_EFFECT_FAILED
	failed.SemanticEligibility = importing.SEMANTIC_ELIGIBILITY_NON_POSTABLE
	failed.Disposition = importing.IMPORT_DISPOSITION_NON_POSTABLE
	failed.ProcessingState = importing.PROCESSING_STATE_IGNORED
	source.Rows = []*importing.RawImportRow{closed, failed}

	plan, err := organizer.BuildOrganizePlan(uid, 505, []*organizer.PlanningSource{source}, map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1700001000, sequentialPlannerIds(9500))
	if err != nil {
		t.Fatalf("build organizer plan: %v", err)
	}
	if len(plan.Events) != 2 || !strings.Contains(plan.Events[0].ReasonCodesJson, "transaction_closed") || !strings.Contains(plan.Events[1].ReasonCodesJson, "transaction_failed") {
		t.Fatalf("closed/failed audit reasons missing: %+v", plan.Events)
	}
}

func TestBuildOrganizePlanKeepsUnsafeProjectedFundsInReview(t *testing.T) {
	const uid = int64(152)
	for _, test := range []struct {
		name string
		to   *int64
	}{
		{name: "missing destination"},
		{name: "same account", to: int64TestPointer(11)},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := plannerSource(uid, 555, 0, 655, 755, importing.SOURCE_TYPE_WECHAT)
			row := plannerRow(uid, 755, 155, 1155, 11, 1001, 1700000800, importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL)
			source.Rows = []*importing.RawImportRow{row}
			source.FundsMovements = map[int64]*organizer.PlanningFundsMovement{row.RowId: {
				Kind: importing.SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER, FromLedgerAccountId: int64TestPointer(11),
				ToLedgerAccountId: test.to, RuleVersion: importing.SOURCE_FUNDS_RULE_VERSION_V1,
			}}
			plan, err := organizer.BuildOrganizePlan(uid, 555, []*organizer.PlanningSource{source},
				map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)},
				1700001000, sequentialPlannerIds(9800))
			if err != nil {
				t.Fatalf("build projected funds plan: %v", err)
			}
			event := plan.Events[0]
			if event.Status != organizer.EVENT_STATUS_NEEDS_ACTION || event.EconomicNature != organizer.ECONOMIC_NATURE_INTERNAL_TRANSFER ||
				!strings.Contains(event.ReasonCodesJson, "transfer_account_required") {
				t.Fatalf("unsafe projected movement escaped review: %+v", event)
			}
		})
	}
}

func TestBuildOrganizePlanMergesProjectedRepaymentWithUniqueBankEvidence(t *testing.T) {
	const uid = int64(1823)
	const updateId = int64(5823)
	asset := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)
	credit := plannerAccount(uid, 22, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	wechat := plannerSource(uid, updateId, 0, 6823, 7823, importing.SOURCE_TYPE_WECHAT)
	bank := plannerSource(uid, updateId, 1, 6824, 7824, importing.SOURCE_TYPE_BANK)
	projected := plannerRow(uid, 7823, 18231, 28231, 11, 550550, 1785995784,
		importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_TRANSFER)
	projected.RawTransactionType = "信用卡还款"
	projected.RawCounterparty = "兴业银行信用卡还款"
	statement := plannerRow(uid, 7824, 18232, 28232, 22, 550550, 1785996000,
		importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	statement.RawCounterparty = "款项转入-信用卡还款"
	wechat.Rows = []*importing.RawImportRow{projected}
	wechat.FundsMovements = map[int64]*organizer.PlanningFundsMovement{projected.RowId: {
		Kind: importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT, FromLedgerAccountId: int64TestPointer(11),
		ToLedgerAccountId: int64TestPointer(22), RuleVersion: importing.SOURCE_FUNDS_RULE_VERSION_V1,
	}}
	bank.Rows = []*importing.RawImportRow{statement}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{wechat, bank},
		map[int64]*models.Account{11: asset, 22: credit}, 1786000000, sequentialPlannerIds(182300))
	if err != nil {
		t.Fatalf("build projected repayment evidence plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 ||
		plan.ReadyEventCount != 1 || len(plan.Evidence) != 2 {
		t.Fatalf("projected repayment bank evidence was not conserved: %+v", plan)
	}
	event := plan.Events[0]
	if event.EconomicNature != organizer.ECONOMIC_NATURE_REPAYMENT || event.Status != organizer.EVENT_STATUS_READY ||
		event.LedgerAccountId == nil || *event.LedgerAccountId != 11 ||
		event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId != 22 ||
		!strings.Contains(event.ReasonCodesJson, "auto_same_event") {
		t.Fatalf("projected repayment did not retain platform semantics with bank evidence: %+v", event)
	}
}

func TestBuildOrganizePlanKeepsAmbiguousRepaymentBankEvidenceForReview(t *testing.T) {
	const uid = int64(1824)
	const updateId = int64(5824)
	asset := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)
	credit := plannerAccount(uid, 22, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	wechat := plannerSource(uid, updateId, 0, 6831, 7831, importing.SOURCE_TYPE_WECHAT)
	bank := plannerSource(uid, updateId, 1, 6832, 7832, importing.SOURCE_TYPE_BANK)
	projected := plannerRow(uid, 7831, 18301, 28301, 11, 550550, 1785995784,
		importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_TRANSFER)
	projected.RawTransactionType = "信用卡还款"
	wechat.Rows = []*importing.RawImportRow{projected}
	wechat.FundsMovements = map[int64]*organizer.PlanningFundsMovement{projected.RowId: {
		Kind: importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT, FromLedgerAccountId: int64TestPointer(11),
		ToLedgerAccountId: int64TestPointer(22), RuleVersion: importing.SOURCE_FUNDS_RULE_VERSION_V1,
	}}
	bank.Rows = []*importing.RawImportRow{
		plannerRow(uid, 7832, 18302, 28302, 22, 550550, 1785995900, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER),
		plannerRow(uid, 7832, 18303, 28303, 22, 550550, 1785996000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER),
	}
	for _, row := range bank.Rows {
		row.RawCounterparty = "款项转入-信用卡还款"
	}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{wechat, bank},
		map[int64]*models.Account{11: asset, 22: credit}, 1786000000, sequentialPlannerIds(182400))
	if err != nil {
		t.Fatalf("build ambiguous repayment evidence plan: %v", err)
	}
	if plan.FinalEventCount != 3 || plan.DuplicateEvidenceCount != 0 || plan.ReadyEventCount != 0 ||
		plan.NeedsActionEventCount != 3 || len(plan.SameEventCandidateGroups) != 1 {
		t.Fatalf("ambiguous repayment evidence escaped review: %+v", plan)
	}
	for _, event := range plan.Events {
		if !strings.Contains(event.ReasonCodesJson, "relation_ambiguous") {
			t.Fatalf("ambiguous repayment candidate lacks review reason: %+v", event)
		}
	}
}

func TestBuildOrganizePlanDoesNotMergeOrdinaryBankInflowIntoProjectedRepayment(t *testing.T) {
	const uid = int64(1825)
	const updateId = int64(5825)
	asset := plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)
	credit := plannerAccount(uid, 22, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	wechat := plannerSource(uid, updateId, 0, 6841, 7841, importing.SOURCE_TYPE_WECHAT)
	bank := plannerSource(uid, updateId, 1, 6842, 7842, importing.SOURCE_TYPE_BANK)
	projected := plannerRow(uid, 7841, 18401, 28401, 11, 550550, 1785995784,
		importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_TRANSFER)
	ordinary := plannerRow(uid, 7842, 18402, 28402, 22, 550550, 1785995900,
		importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	ordinary.RawCounterparty = "普通入账"
	wechat.Rows = []*importing.RawImportRow{projected}
	wechat.FundsMovements = map[int64]*organizer.PlanningFundsMovement{projected.RowId: {
		Kind: importing.SOURCE_FUNDS_MOVEMENT_REPAYMENT, FromLedgerAccountId: int64TestPointer(11),
		ToLedgerAccountId: int64TestPointer(22), RuleVersion: importing.SOURCE_FUNDS_RULE_VERSION_V1,
	}}
	bank.Rows = []*importing.RawImportRow{ordinary}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{wechat, bank},
		map[int64]*models.Account{11: asset, 22: credit}, 1786000000, sequentialPlannerIds(182500))
	if err != nil {
		t.Fatalf("build ordinary bank inflow plan: %v", err)
	}
	if plan.FinalEventCount != 2 || plan.DuplicateEvidenceCount != 0 {
		t.Fatalf("ordinary equal bank inflow was merged into repayment: %+v", plan)
	}
}

func TestBuildOrganizePlanKeepsKnownCreditCardAsRepaymentTarget(t *testing.T) {
	const uid = int64(1826)
	const updateId = int64(5826)
	credit := plannerAccount(uid, 22, models.ACCOUNT_CATEGORY_CREDIT_CARD)
	bank := plannerSource(uid, updateId, 0, 6851, 7851, importing.SOURCE_TYPE_BANK)
	statement := plannerRow(uid, 7851, 18501, 28501, 22, 550550, 1785996000,
		importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	statement.RawCounterparty = "款项转入-信用卡还款"
	bank.Rows = []*importing.RawImportRow{statement}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{bank},
		map[int64]*models.Account{22: credit}, 1786000000, sequentialPlannerIds(182600))
	if err != nil {
		t.Fatalf("build single-sided repayment plan: %v", err)
	}
	event := plan.Events[0]
	if event.EconomicNature != organizer.ECONOMIC_NATURE_REPAYMENT || event.Status != organizer.EVENT_STATUS_NEEDS_ACTION ||
		event.LedgerAccountId != nil || event.CounterpartyLedgerAccountId == nil || *event.CounterpartyLedgerAccountId != 22 ||
		!strings.Contains(event.ReasonCodesJson, "repayment_account_required") {
		t.Fatalf("known credit card was not retained as repayment target: %+v", event)
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

func TestBuildOrganizePlanUsesBankPostingDateForPlatformRefundEvidence(t *testing.T) {
	const uid = int64(254)
	const updateId = int64(554)
	bank := plannerSource(uid, updateId, 0, 665, 765, importing.SOURCE_TYPE_BANK)
	alipay := plannerSource(uid, updateId, 1, 666, 766, importing.SOURCE_TYPE_ALIPAY)
	bankRefund := plannerRow(uid, 765, 12, 3612, 11, 8250, 1704067200,
		importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	alipayRefund := plannerRow(uid, 766, 22, 4612, 11, 8250, 1704196800,
		importing.NORMALIZED_DIRECTION_NEUTRAL, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	zeroOffset := int16(0)
	bankRefund.NormalizedTimezoneUtcOffset = &zeroOffset
	bankRefund.RawCounterparty = "网上支付 支付宝 合成商户"
	bankRefund.RawNote = "2024/01/02"
	alipayRefund.NormalizedTimezoneUtcOffset = &zeroOffset
	alipayRefund.RawCounterparty = "合成商户"
	alipayRefund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	alipayRefund.RawStatus = "退款成功"
	bank.Rows = []*importing.RawImportRow{bankRefund}
	alipay.Rows = []*importing.RawImportRow{alipayRefund}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{bank, alipay},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1704300000, sequentialPlannerIds(10900))
	if err != nil {
		t.Fatalf("build posting-date refund plan: %v", err)
	}
	if plan.ValidEvidenceCount != 2 || plan.DuplicateEvidenceCount != 1 || plan.FinalEventCount != 1 ||
		plan.ReadyEventCount != 1 || plan.NeedsActionEventCount != 0 || len(plan.Evidence) != 2 ||
		plan.Events[0].EconomicNature != organizer.ECONOMIC_NATURE_REFUND ||
		!strings.Contains(plan.Events[0].ReasonCodesJson, "auto_same_event") {
		t.Fatalf("bank posting-date refund evidence was not merged: %+v", plan)
	}
}

func TestBuildOrganizePlanMergesBankEvidenceIntoExplicitPartialRefund(t *testing.T) {
	const uid = int64(253)
	const updateId = int64(553)
	bank := plannerSource(uid, updateId, 0, 663, 763, importing.SOURCE_TYPE_BANK)
	wechat := plannerSource(uid, updateId, 1, 664, 764, importing.SOURCE_TYPE_WECHAT)
	bankOriginal := plannerRow(uid, 763, 11, 3601, 11, 5777, 1783699200, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	bankRefund := plannerRow(uid, 763, 12, 3602, 11, 20, 1783699200, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_OTHER)
	wechatOriginal := plannerRow(uid, 764, 21, 4601, 11, 5777, 1783751092, importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	wechatRefund := plannerRow(uid, 764, 22, 4602, 11, 20, 1783760242, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	zeroOffset := int16(0)
	for _, row := range []*importing.RawImportRow{bankOriginal, bankRefund, wechatOriginal, wechatRefund} {
		row.NormalizedTimezoneUtcOffset = &zeroOffset
		row.RawCounterparty = "美团平台商户"
	}
	wechatOriginal.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	wechatRefund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	wechatOriginal.RawStatus = "已退款(¥0.20)"
	wechatRefund.RawStatus = "已退款¥0.20"
	bank.Rows = []*importing.RawImportRow{bankOriginal, bankRefund}
	wechat.Rows = []*importing.RawImportRow{wechatOriginal, wechatRefund}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{bank, wechat},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1783800000, sequentialPlannerIds(10800))
	if err != nil {
		t.Fatalf("build bank-backed partial refund plan: %v", err)
	}
	if plan.ValidEvidenceCount != 4 || plan.DuplicateEvidenceCount != 2 || plan.FinalEventCount != 2 ||
		plan.ReadyEventCount != 2 || plan.NeedsActionEventCount != 0 || len(plan.Relations) != 1 {
		t.Fatalf("bank-backed partial refund did not converge: %+v", plan)
	}
	refund := findEventByNature(plan.Events, organizer.ECONOMIC_NATURE_REFUND)
	if refund == nil || refund.Amount == nil || *refund.Amount != 20 || !strings.Contains(refund.ReasonCodesJson, "auto_same_event") ||
		plan.Relations[0].RelationType != organizer.RELATION_TYPE_REFUND_OF || plan.Relations[0].Status != organizer.RELATION_STATUS_CONFIRMED {
		t.Fatalf("partial refund relation or evidence role mismatch: event=%+v relation=%+v", refund, plan.Relations[0])
	}
}

func TestBuildOrganizePlanSplitsLegacyV1ContentFingerprintRows(t *testing.T) {
	const uid = int64(262)
	const updateId = int64(562)
	source := plannerSource(uid, updateId, 0, 655, 755, importing.SOURCE_TYPE_BANK)
	rows := make([]*importing.RawImportRow, 0, 4)
	for index := 0; index < 4; index++ {
		row := plannerRow(uid, 755, int64(21+index), 3601, 11, 4350, 1704067200,
			importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
		row.IdentityKeyVersion = importing.IDENTITY_KEY_VERSION_V1
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
		name          string
		refundAmounts []int64
		wantRelations int
	}{
		{name: "within original amount", refundAmounts: []int64{400, 500}, wantRelations: 2},
		{name: "exceeds original amount stays unlinked", refundAmounts: []int64{600, 500}},
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
			if plan.ReadyEventCount != 3 || plan.NeedsActionEventCount != 0 || len(plan.Relations) != test.wantRelations {
				t.Fatalf("unexpected refund plan: %+v", plan)
			}
			for _, relation := range plan.Relations {
				if relation.RelationType != organizer.RELATION_TYPE_REFUND_OF || relation.Status != organizer.RELATION_STATUS_CONFIRMED {
					t.Fatalf("refund relation mismatch: %+v", relation)
				}
			}
			if test.wantRelations == 0 {
				for _, event := range plan.Events {
					if event.EconomicNature == organizer.ECONOMIC_NATURE_REFUND && !strings.Contains(event.ReasonCodesJson, "refund_relation_unlinked") {
						t.Fatalf("excess refund did not remain explicitly unlinked: %+v", event)
					}
				}
			}
		})
	}
}

func TestBuildOrganizePlanAllowsExplicitRefundWithoutUniqueOriginal(t *testing.T) {
	const uid = int64(333)
	source := plannerSource(uid, 533, 0, 634, 734, importing.SOURCE_TYPE_ALIPAY)
	refund := plannerRow(uid, 734, 1, 4301, 11, 466, 1700200000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	refund.EconomicEffect = importing.ECONOMIC_EFFECT_REFUND
	refund.RawCounterparty = "退款商户"
	source.Rows = []*importing.RawImportRow{refund}
	plan, err := organizer.BuildOrganizePlan(uid, 533, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1700300000, sequentialPlannerIds(11400))
	if err != nil {
		t.Fatalf("build unlinked refund plan: %v", err)
	}
	if plan.FinalEventCount != 1 || plan.ReadyEventCount != 1 || plan.NeedsActionEventCount != 0 || len(plan.Relations) != 0 ||
		plan.Events[0].EconomicNature != organizer.ECONOMIC_NATURE_REFUND || !strings.Contains(plan.Events[0].ReasonCodesJson, "refund_relation_unlinked") {
		t.Fatalf("unlinked refund should remain postable and explicit: %+v", plan)
	}
}

func TestBuildOrganizePlanTreatsNormalizedIncomingPaymentAsIncome(t *testing.T) {
	const uid = int64(343)
	source := plannerSource(uid, 543, 0, 644, 744, importing.SOURCE_TYPE_ALIPAY)
	incoming := plannerRow(uid, 744, 1, 4401, 11, 1500, 1700200000, importing.NORMALIZED_DIRECTION_INCOME, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	incoming.EconomicEffect = importing.ECONOMIC_EFFECT_NORMAL
	source.Rows = []*importing.RawImportRow{incoming}
	plan, err := organizer.BuildOrganizePlan(uid, 543, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT)}, 1700300000, sequentialPlannerIds(11450))
	if err != nil {
		t.Fatalf("build incoming payment plan: %v", err)
	}
	if plan.ReadyEventCount != 1 || plan.NeedsActionEventCount != 0 || plan.Events[0].EconomicNature != organizer.ECONOMIC_NATURE_INCOME {
		t.Fatalf("normalized incoming payment was not accepted as income: %+v", plan)
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

func TestBuildOrganizePlanSeparatesInstallmentPrincipalFromInterest(t *testing.T) {
	const uid = int64(1504)
	const updateId = int64(5504)
	source := plannerSource(uid, updateId, 0, 6504, 7504, importing.SOURCE_TYPE_BANK)
	principal := plannerRow(uid, 7504, 15041, 25041, 11, 190275, 1785513600,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	// 兴业 XLS 把分期摘要放在交易对方列，而不是商品或备注列。
	principal.RawCounterparty = "电销现分按月收12期第7期共12期"
	interest := plannerRow(uid, 7504, 15042, 25042, 11, 9133, 1785513660,
		importing.NORMALIZED_DIRECTION_EXPENSE, importing.SOURCE_TRANSACTION_TYPE_PAYMENT)
	interest.RawCounterparty = "分期付款利息第7期共12期"
	source.Rows = []*importing.RawImportRow{principal, interest}

	plan, err := organizer.BuildOrganizePlan(uid, updateId, []*organizer.PlanningSource{source},
		map[int64]*models.Account{11: plannerAccount(uid, 11, models.ACCOUNT_CATEGORY_CREDIT_CARD)},
		1785514000, sequentialPlannerIds(150400))
	if err != nil {
		t.Fatalf("build installment plan: %v", err)
	}
	principalEvent := findEventByAmount(plan.Events, 190275)
	interestEvent := findEventByAmount(plan.Events, 9133)
	if principalEvent == nil || principalEvent.Status != organizer.EVENT_STATUS_NEEDS_ACTION ||
		principalEvent.EconomicNature != organizer.ECONOMIC_NATURE_UNKNOWN ||
		!strings.Contains(principalEvent.ReasonCodesJson, "installment_origin_required") {
		t.Fatalf("installment principal was treated as ordinary expense: %+v", principalEvent)
	}
	if interestEvent == nil || interestEvent.Status != organizer.EVENT_STATUS_READY ||
		interestEvent.EconomicNature != organizer.ECONOMIC_NATURE_FEE ||
		!strings.Contains(interestEvent.ReasonCodesJson, "installment_interest") {
		t.Fatalf("installment interest was not treated as a fee expense: %+v", interestEvent)
	}
	review, err := organizer.BuildReviewIssuePlan(uid, updateId, plan, []*organizer.PlanningSource{source}, 1785514000, sequentialPlannerIds(151000))
	if err != nil {
		t.Fatalf("build installment review issue: %v", err)
	}
	if len(review.Issues) != 1 || review.Issues[0].IssueType != organizer.REVIEW_ISSUE_TYPE_INSTALLMENT_ORIGIN ||
		review.Issues[0].PrimaryReasonCode != "installment_origin_required" {
		t.Fatalf("installment origin did not get a precise review issue: %+v", review.Issues)
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
