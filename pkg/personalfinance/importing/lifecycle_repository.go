package importing

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

// MarkImportFileContentDeleted 在对象删除成功后条件收口数据库状态和删除时间。
func (r *Repository) MarkImportFileContentDeleted(c core.Context, uid int64, fileId int64, now int64) (bool, error) {
	if uid < 1 || fileId < 1 || now < 1 {
		return false, fmt.Errorf("invalid import file deletion")
	}
	db, _ := r.database(uid)
	deletedTime := now
	update := &ImportFile{
		ContentState:           IMPORT_FILE_CONTENT_STATE_DELETED,
		UpdatedUnixTime:        now,
		ContentDeletedUnixTime: &deletedTime,
	}
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	updated, err := sess.Where("uid=? AND file_id=?", uid, fileId).
		In("content_state", []string{
			string(IMPORT_FILE_CONTENT_STATE_AVAILABLE),
			string(IMPORT_FILE_CONTENT_STATE_MISSING),
			string(IMPORT_FILE_CONTENT_STATE_FAILED),
		}).Cols("content_state", "updated_unix_time", "content_deleted_unix_time").Update(update)
	if err != nil {
		return false, fmt.Errorf("mark import file content deleted: %w", err)
	}
	return updated == 1, nil
}

// DiscardImportBatch 在隐私事务内核对全部账本影响后条件推进状态。
func (r *Repository) DiscardImportBatch(c core.Context, uid int64, batchId int64, now int64) (*ImportBatch, error) {
	if uid < 1 || batchId < 1 || now < 1 {
		return nil, ErrImportRequestInvalid
	}
	var result *ImportBatch
	err := r.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		batch := new(ImportBatch)
		query := tx.session.Where("uid=? AND batch_id=?", uid, batchId)
		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			query = query.ForUpdate()
		}
		found, err := query.Get(batch)
		if err != nil {
			return err
		}
		if !found {
			return ErrImportBatchNotFound
		}
		if batch.Status == IMPORT_BATCH_STATUS_DISCARDED {
			result = batch
			return nil
		}
		if batch.Status != IMPORT_BATCH_STATUS_AWAITING_SOURCE_ACCOUNT && batch.Status != IMPORT_BATCH_STATUS_READY {
			return ErrImportBatchNotDiscardable
		}
		postingCount, err := tx.session.Where("uid=? AND batch_id=?", uid, batchId).Count(new(ImportPosting))
		if err != nil {
			return err
		}
		linkedRowCount, err := tx.session.Where("uid=? AND batch_id=? AND processing_state=?", uid, batchId, PROCESSING_STATE_LINKED).Count(new(RawImportRow))
		if err != nil {
			return err
		}
		linkCount, err := tx.countBatchEvidenceLinks(uid, batchId)
		if err != nil {
			return err
		}
		if postingCount != 0 || linkedRowCount != 0 || linkCount != 0 || batch.PostedRowCount != 0 {
			return ErrImportBatchNotDiscardable
		}
		update := &ImportBatch{Status: IMPORT_BATCH_STATUS_DISCARDED, UpdatedUnixTime: now}
		updated, err := tx.session.Where("uid=? AND batch_id=? AND posted_row_count=0", uid, batchId).
			In("status", []string{string(IMPORT_BATCH_STATUS_AWAITING_SOURCE_ACCOUNT), string(IMPORT_BATCH_STATUS_READY)}).
			Cols("status", "updated_unix_time").Update(update)
		if err != nil {
			return err
		}
		if updated != 1 {
			return ErrImportBatchNotDiscardable
		}
		batch.Status = IMPORT_BATCH_STATUS_DISCARDED
		batch.UpdatedUnixTime = now
		result = batch
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (tx *RepositoryTransaction) countBatchEvidenceLinks(uid int64, batchId int64) (int64, error) {
	rows := make([]*RawImportRow, 0)
	if err := tx.session.Cols("row_id").Where("uid=? AND batch_id=?", uid, batchId).Find(&rows); err != nil {
		return 0, err
	}
	var count int64
	for start := 0; start < len(rows); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rows))
		ids := make([]int64, 0, end-start)
		for _, row := range rows[start:end] {
			ids = append(ids, row.RowId)
		}
		chunkCount, err := tx.session.Where("uid=?", uid).In("row_id", ids).Count(new(RawRowTransactionLink))
		if err != nil {
			return 0, err
		}
		count += chunkCount
	}
	return count, nil
}

// GetUndoImpact 聚合批次已有证据关系、posting 结果和正式交易状态。
func (r *Repository) GetUndoImpact(c core.Context, uid int64, batchId int64) (*UndoImpact, error) {
	if uid < 1 || batchId < 1 {
		return nil, ErrImportRequestInvalid
	}
	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	batch := new(ImportBatch)
	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(batch)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrImportBatchNotFound
	}
	rows := make([]*RawImportRow, 0)
	if err = sess.Cols("row_id").Where("uid=? AND batch_id=?", uid, batchId).Find(&rows); err != nil {
		return nil, err
	}
	rowIds := make([]int64, 0, len(rows))
	for _, row := range rows {
		rowIds = append(rowIds, row.RowId)
	}
	links, err := listLinksByRowIdsXorm(sess, uid, rowIds)
	if err != nil {
		return nil, err
	}
	postings := make([]*ImportPosting, 0)
	if err = sess.Where("uid=? AND batch_id=?", uid, batchId).Find(&postings); err != nil {
		return nil, err
	}
	impact := &UndoImpact{BatchId: batchId}
	for _, posting := range postings {
		impact.PostingCreatedCount += posting.CreatedTransactionCount
		impact.PostingReusedCount += posting.ReusedTransactionCount
	}
	transactionSnapshots := make(map[int64][]int64)
	for _, link := range links {
		transactionSnapshots[link.TransactionId] = append(transactionSnapshots[link.TransactionId], link.TransactionUpdatedUnixTime)
	}
	impact.LinkedTransactionCount = int64(len(transactionSnapshots))
	transactions, err := loadTransactionsByIds(sess, uid, mapKeys(transactionSnapshots))
	if err != nil {
		return nil, err
	}
	reasonSet := map[UndoImpactReason]struct{}{UNDO_IMPACT_REASON_AUTOMATIC_UNDO_NOT_SUPPORTED: {}}
	for transactionId, snapshots := range transactionSnapshots {
		transaction := transactions[transactionId]
		if transaction == nil || transaction.Deleted {
			impact.MissingTransactionCount++
			reasonSet[UNDO_IMPACT_REASON_TRANSACTION_MISSING] = struct{}{}
			continue
		}
		for _, snapshot := range snapshots {
			if transaction.UpdatedUnixTime != snapshot {
				impact.ModifiedTransactionCount++
				reasonSet[UNDO_IMPACT_REASON_TRANSACTION_MODIFIED] = struct{}{}
				break
			}
		}
	}
	if impact.PostingReusedCount > 0 {
		reasonSet[UNDO_IMPACT_REASON_REUSED_TRANSACTION] = struct{}{}
	}
	shared, err := countSharedTransactions(sess, uid, batchId, mapKeys(transactionSnapshots))
	if err != nil {
		return nil, err
	}
	impact.SharedTransactionCount = shared
	if shared > 0 {
		reasonSet[UNDO_IMPACT_REASON_TRANSACTION_SHARED] = struct{}{}
	}
	impact.ReasonCodes = sortedUndoReasons(reasonSet)
	return impact, nil
}

// GetImportDataStatistics 读取 PF 数据管理计数。
func (r *Repository) GetImportDataStatistics(c core.Context, uid int64) (*ImportDataStatistics, error) {
	if uid < 1 {
		return nil, ErrImportRequestInvalid
	}
	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	files, err := sess.Where("uid=?", uid).Count(new(ImportFile))
	if err != nil {
		return nil, err
	}
	batches, err := sess.Where("uid=?", uid).Count(new(ImportBatch))
	if err != nil {
		return nil, err
	}
	rows, err := sess.Where("uid=?", uid).Count(new(RawImportRow))
	if err != nil {
		return nil, err
	}
	return &ImportDataStatistics{ImportFileCount: files, ImportBatchCount: batches, RawImportRowCount: rows}, nil
}

// ListAllImportFiles 返回当前用户全部已登记最终对象记录。
func (r *Repository) ListAllImportFiles(c core.Context, uid int64) ([]*ImportFile, error) {
	if uid < 1 {
		return nil, ErrImportRequestInvalid
	}
	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	files := make([]*ImportFile, 0)
	if err := sess.Where("uid=?", uid).Asc("file_id").Find(&files); err != nil {
		return nil, err
	}
	return files, nil
}

// ClearPersonalFinanceUserData 在一个隐私事务中按依赖逆序删除全部 PF 用户数据。
func (r *Repository) ClearPersonalFinanceUserData(c core.Context, uid int64) error {
	if uid < 1 {
		return ErrImportRequestInvalid
	}
	return r.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		beans := []any{
			new(RawRowTransactionLink), new(ImportPosting), new(ImportBatchIssue),
			new(RawImportRow), new(SourceIdentity), new(ImportBatch),
			new(PaymentAccountMapping),
			new(SourceAccount), new(ImportFile),
		}
		for _, bean := range beans {
			if _, err := tx.session.Where("uid=?", uid).Delete(bean); err != nil {
				return err
			}
		}
		return nil
	})
}

// CheckUserConsistency 核对全部用户级 PF 关系和批次派生计数。
func (r *Repository) CheckUserConsistency(c core.Context, uid int64) (*UserConsistencyReport, []*ImportFile, error) {
	if uid < 1 {
		return nil, nil, ErrImportRequestInvalid
	}
	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	files := make([]*ImportFile, 0)
	accounts := make([]*SourceAccount, 0)
	batches := make([]*ImportBatch, 0)
	identities := make([]*SourceIdentity, 0)
	rows := make([]*RawImportRow, 0)
	postings := make([]*ImportPosting, 0)
	issues := make([]*ImportBatchIssue, 0)
	links := make([]*RawRowTransactionLink, 0)
	for _, target := range []any{&files, &accounts, &batches, &identities, &rows, &postings, &issues, &links} {
		if err := sess.Where("uid=?", uid).Find(target); err != nil {
			return nil, nil, err
		}
	}
	report := &UserConsistencyReport{ImportFileCount: int64(len(files)), ImportBatchCount: int64(len(batches)), RawImportRowCount: int64(len(rows))}
	fileSet := make(map[int64]struct{}, len(files))
	accountSet := make(map[int64]struct{}, len(accounts))
	batchSet := make(map[int64]struct{}, len(batches))
	identitySet := make(map[int64]struct{}, len(identities))
	rowSet := make(map[int64]struct{}, len(rows))
	postingSet := make(map[int64]struct{}, len(postings))
	postingBatch := make(map[int64]int64, len(postings))
	rowBatch := make(map[int64]int64, len(rows))
	for _, file := range files {
		fileSet[file.FileId] = struct{}{}
	}
	for _, account := range accounts {
		accountSet[account.SourceAccountId] = struct{}{}
	}
	for _, batch := range batches {
		batchSet[batch.BatchId] = struct{}{}
	}
	for _, identity := range identities {
		identitySet[identity.IdentityId] = struct{}{}
		if _, ok := accountSet[identity.SourceAccountId]; !ok {
			report.OrphanSourceIdentityCount++
		}
	}
	for _, posting := range postings {
		postingSet[posting.PostingId] = struct{}{}
		postingBatch[posting.PostingId] = posting.BatchId
		if _, ok := batchSet[posting.BatchId]; !ok {
			report.OrphanPostingCount++
		}
	}
	for _, issue := range issues {
		if _, ok := batchSet[issue.BatchId]; !ok {
			report.OrphanBatchIssueCount++
		}
	}
	rowsByBatch := make(map[int64][]*RawImportRow)
	for _, row := range rows {
		rowSet[row.RowId] = struct{}{}
		rowBatch[row.RowId] = row.BatchId
		orphan := false
		if _, ok := batchSet[row.BatchId]; !ok {
			orphan = true
		}
		if row.IdentityId != nil {
			if _, ok := identitySet[*row.IdentityId]; !ok {
				orphan = true
			}
		}
		if orphan {
			report.OrphanRawRowCount++
		}
		rowsByBatch[row.BatchId] = append(rowsByBatch[row.BatchId], row)
	}
	for _, batch := range batches {
		orphan := false
		if _, ok := fileSet[batch.FileId]; !ok {
			orphan = true
		}
		if batch.SourceAccountId != nil {
			if _, ok := accountSet[*batch.SourceAccountId]; !ok {
				orphan = true
			}
		}
		if orphan {
			report.OrphanBatchCount++
		}
		if !batchCountsMatch(batch, rowsByBatch[batch.BatchId]) {
			report.BatchCountMismatchCount++
		}
	}
	transactionIds := make([]int64, 0, len(links))
	for _, link := range links {
		orphan := false
		if _, ok := rowSet[link.RowId]; !ok {
			orphan = true
		}
		if _, ok := postingSet[link.PostingId]; !ok {
			orphan = true
		}
		if rowBatch[link.RowId] != postingBatch[link.PostingId] {
			orphan = true
		}
		if orphan {
			report.OrphanEvidenceLinkCount++
		}
		transactionIds = append(transactionIds, link.TransactionId)
	}
	transactions, err := loadTransactionsByIds(sess, uid, transactionIds)
	if err != nil {
		return nil, nil, err
	}
	missing := make(map[int64]struct{})
	for _, link := range links {
		if tx := transactions[link.TransactionId]; tx == nil || tx.Deleted {
			missing[link.TransactionId] = struct{}{}
		}
	}
	report.MissingOrDeletedTransactionCount = int64(len(missing))
	return report, files, nil
}

// ListAllRegisteredFinalObjectKeys 是停服运维专用的跨分片只读枚举，返回值不得写日志。
func (r *Repository) ListAllRegisteredFinalObjectKeys(c core.Context) (map[string]struct{}, error) {
	keys := make(map[string]struct{})
	for index := 0; index < r.store.Count(); index++ {
		sess := r.store.Get(index).NewPrivacySession(c)
		files := make([]*ImportFile, 0)
		err := sess.Cols("storage_object_key").Find(&files)
		sess.Close()
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			keys[file.StorageObjectKey] = struct{}{}
		}
	}
	return keys, nil
}

func batchCountsMatch(batch *ImportBatch, rows []*RawImportRow) bool {
	var valid, invalid, exact, conflict, pending, posted int64
	for _, row := range rows {
		if row.ParseState == PARSE_STATE_VALID {
			valid++
		} else if row.ParseState == PARSE_STATE_INVALID {
			invalid++
		}
		if row.IdentityState == IDENTITY_STATE_EXACT_DUPLICATE {
			exact++
		}
		if row.IdentityState == IDENTITY_STATE_IDENTITY_CONFLICT {
			conflict++
		}
		if row.ProcessingState == PROCESSING_STATE_PENDING {
			pending++
		}
		if row.ProcessingState == PROCESSING_STATE_LINKED {
			posted++
		}
	}
	return batch.TotalRowCount == int64(len(rows)) && batch.ValidRowCount == valid && batch.InvalidRowCount == invalid &&
		batch.ExactDuplicateRowCount == exact && batch.IdentityConflictRowCount == conflict &&
		batch.PendingRowCount == pending && batch.PostedRowCount == posted
}

func mapKeys(values map[int64][]int64) []int64 {
	keys := make([]int64, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func loadTransactionsByIds(sess *xorm.Session, uid int64, ids []int64) (map[int64]*models.Transaction, error) {
	result := make(map[int64]*models.Transaction)
	seen := make(map[int64]struct{})
	unique := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id > 0 {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				unique = append(unique, id)
			}
		}
	}
	for start := 0; start < len(unique); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(unique))
		chunk := make([]*models.Transaction, 0)
		if err := sess.Where("uid=?", uid).In("transaction_id", unique[start:end]).Find(&chunk); err != nil {
			return nil, err
		}
		for _, transaction := range chunk {
			result[transaction.TransactionId] = transaction
		}
	}
	return result, nil
}

func listLinksByRowIdsXorm(sess *xorm.Session, uid int64, rowIds []int64) ([]*RawRowTransactionLink, error) {
	links := make([]*RawRowTransactionLink, 0)
	for start := 0; start < len(rowIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rowIds))
		chunk := make([]*RawRowTransactionLink, 0)
		if err := sess.Where("uid=?", uid).In("row_id", rowIds[start:end]).Find(&chunk); err != nil {
			return nil, err
		}
		links = append(links, chunk...)
	}
	return links, nil
}

func countSharedTransactions(sess *xorm.Session, uid int64, batchId int64, transactionIds []int64) (int64, error) {
	allLinks := make([]*RawRowTransactionLink, 0)
	for start := 0; start < len(transactionIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(transactionIds))
		chunk := make([]*RawRowTransactionLink, 0)
		if err := sess.Where("uid=?", uid).In("transaction_id", transactionIds[start:end]).Find(&chunk); err != nil {
			return 0, err
		}
		allLinks = append(allLinks, chunk...)
	}
	rowIds := make([]int64, 0, len(allLinks))
	txByRow := make(map[int64]int64)
	for _, link := range allLinks {
		rowIds = append(rowIds, link.RowId)
		txByRow[link.RowId] = link.TransactionId
	}
	rows := make([]*RawImportRow, 0)
	for start := 0; start < len(rowIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rowIds))
		chunk := make([]*RawImportRow, 0)
		if err := sess.Cols("row_id", "batch_id").Where("uid=?", uid).In("row_id", rowIds[start:end]).Find(&chunk); err != nil {
			return 0, err
		}
		rows = append(rows, chunk...)
	}
	shared := make(map[int64]struct{})
	for _, row := range rows {
		if row.BatchId != batchId {
			shared[txByRow[row.RowId]] = struct{}{}
		}
	}
	return int64(len(shared)), nil
}
