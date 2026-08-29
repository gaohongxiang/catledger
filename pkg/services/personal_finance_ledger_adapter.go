package services

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/models"
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

	// organizer 将经济性质和生活分类分开；未分类不阻塞收支、退款或双账户事件。
	allowUncategorized := transaction.CategoryId == 0
	if err = s.doCreateTransactionWithOptions(c, database, sess, &transaction, indexes, uniqueTagIds, nil, nil, allowUncategorized); err != nil {
		return nil, nil, err
	}

	var counterpart *models.Transaction

	if transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		counterpart = s.GetRelatedTransferTransaction(&transaction)
	}

	return &transaction, counterpart, nil
}

// DeleteTransactionInSession 在调用方持有的事务中按不可变快照条件软删一个完整逻辑账本事件。
// 本方法不提交或回滚 sess；普通事件的 related 参数必须均为零，转账必须显式提供完整对端。
func (s *TransactionService) DeleteTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error) {
	if s == nil || uid < 1 || transactionId < 1 || expectedUpdatedUnixTime < 1 || deletedUnixTime < 1 || database == nil ||
		database != s.UserDataDB(uid) || database.ValidateTransactionSession(sess) != nil {
		return nil, nil, fmt.Errorf("invalid caller-owned ledger transaction deletion")
	}

	return s.deleteTransactionInSession(c, sess, uid, transactionId, expectedUpdatedUnixTime, relatedTransactionId, expectedRelatedUpdatedUnixTime, deletedUnixTime, true)
}
