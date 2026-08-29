package loans

import (
	"fmt"
	"sort"

	"github.com/gaohongxiang/catledger/pkg/core"
)

// GetSettlementCandidates 只读扫描当前用户的正式交易，不自动建立任何分配。
func (s *Service) GetSettlementCandidates(c core.Context, request SettlementCandidateRequest) (*SettlementCandidateResult, error) {
	if s == nil || s.repository == nil || s.settlementLedger == nil || request.Uid < 1 || request.ContractId < 1 ||
		!isComponentType(request.ComponentType) || !isNilOrPositive(request.InstallmentId) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	selection, err := s.loadSettlementPlan(c, nil, request.Uid, request.ContractId, request.InstallmentId, request.ComponentType)
	if err != nil {
		return nil, err
	}
	if selection.contract.Status != CONTRACT_STATUS_ACTIVE {
		return nil, serviceError(ErrServiceStateConflict, SERVICE_ERROR_STATE_CONFLICT)
	}
	if selection.validation.invalidCount > 0 {
		return nil, serviceError(ErrServiceLedgerEventRejected, selection.validation.reasonCodes[0])
	}
	group := SettlementCandidateGroup{ComponentType: request.ComponentType, ExpectedAmount: selection.planned,
		OutstandingAmount: selection.outstanding, Candidates: []SettlementCandidate{}}
	result := &SettlementCandidateResult{ContractId: request.ContractId, InstallmentId: cloneInt64(request.InstallmentId),
		Groups: []SettlementCandidateGroup{group}}
	if selection.outstanding == 0 {
		return result, nil
	}

	filter := LedgerCandidateFilter{MinimumAmount: 1, MaximumAmount: selection.outstanding, Limit: maximumSettlementCandidateResults}
	switch request.ComponentType {
	case COMPONENT_TYPE_DISBURSEMENT:
		filter.Kind = LEDGER_EVENT_KIND_TRANSFER
		filter.SourceAccountId = selection.contract.LiabilityAccountId
	case COMPONENT_TYPE_PRINCIPAL:
		if selection.contract.DefaultPaymentAccountId == nil {
			return result, nil
		}
		filter.Kind = LEDGER_EVENT_KIND_TRANSFER
		filter.SourceAccountId = *selection.contract.DefaultPaymentAccountId
		filter.DestinationAccountId = selection.contract.LiabilityAccountId
	case COMPONENT_TYPE_INTEREST, COMPONENT_TYPE_FEE:
		if selection.contract.DefaultPaymentAccountId == nil {
			return result, nil
		}
		filter.Kind = LEDGER_EVENT_KIND_EXPENSE
		filter.SourceAccountId = *selection.contract.DefaultPaymentAccountId
	}
	referenceDate, err := settlementReferenceDate(selection, request.ComponentType)
	if err != nil {
		return nil, err
	}
	filter.MinimumUnixTime = referenceDate.AddDate(0, 0, -settlementCandidateWindowDays).Unix()
	filter.MaximumUnixTime = referenceDate.AddDate(0, 0, settlementCandidateWindowDays).Unix()
	page, err := s.settlementLedger.ListSettlementCandidates(c, request.Uid, filter)
	if err != nil || page == nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}

	transactionIds := make([]int64, 0, len(page.Items)*2)
	seen := make(map[int64]struct{}, len(page.Items)*2)
	for _, event := range page.Items {
		if event == nil || event.PrimaryTransactionId < 1 {
			continue
		}
		for _, id := range []int64{event.PrimaryTransactionId, valueOrZero(event.CounterpartTransactionId)} {
			if id > 0 {
				if _, exists := seen[id]; !exists {
					seen[id] = struct{}{}
					transactionIds = append(transactionIds, id)
				}
			}
		}
	}
	sort.Slice(transactionIds, func(i, j int) bool { return transactionIds[i] < transactionIds[j] })
	bindings, err := s.repository.FindTransactionBindingsByTransactionIds(c, request.Uid, transactionIds)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}

	candidates := make([]SettlementCandidate, 0, len(page.Items))
	assetAccountId := int64(0)
	if request.ComponentType != COMPONENT_TYPE_DISBURSEMENT && selection.contract.DefaultPaymentAccountId != nil {
		assetAccountId = *selection.contract.DefaultPaymentAccountId
	}
	for _, event := range page.Items {
		if event == nil {
			continue
		}
		reasons := make(map[ServiceErrorCode]struct{})
		if reason := validateLedgerEventSemantics(selection.contract, request.ComponentType, event.Amount, assetAccountId, 0, event); reason != "" {
			reasons[reason] = struct{}{}
		}
		for _, transactionId := range []int64{event.PrimaryTransactionId, valueOrZero(event.CounterpartTransactionId)} {
			if binding := bindings[transactionId]; binding != nil && binding.CurrentAllocationId != nil {
				reasons[SERVICE_ERROR_BINDING_CONFLICT] = struct{}{}
			}
		}
		candidate := SettlementCandidate{TransactionId: event.PrimaryTransactionId, Kind: event.Kind,
			TransactionUnixTime: event.TransactionUnixTime, Amount: event.Amount, Currency: event.SourceAccount.Currency,
			MaskedSourceAccount: maskedSettlementAccount(event.SourceAccount), UpdatedUnixTime: event.UpdatedUnixTime,
			CounterpartUpdatedUnixTime: cloneInt64(event.CounterpartUpdatedUnixTime), ReasonCodes: sortedServiceErrorCodes(reasons)}
		if event.DestinationAccount != nil {
			candidate.MaskedDestinationAccount = maskedSettlementAccount(*event.DestinationAccount)
		}
		candidate.Eligible = len(candidate.ReasonCodes) == 0
		candidates = append(candidates, candidate)
	}
	result.Groups[0].Candidates = candidates
	result.Groups[0].LimitReached = page.LimitReached
	return result, nil
}

func maskedSettlementAccount(account AccountSnapshot) string {
	if account.AccountId < 1 || account.Kind == "" {
		return ""
	}
	return fmt.Sprintf("%s-**%04d", account.Kind, account.AccountId%10000)
}
