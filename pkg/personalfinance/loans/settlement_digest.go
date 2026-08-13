package loans

import (
	"encoding/hex"
	"hash"
	"sort"
)

func applySettlementRequestDigest(request ApplySettlementRequest) string {
	hasher := newActionDigest(ACTION_TYPE_APPLY_SETTLEMENT)
	writeServiceDigestInt64(hasher, request.ContractId)
	writeServiceDigestInt64(hasher, request.ExpectedContractVersion)
	writeServiceDigestOptionalInt64(hasher, request.InstallmentId)
	writeServiceDigestInt64(hasher, int64(len(request.Components)))
	for _, component := range request.Components {
		writeSettlementComponentDigest(hasher, component)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func reverseSettlementRequestDigest(request ReverseSettlementRequest) string {
	hasher := newActionDigest(ACTION_TYPE_REVERSE_SETTLEMENT)
	writeServiceDigestInt64(hasher, request.ContractId)
	writeServiceDigestInt64(hasher, request.ApplyActionId)
	writeServiceDigestInt64(hasher, request.ExpectedContractVersion)
	return hex.EncodeToString(hasher.Sum(nil))
}

func writeSettlementComponentDigest(hasher hash.Hash, component SettlementComponentCommand) {
	writeServiceDigestString(hasher, string(component.ComponentType))
	writeServiceDigestInt64(hasher, component.AllocatedAmount)
	if component.Existing != nil {
		writeServiceDigestInt64(hasher, 1)
		writeServiceDigestInt64(hasher, component.Existing.ExistingTransactionId)
		writeServiceDigestInt64(hasher, component.Existing.ExpectedUpdatedUnixTime)
		writeServiceDigestOptionalInt64(hasher, component.Existing.ExpectedCounterpartUpdatedUnixTime)
		return
	}
	writeServiceDigestInt64(hasher, 2)
	if component.Draft == nil {
		return
	}
	writeServiceDigestString(hasher, string(component.Draft.Kind))
	writeServiceDigestInt64(hasher, component.Draft.TransactionUnixTime)
	writeServiceDigestInt64(hasher, int64(component.Draft.TimezoneUtcOffset))
	writeServiceDigestInt64(hasher, component.Draft.SourceAccountId)
	writeServiceDigestInt64(hasher, component.Draft.DestinationAccountId)
	writeServiceDigestInt64(hasher, component.Draft.CategoryId)
	writeServiceDigestInt64(hasher, component.Draft.Amount)
	writeServiceDigestString(hasher, component.Draft.Currency)
}

func canonicalSettlementComponents(values []SettlementComponentCommand) []SettlementComponentCommand {
	result := append([]SettlementComponentCommand(nil), values...)
	for index := range result {
		if result[index].Existing != nil {
			copyValue := *result[index].Existing
			copyValue.ExpectedCounterpartUpdatedUnixTime = cloneInt64(copyValue.ExpectedCounterpartUpdatedUnixTime)
			result[index].Existing = &copyValue
		}
		if result[index].Draft != nil {
			copyValue := *result[index].Draft
			result[index].Draft = &copyValue
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ComponentType < result[j].ComponentType })
	return result
}
