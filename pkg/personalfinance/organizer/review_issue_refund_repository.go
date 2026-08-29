package organizer

import (
	"fmt"

	"github.com/gaohongxiang/catledger/pkg/models"
)

func (tx *RepositoryTransaction) FindLedgerAccount(accountId int64) (*models.Account, error) {
	if err := tx.validate(); err != nil || accountId < 1 {
		return nil, fmt.Errorf("invalid ledger account lookup")
	}
	value := new(models.Account)
	found, err := tx.session.Where("uid=? AND account_id=? AND deleted=?", tx.uid, accountId, false).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find ledger account: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (tx *RepositoryTransaction) FindEventByTransactionId(transactionId int64) (*EconomicEvent, *EconomicEventTransaction, error) {
	link, err := tx.FindEventLinkByTransactionId(transactionId)
	if err != nil || link == nil {
		return nil, link, err
	}
	event, err := tx.FindEventById(link.EventId)
	if err != nil {
		return nil, nil, err
	}
	return event, link, nil
}

func (tx *RepositoryTransaction) SumConfirmedRefundAmountForEvent(targetEventId int64, exceptSourceEventId int64) (int64, error) {
	if err := tx.validate(); err != nil || targetEventId < 1 || exceptSourceEventId < 0 {
		return 0, fmt.Errorf("invalid event refund sum")
	}
	items, err := tx.ListRefundRelationsForTarget(targetEventId)
	if err != nil {
		return 0, err
	}
	total := int64(0)
	for _, relation := range items {
		if relation.Status != RELATION_STATUS_CONFIRMED || relation.SourceEventId == exceptSourceEventId {
			continue
		}
		if relation.Amount == nil || *relation.Amount <= 0 || total > int64(^uint64(0)>>1)-*relation.Amount {
			return 0, fmt.Errorf("invalid confirmed refund amount")
		}
		total += *relation.Amount
	}
	return total, nil
}

func (tx *RepositoryTransaction) InsertHistoricalTransactionLink(value *EconomicEventTransaction) error {
	return tx.InsertEventTransaction(value)
}
