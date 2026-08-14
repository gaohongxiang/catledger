package dashboard

import (
	"testing"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/loans"
)

func TestDeriveLedgerOverviewSeparatesLoanCashFlowAndReversesAfterAsOf(t *testing.T) {
	location := time.UTC
	start, _ := parseCivilDate("2024-01-01", location)
	asOf, _ := parseCivilDate("2024-02-29", location)
	transaction := func(id int64, kind LedgerTransactionType, accountId int64, date string, amount int64) *LedgerTransaction {
		instant, _ := time.Parse(time.DateOnly, date)
		return &LedgerTransaction{TransactionId: id, Type: kind, AccountId: accountId, TransactionTime: instant.Add(12*time.Hour).Unix() * 1000, Amount: amount}
	}
	data := &LedgerData{
		Accounts: []*LedgerAccount{
			{AccountId: 1, Kind: LedgerAccountKindAsset, Currency: "CNY", CurrentBalance: 20000, Liquid: true, Single: true},
			{AccountId: 2, Kind: LedgerAccountKindDebt, Currency: "CNY", CurrentBalance: -5000, Single: true},
			{AccountId: 3, Kind: LedgerAccountKindAsset, Currency: "CNY", CurrentBalance: 5000, Liquid: true, Single: true},
		},
		Transactions: []*LedgerTransaction{
			transaction(1, LedgerTransactionIncome, 1, "2024-01-02", 10000),
			transaction(2, LedgerTransactionExpense, 1, "2024-01-03", 3000),
			transaction(3, LedgerTransactionExpense, 1, "2024-01-04", 500),
			transaction(4, LedgerTransactionExpense, 1, "2024-01-05", 200),
			transaction(5, LedgerTransactionTransferOut, 1, "2024-01-06", 1000),
			transaction(6, LedgerTransactionTransferIn, 2, "2024-01-06", 1000),
			transaction(7, LedgerTransactionTransferOut, 1, "2024-01-07", 400),
			transaction(8, LedgerTransactionTransferIn, 3, "2024-01-07", 400),
			transaction(9, LedgerTransactionTransferOut, 2, "2024-01-08", 5000),
			transaction(10, LedgerTransactionTransferIn, 1, "2024-01-08", 5000),
			transaction(99, LedgerTransactionIncome, 1, "2024-03-01", 2000),
		},
	}
	allocations := []*loans.DashboardAllocation{
		{TransactionId: 3, ContractId: 1, AllocationId: 1, ComponentType: loans.COMPONENT_TYPE_INTEREST, AllocatedAmount: 500},
		{TransactionId: 4, ContractId: 1, AllocationId: 2, ComponentType: loans.COMPONENT_TYPE_FEE, AllocatedAmount: 200},
		{TransactionId: 5, ContractId: 1, AllocationId: 3, ComponentType: loans.COMPONENT_TYPE_PRINCIPAL, AllocatedAmount: 1000},
		{TransactionId: 9, ContractId: 1, AllocationId: 4, ComponentType: loans.COMPONENT_TYPE_DISBURSEMENT, AllocatedAmount: 5000},
	}

	snapshot, months, periods, issues, err := deriveLedgerOverview(data, allocations, start, asOf, 2, 1, location)
	if err != nil {
		t.Fatalf("derive ledger overview: %v", err)
	}
	if issues != 0 || len(snapshot) != 1 {
		t.Fatalf("unexpected issues/snapshot: %d %#v", issues, snapshot)
	}
	if snapshot[0].Assets != 23000 || snapshot[0].Liabilities != 5000 || snapshot[0].NetWorth != 18000 || snapshot[0].LiquidFunds != 23000 {
		t.Fatalf("unexpected historical snapshot: %#v", snapshot[0])
	}
	if len(months) != 2 || months[0].Month != "2024-01" || months[1].Month != "2024-02" || len(months[0].Amounts) != 1 {
		t.Fatalf("unexpected month buckets: %#v", months)
	}
	flow := months[0].Amounts[0]
	if flow.Income != 10000 || flow.Consumption != 3000 || flow.LoanInterest != 500 || flow.LoanFee != 200 ||
		flow.LoanPrincipal != 1000 || flow.LoanDisbursement != 5000 || flow.InternalTransfer != 400 || flow.LiquidFundsNetChange != 10300 {
		t.Fatalf("unexpected classified cash flow: %#v", flow)
	}
	if len(months[1].Amounts) != 0 {
		t.Fatalf("empty month must remain explicit: %#v", months[1])
	}
	if len(periods) != 4 || periods[0].Kind != CashFlowPeriodToday || periods[1].Kind != CashFlowPeriodWeek ||
		periods[2].Kind != CashFlowPeriodMonth || periods[3].Kind != CashFlowPeriodYear || len(periods[3].Amounts) != 1 {
		t.Fatalf("unexpected stable cash-flow periods: %#v", periods)
	}
	if periods[3].Amounts[0].Income != flow.Income || periods[3].Amounts[0].LoanPrincipal != flow.LoanPrincipal {
		t.Fatalf("year period did not reuse monthly classification: %#v", periods[3])
	}
}

func TestDeriveLedgerOverviewBuildsTodayWeekMonthAndYearFromUserWeekStart(t *testing.T) {
	location := time.UTC
	start, _ := parseCivilDate("2024-01-01", location)
	asOf, _ := parseCivilDate("2024-08-14", location)
	transaction := func(id int64, date string, amount int64) *LedgerTransaction {
		instant, _ := time.Parse(time.DateOnly, date)
		return &LedgerTransaction{TransactionId: id, Type: LedgerTransactionIncome, AccountId: 1, TransactionTime: instant.Add(12*time.Hour).Unix() * 1000, Amount: amount}
	}
	data := &LedgerData{
		Accounts: []*LedgerAccount{{AccountId: 1, Kind: LedgerAccountKindAsset, Currency: "CNY", CurrentBalance: 200, Liquid: true, Single: true}},
		Transactions: []*LedgerTransaction{
			transaction(1, "2024-01-02", 100),
			transaction(2, "2024-08-01", 10),
			transaction(3, "2024-08-11", 20),
			transaction(4, "2024-08-12", 30),
			transaction(5, "2024-08-14", 40),
			transaction(6, "2024-08-15", 50),
		},
	}

	_, _, periods, _, err := deriveLedgerOverview(data, nil, start, asOf, 1, int(time.Monday), location)
	if err != nil {
		t.Fatalf("derive quick cash-flow periods: %v", err)
	}
	want := []struct {
		kind      CashFlowPeriodKind
		startDate string
		income    int64
	}{
		{CashFlowPeriodToday, "2024-08-14", 40},
		{CashFlowPeriodWeek, "2024-08-12", 70},
		{CashFlowPeriodMonth, "2024-08-01", 100},
		{CashFlowPeriodYear, "2024-01-01", 200},
	}
	if len(periods) != len(want) {
		t.Fatalf("unexpected period count: %#v", periods)
	}
	for index, expected := range want {
		period := periods[index]
		if period.Kind != expected.kind || period.StartDate != expected.startDate || period.EndDate != "2024-08-14" ||
			len(period.Amounts) != 1 || period.Amounts[0].Income != expected.income {
			t.Fatalf("unexpected period %d: %#v", index, period)
		}
	}
}

func TestDeriveLedgerOverviewFailsClosedOnAmountOverflow(t *testing.T) {
	start, _ := parseCivilDate("2024-01-01", time.UTC)
	asOf, _ := parseCivilDate("2024-01-31", time.UTC)
	_, _, _, _, err := deriveLedgerOverview(&LedgerData{Accounts: []*LedgerAccount{
		{AccountId: 1, Kind: LedgerAccountKindAsset, Currency: "CNY", CurrentBalance: int64(^uint64(0) >> 1), Single: true},
		{AccountId: 2, Kind: LedgerAccountKindAsset, Currency: "CNY", CurrentBalance: 1, Single: true},
	}}, nil, start, asOf, 1, 0, time.UTC)
	if err == nil {
		t.Fatal("overflowed account aggregation returned a partial dashboard")
	}
}

func TestAnalyzeCoverageIntervalsReportsGapsAndOverlap(t *testing.T) {
	intervals, gaps, overlaps, latest, err := analyzeCoverageIntervals([]*DateRange{
		{StartDate: "2024-01-01", EndDate: "2024-01-31"},
		{StartDate: "2024-01-20", EndDate: "2024-02-10"},
		{StartDate: "2024-02-12", EndDate: "2024-02-28"},
	}, "2024-01-01", "2024-02-29")
	if err != nil {
		t.Fatalf("analyze coverage: %v", err)
	}
	if len(intervals) != 3 || len(overlaps) != 1 || overlaps[0].StartDate != "2024-01-20" || overlaps[0].EndDate != "2024-01-31" {
		t.Fatalf("unexpected intervals/overlaps: %#v %#v", intervals, overlaps)
	}
	if len(gaps) != 2 || gaps[0].StartDate != "2024-02-11" || gaps[0].EndDate != "2024-02-11" ||
		gaps[1].StartDate != "2024-02-29" || gaps[1].EndDate != "2024-02-29" {
		t.Fatalf("unexpected gaps: %#v", gaps)
	}
	if latest == nil || *latest != "2024-02-28" {
		t.Fatalf("unexpected latest coverage: %#v", latest)
	}
}

func TestDeriveCoverageTreatsOverlappingStatementsAsIncomplete(t *testing.T) {
	ledgerAccountId := int64(9)
	reader := &dashboardCoverageReaderStub{
		accounts: []*importing.SourceAccount{{
			SourceAccountId: 1, Uid: 7, Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
			MaskedDisplayName: "masked", LedgerAccountId: &ledgerAccountId,
		}},
		batches: []*importing.ImportBatch{
			coverageBatch(11, 101, 1, "2024-01-01", "2024-01-31"),
			coverageBatch(12, 102, 1, "2024-01-20", "2024-02-29"),
		},
	}
	service := &Service{imports: reader}
	result, err := service.deriveCoverage(core.NewNullContext(), 7, "2024-01-01", "2024-02-29", time.UTC)
	if err != nil {
		t.Fatalf("derive coverage: %v", err)
	}
	if result.Complete || len(result.Accounts) != 1 || len(result.Accounts[0].Overlaps) != 1 || len(result.Accounts[0].Gaps) != 0 {
		t.Fatalf("overlap must remain visible and prevent complete trust: %#v", result)
	}
}

func coverageBatch(batchId int64, fileId int64, sourceAccountId int64, start string, end string) *importing.ImportBatch {
	startTime, _ := time.Parse(time.DateOnly, start)
	endTime, _ := time.Parse(time.DateOnly, end)
	created := int64(1000 + batchId)
	return &importing.ImportBatch{
		BatchId: batchId, Uid: 7, FileId: fileId, SourceAccountId: &sourceAccountId,
		Status: importing.IMPORT_BATCH_STATUS_COMPLETED, CreatedUnixTime: created, UpdatedUnixTime: created,
		StatementStartUnixTime: pointerInt64(startTime.Unix()), StatementEndUnixTime: pointerInt64(endTime.Add(23 * time.Hour).Unix()),
	}
}

func pointerInt64(value int64) *int64 { return &value }

func TestDeriveDebtUsesOnlyOutstandingPlanWithoutChangingLedgerLiability(t *testing.T) {
	effectiveApr := int64(135500000000)
	ledger := int64(2000)
	difference := int64(200)
	reader := &dashboardLoanReaderStub{detail: &loans.ContractDetail{
		Contract:        &loans.ContractResult{ContractId: 7, Name: "Plan", Currency: "CNY", Status: loans.CONTRACT_STATUS_ACTIVE},
		CurrentRevision: &loans.RevisionResult{EffectiveAprPptr: &effectiveApr},
		Installments: []*loans.InstallmentResult{
			{InstallmentId: 11, DueDate: "2024-01-15"},
			{InstallmentId: 12, DueDate: "2024-02-20"},
		},
		InstallmentProgress: []*loans.InstallmentProgress{
			{InstallmentId: 11, DueDate: "2024-01-15", OutstandingPayment: 1100, Components: loans.ComponentProgress{OutstandingPrincipal: 900}},
			{InstallmentId: 12, DueDate: "2024-02-20", OutstandingPayment: 1000, Components: loans.ComponentProgress{OutstandingPrincipal: 900}},
		},
		Remaining: loans.PlanRemaining{PrincipalAmount: 1800}, LedgerOutstandingAmount: &ledger, LedgerPlanDifferenceAmount: &difference,
	}}
	service := &Service{loans: reader}
	asOf, _ := parseCivilDate("2024-01-10", time.UTC)
	result, count, warnings, err := service.deriveDebt(core.NewNullContext(), 1, "2024-01-10", asOf)
	if err != nil {
		t.Fatalf("derive debt: %v", err)
	}
	if count != 1 || !warnings || len(result.Amounts) != 1 || len(result.Contracts) != 1 {
		t.Fatalf("unexpected debt summary: count=%d warnings=%v %#v", count, warnings, result)
	}
	amounts := result.Amounts[0]
	if amounts.PlannedRemainingPrincipal != 1800 || amounts.DueWithin7Days != 1100 || amounts.DueWithin30Days != 1100 || amounts.DueThisMonth != 1100 {
		t.Fatalf("unexpected debt due buckets: %#v", amounts)
	}
	contract := result.Contracts[0]
	if contract.LedgerOutstanding == nil || *contract.LedgerOutstanding != 2000 || contract.RemainingPrincipal != 1800 || contract.NextDueAmount != 1100 {
		t.Fatalf("plan and ledger must remain separate: %#v", contract)
	}
	if len(result.FutureCurve) != FutureDebtCurveMonths || len(result.FutureCurve[0].Amounts) != 1 || result.FutureCurve[0].Amounts[0].Payment != 1100 {
		t.Fatalf("unexpected future curve: %#v", result.FutureCurve)
	}
}

type dashboardLoanReaderStub struct {
	detail *loans.ContractDetail
}

func (s *dashboardLoanReaderStub) ListContracts(_ core.Context, _ int64, _ loans.ContractStatus, cursor *loans.ContractCursor, _ int, _ string) (*loans.ContractListResult, error) {
	if cursor != nil {
		return &loans.ContractListResult{Items: []*loans.ContractSummary{}}, nil
	}
	return &loans.ContractListResult{Items: []*loans.ContractSummary{{Contract: s.detail.Contract}}}, nil
}

func (s *dashboardLoanReaderStub) GetContract(_ core.Context, _ int64, _ int64, _ string) (*loans.ContractDetail, error) {
	return s.detail, nil
}

func (s *dashboardLoanReaderStub) ListDashboardAllocations(_ core.Context, _ int64) ([]*loans.DashboardAllocation, error) {
	return []*loans.DashboardAllocation{}, nil
}

type dashboardImportReaderStub struct{}

func (dashboardImportReaderStub) ListSourceAccounts(core.Context, int64) ([]*importing.SourceAccount, error) {
	return []*importing.SourceAccount{}, nil
}

func (dashboardImportReaderStub) ListImportBatches(core.Context, int64, int64, int, int) ([]*importing.ImportBatch, int64, error) {
	return []*importing.ImportBatch{}, 0, nil
}

type dashboardCoverageReaderStub struct {
	accounts []*importing.SourceAccount
	batches  []*importing.ImportBatch
}

func (s *dashboardCoverageReaderStub) ListSourceAccounts(core.Context, int64) ([]*importing.SourceAccount, error) {
	return s.accounts, nil
}

func (s *dashboardCoverageReaderStub) ListImportBatches(_ core.Context, _ int64, _ int64, offset int, _ int) ([]*importing.ImportBatch, int64, error) {
	if offset >= len(s.batches) {
		return []*importing.ImportBatch{}, int64(len(s.batches)), nil
	}
	return s.batches[offset:], int64(len(s.batches)), nil
}
