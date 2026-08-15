package billflow

import (
	"fmt"
	"sort"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type loanBindingRow struct{}

func (loanBindingRow) TableName() string { return "pf_loan_transaction_binding" }

// LedgerDeleter 在调用方隐私事务中按快照软删正式交易。
type LedgerDeleter interface {
	DeleteTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error)
}

// StoreUndoGateway 只撤销本任务批次上 auto_posted 交易和本任务新建的复用证据关系。
type StoreUndoGateway struct {
	store   *datastore.DataStore
	deleter LedgerDeleter
	now     func() int64
}

func NewStoreUndoGateway(store *datastore.DataStore, deleter LedgerDeleter) (*StoreUndoGateway, error) {
	if store == nil || store.Count() < 1 || deleter == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return &StoreUndoGateway{store: store, deleter: deleter, now: func() int64 { return time.Now().Unix() }}, nil
}

func (g *StoreUndoGateway) Inspect(c core.Context, uid int64, batchIds []int64) (*UndoInspection, error) {
	if g == nil || g.store == nil || uid < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	inspection := &UndoInspection{CanReverse: true, ReasonCodes: []string{}}
	if len(batchIds) == 0 {
		return inspection, nil
	}
	database := g.store.Choose(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	if err := g.inspectSession(sess, uid, batchIds, inspection); err != nil {
		return nil, err
	}
	return inspection, nil
}

func (g *StoreUndoGateway) Reverse(c core.Context, uid int64, inspection *UndoInspection) error {
	if g == nil || g.store == nil || g.deleter == nil || uid < 1 || inspection == nil {
		return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if !inspection.CanReverse {
		return serviceError(ErrServiceActionRequired, SERVICE_ERROR_ACTION_REQUIRED)
	}
	database := g.store.Choose(uid)
	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		now := g.now()
		if now < 1 {
			now = time.Now().Unix()
		}
		for _, transactionId := range inspection.TransactionIds {
			snapshot := inspection.snapshots[transactionId]
			if snapshot < 1 {
				return serviceError(ErrServiceActionRequired, SERVICE_ERROR_ACTION_REQUIRED)
			}
			if _, _, err := g.deleter.DeleteTransactionInSession(c, database, sess, uid, transactionId, snapshot, 0, 0, now); err != nil {
				return serviceError(ErrServiceActionRequired, SERVICE_ERROR_ACTION_REQUIRED)
			}
		}
		ids := append(append([]int64{}, inspection.TransactionIds...), inspection.ReusedTransactionIds...)
		if len(ids) == 0 {
			return nil
		}
		if _, err := sess.Where("uid=?", uid).In("transaction_id", ids).In("creation_method", []string{
			string(importing.RAW_ROW_TRANSACTION_CREATION_AUTO_POSTED),
			string(importing.RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED),
		}).Delete(new(importing.RawRowTransactionLink)); err != nil {
			return err
		}
		if len(inspection.rowIds) > 0 {
			row := &importing.RawImportRow{ProcessingState: importing.PROCESSING_STATE_PENDING, Disposition: importing.IMPORT_DISPOSITION_POSTABLE}
			if _, err := sess.Where("uid=?", uid).In("row_id", inspection.rowIds).
				Cols("processing_state", "disposition").Update(row); err != nil {
				return err
			}
		}
		return nil
	})
}

func (g *StoreUndoGateway) inspectSession(sess *xorm.Session, uid int64, batchIds []int64, inspection *UndoInspection) error {
	type linkedRow struct {
		RowId                      int64
		TransactionId              int64
		CreationMethod             importing.RawRowTransactionCreationMethod
		TransactionUpdatedUnixTime int64
	}
	rows := make([]linkedRow, 0)
	if err := sess.Table("pf_raw_row_transaction_link").Alias("l").
		Join("INNER", "pf_raw_import_row", "pf_raw_import_row.uid=l.uid AND pf_raw_import_row.row_id=l.row_id").
		Where("l.uid=?", uid).In("pf_raw_import_row.batch_id", batchIds).
		Cols("l.row_id", "l.transaction_id", "l.creation_method", "l.transaction_updated_unix_time").
		Find(&rows); err != nil {
		return err
	}
	reasons := map[string]struct{}{}
	inspection.snapshots = map[int64]int64{}
	autoPosted := map[int64]int64{}
	reused := map[int64]struct{}{}
	rowIds := map[int64]struct{}{}
	for _, row := range rows {
		if row.RowId < 1 || row.TransactionId < 1 {
			continue
		}
		rowIds[row.RowId] = struct{}{}
		if row.CreationMethod == importing.RAW_ROW_TRANSACTION_CREATION_AUTO_POSTED {
			autoPosted[row.TransactionId] = row.TransactionUpdatedUnixTime
			inspection.snapshots[row.TransactionId] = row.TransactionUpdatedUnixTime
		} else if row.CreationMethod == importing.RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED {
			reused[row.TransactionId] = struct{}{}
		}
	}
	for transactionId, snapshot := range autoPosted {
		transaction := new(models.Transaction)
		found, err := sess.Where("uid=? AND transaction_id=?", uid, transactionId).Get(transaction)
		if err != nil {
			return err
		}
		if !found || transaction.Deleted {
			reasons["transaction_missing_or_deleted"] = struct{}{}
			continue
		}
		if transaction.UpdatedUnixTime != snapshot {
			reasons["transaction_modified"] = struct{}{}
		}
		shared, err := sess.Table("pf_raw_row_transaction_link").Alias("l").
			Join("INNER", "pf_raw_import_row", "pf_raw_import_row.uid=l.uid AND pf_raw_import_row.row_id=l.row_id").
			Where("l.uid=? AND l.transaction_id=?", uid, transactionId).
			NotIn("pf_raw_import_row.batch_id", batchIds).Count(new(importing.RawRowTransactionLink))
		if err != nil {
			return err
		}
		if shared > 0 {
			reasons["transaction_shared"] = struct{}{}
		}
		loanCount, err := sess.Where("uid=? AND current_allocation_id IS NOT NULL AND transaction_id=?", uid, transactionId).Count(new(loanBindingRow))
		if err != nil {
			return fmt.Errorf("count billflow loan relations: %w", err)
		}
		if loanCount > 0 {
			reasons["loan_relation_present"] = struct{}{}
		}
	}
	inspection.AutoPostedCount = int64(len(autoPosted))
	inspection.ReusedLinkCount = int64(len(reused))
	inspection.TransactionIds = sortedIDs(autoPosted)
	inspection.ReusedTransactionIds = sortedSet(reused)
	inspection.rowIds = sortedSet(rowIds)
	inspection.ReasonCodes = sortedReasons(reasons)
	inspection.CanReverse = len(reasons) == 0
	return nil
}

func sortedIDs(values map[int64]int64) []int64 {
	ids := make([]int64, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func sortedSet(values map[int64]struct{}) []int64 {
	ids := make([]int64, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func sortedReasons(values map[string]struct{}) []string {
	codes := make([]string, 0, len(values))
	for code := range values {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return codes
}
