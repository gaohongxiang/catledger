package services

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
)

// CreateTransactionInSession 在调用方持有的事务中写入一个逻辑账本事件。
// 本方法不提交或回滚 sess，也不依赖个人财务模型。
func (s *TransactionService) CreateTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft *models.Transaction, tagIds []int64) (*models.Transaction, *models.Transaction, error) {
	if s == nil || draft == nil || draft.Uid < 1 || database == nil ||
		database != s.UserDataDB(draft.Uid) || database.ValidateTransactionSession(sess) != nil {
		return nil, nil, fmt.Errorf("invalid caller-owned ledger transaction session")
	}

	if draft.TransactionId != 0 || draft.RelatedId != 0 || draft.Deleted ||
		draft.CreatedUnixTime != 0 || draft.UpdatedUnixTime != 0 || draft.DeletedUnixTime != 0 ||
		draft.ScheduledCreated || draft.GeoLongitude != 0 || draft.GeoLatitude != 0 {
		return nil, nil, fmt.Errorf("ledger transaction draft contains internal state")
	}

	transaction := *draft
	indexes, uniqueTagIds, _, err := s.prepareTransactionForCreate(&transaction, tagIds)

	if err != nil {
		return nil, nil, err
	}

	if err = s.doCreateTransaction(c, database, sess, &transaction, indexes, uniqueTagIds, nil, nil); err != nil {
		return nil, nil, err
	}

	var counterpart *models.Transaction

	if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		counterpart = s.GetRelatedTransferTransaction(&transaction)
	}

	return &transaction, counterpart, nil
}
