package importing

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	appErrs "github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const (
	postingQueryChunkSize              = 400
	maximumTransactionEvidenceLinkRows = 2000
)

type postingExistingEvent struct {
	primary     *models.Transaction
	counterpart *models.Transaction
}

// activeReconciliationEvidenceLink 是 v003 只读投影，避免 importing 反向依赖 reconciliation。
type activeReconciliationEvidenceLink struct {
	Uid                        int64
	DecisionId                 int64
	RowId                      int64
	TransactionId              int64
	RelationRole               string
	CreationMethod             string
	RuleVersion                string
	TransactionUpdatedUnixTime int64
	CreatedUnixTime            int64
	LinkId                     int64
}

// CreateOrFindImportPosting 持久化 ready 命令；uid+幂等摘要唯一约束负责并发裁决。
func (r *Repository) CreateOrFindImportPosting(c core.Context, candidate *ImportPosting) (*ImportPosting, bool, error) {
	if err := validateNewImportPosting(candidate); err != nil {
		return nil, false, err
	}

	database, err := r.database(candidate.Uid)

	if err != nil {
		return nil, false, wrapPostingPersistence("select database", err)
	}

	for attempt := 0; attempt < maximumEvidencePersistenceAttempts; attempt++ {
		sess := database.NewPrivacySession(c)
		inserted, insertErr := sess.Insert(candidate)
		sess.Close()

		if insertErr == nil && inserted == 1 {
			copy := *candidate
			return &copy, true, nil
		}

		persisted, findErr := r.findImportPostingByKey(c, candidate.Uid, candidate.IdempotencyKeyDigest)

		if findErr == nil && persisted != nil {
			return persisted, false, nil
		}

		if insertErr == nil {
			insertErr = fmt.Errorf("unexpected inserted row count %d", inserted)
		}

		if findErr != nil {
			insertErr = findErr
		}

		if attempt+1 == maximumEvidencePersistenceAttempts ||
			!isRetryableEvidencePersistenceError(database.DatabaseType(), insertErr) {
			return nil, false, wrapPostingPersistence("create import posting", insertErr)
		}

		if err = waitEvidencePersistenceRetry(c, initialEvidencePersistenceRetryDelay<<attempt); err != nil {
			return nil, false, wrapPostingPersistence("wait to retry import posting", err)
		}
	}

	return nil, false, wrapPostingPersistence("create import posting", errors.New("retry limit reached"))
}

// ExecuteImportPosting 在一个隐私事务内完成账本、证据关系与批次状态推进。
func (r *Repository) ExecuteImportPosting(c core.Context, execution *postingExecution, ledger PostingLedgerWriter, generateId func() int64, now int64) (*ImportPosting, error) {
	if execution == nil || execution.Uid < 1 || execution.BatchId < 1 || execution.PostingId < 1 ||
		len(execution.Commands) < 1 || ledger == nil || generateId == nil || now < 1 {
		return nil, errPostingRowsInvalid
	}

	var completed *ImportPosting
	var callbackErr error
	err := r.DoTransaction(c, execution.Uid, func(tx *RepositoryTransaction) error {
		completed, callbackErr = tx.executeImportPosting(c, execution, ledger, generateId, now)
		return callbackErr
	})

	if err != nil {
		if callbackErr == nil {
			return nil, wrapPostingPersistence("commit import posting", err)
		}

		return nil, err
	}

	return completed, nil
}

// MarkImportPostingFailed 把回滚后仍为 ready 的命令稳定收口为 failed。
func (r *Repository) MarkImportPostingFailed(c core.Context, uid int64, postingId int64, errorCode string, now int64) error {
	if uid < 1 || postingId < 1 || !isSafePostingErrorCode(errorCode) || now < 1 {
		return errPostingRowsInvalid
	}

	database, err := r.database(uid)

	if err != nil {
		return wrapPostingPersistence("select database", err)
	}

	failedTime := now
	update := &ImportPosting{
		Status:          IMPORT_POSTING_STATUS_FAILED,
		ErrorCode:       errorCode,
		FailedUnixTime:  &failedTime,
		UpdatedUnixTime: now,
	}
	sess := database.NewPrivacySession(c)
	updated, err := sess.Where("uid=? AND posting_id=? AND status=?", uid, postingId, IMPORT_POSTING_STATUS_READY).
		Cols("status", "error_code", "failed_unix_time", "updated_unix_time").
		Update(update)
	sess.Close()

	if err != nil {
		return wrapPostingPersistence("mark import posting failed", err)
	}

	if updated == 1 {
		return nil
	}

	persisted, err := r.findImportPostingById(c, uid, postingId)

	if err != nil {
		return err
	}

	if persisted != nil && (persisted.Status == IMPORT_POSTING_STATUS_COMPLETED || persisted.Status == IMPORT_POSTING_STATUS_FAILED) {
		return nil
	}

	return wrapPostingPersistence("mark import posting failed", errPostingClaimLost)
}

// ListTransactionEvidence 按 uid 读取正式交易关联的证据链，不暴露其他用户是否存在同 ID 数据。
func (r *Repository) ListTransactionEvidence(c core.Context, uid int64, transactionId int64) ([]*TransactionEvidenceItem, error) {
	if uid < 1 || transactionId < 1 {
		return nil, errPostingRowsInvalid
	}

	database, err := r.database(uid)

	if err != nil {
		return nil, wrapPostingPersistence("select database", err)
	}

	sess := database.NewPrivacySession(c)
	defer sess.Close()

	links := make([]*RawRowTransactionLink, 0)

	if err = sess.Where("uid=? AND transaction_id=?", uid, transactionId).Asc("link_id").Limit(maximumTransactionEvidenceLinkRows + 1).Find(&links); err != nil {
		return nil, wrapPostingPersistence("list transaction evidence links", err)
	}

	activeLinks := make([]*activeReconciliationEvidenceLink, 0)
	query := sess.Table("pf_reconciliation_transaction_link").Alias("l").
		Join("INNER", "pf_reconciliation_decision", "pf_reconciliation_decision.uid=l.uid AND pf_reconciliation_decision.decision_id=l.decision_id").
		Join("INNER", "pf_reconciliation_case", "pf_reconciliation_case.uid=l.uid AND pf_reconciliation_case.current_decision_id=l.decision_id").
		Select("l.uid, l.decision_id, l.row_id, l.transaction_id, l.relation_role, l.creation_method, l.rule_version, l.transaction_updated_unix_time, l.created_unix_time, l.link_id").
		Where("l.uid=? AND pf_reconciliation_decision.uid=? AND pf_reconciliation_case.uid=? AND l.transaction_id=?", uid, uid, uid, transactionId).
		Asc("l.link_id").Limit(maximumTransactionEvidenceLinkRows + 1)
	if err = query.Find(&activeLinks); err != nil {
		return nil, wrapPostingPersistence("list active reconciliation evidence links", err)
	}
	if len(links)+len(activeLinks) > maximumTransactionEvidenceLinkRows {
		return nil, errPostingEvidenceInvalid
	}
	for _, link := range activeLinks {
		if !validActiveReconciliationEvidenceLink(link, uid, transactionId) {
			return nil, errPostingEvidenceInvalid
		}
		links = append(links, &RawRowTransactionLink{
			Uid: uid, RowId: link.RowId, TransactionId: link.TransactionId,
			RelationRole: RawRowTransactionRelationRole(link.RelationRole), CreationMethod: RawRowTransactionCreationMethod(link.CreationMethod),
			PostingId: 0, RuleVersion: RuleVersion(link.RuleVersion), TransactionUpdatedUnixTime: link.TransactionUpdatedUnixTime,
			CreatedUnixTime: link.CreatedUnixTime, LinkId: link.LinkId,
		})
	}

	if len(links) < 1 {
		return []*TransactionEvidenceItem{}, nil
	}

	rowIdSet := make(map[int64]struct{}, len(links))

	for _, link := range links {
		rowIdSet[link.RowId] = struct{}{}
	}
	rowIds := make([]int64, 0, len(rowIdSet))
	for rowId := range rowIdSet {
		rowIds = append(rowIds, rowId)
	}
	sort.Slice(rowIds, func(i, j int) bool { return rowIds[i] < rowIds[j] })

	rows := make([]*RawImportRow, 0, len(rowIds))

	for start := 0; start < len(rowIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rowIds))
		chunk := make([]*RawImportRow, 0)

		if err = sess.Where("uid=?", uid).In("row_id", rowIds[start:end]).Find(&chunk); err != nil {
			return nil, wrapPostingPersistence("load transaction evidence rows", err)
		}

		rows = append(rows, chunk...)
	}

	rowsById := make(map[int64]*RawImportRow, len(rows))
	batchIdSet := make(map[int64]struct{})

	for _, row := range rows {
		rowsById[row.RowId] = row
		batchIdSet[row.BatchId] = struct{}{}
	}

	if len(rowsById) != len(rowIds) {
		return nil, errPostingEvidenceInvalid
	}

	batchIds := make([]int64, 0, len(batchIdSet))

	for batchId := range batchIdSet {
		batchIds = append(batchIds, batchId)
	}

	batches := make([]*ImportBatch, 0, len(batchIds))

	if err = sess.Where("uid=?", uid).In("batch_id", batchIds).Find(&batches); err != nil {
		return nil, wrapPostingPersistence("load transaction evidence batches", err)
	}

	batchesById := make(map[int64]*ImportBatch, len(batches))
	fileIdSet := make(map[int64]struct{})

	for _, batch := range batches {
		batchesById[batch.BatchId] = batch
		fileIdSet[batch.FileId] = struct{}{}
	}

	if len(batchesById) != len(batchIds) {
		return nil, errPostingEvidenceInvalid
	}

	fileIds := make([]int64, 0, len(fileIdSet))

	for fileId := range fileIdSet {
		fileIds = append(fileIds, fileId)
	}

	files := make([]*ImportFile, 0, len(fileIds))

	if err = sess.Where("uid=?", uid).In("file_id", fileIds).Find(&files); err != nil {
		return nil, wrapPostingPersistence("load transaction evidence files", err)
	}

	filesById := make(map[int64]*ImportFile, len(files))

	for _, file := range files {
		filesById[file.FileId] = file
	}

	if len(filesById) != len(fileIds) {
		return nil, errPostingEvidenceInvalid
	}

	items := make([]*TransactionEvidenceItem, 0, len(links))

	for _, link := range links {
		row := rowsById[link.RowId]
		batch := batchesById[row.BatchId]
		file := filesById[batch.FileId]
		items = append(items, &TransactionEvidenceItem{Link: link, Row: row, Batch: batch, File: file})
	}

	return items, nil
}

func validActiveReconciliationEvidenceLink(link *activeReconciliationEvidenceLink, uid int64, transactionId int64) bool {
	if link == nil || link.Uid != uid || link.DecisionId < 1 || link.RowId < 1 || link.TransactionId != transactionId || link.LinkId < 1 ||
		link.TransactionUpdatedUnixTime < 1 || link.CreatedUnixTime < 1 || link.RuleVersion != "reconciliation-link-v1" {
		return false
	}
	if link.CreationMethod != "attached_existing" && link.CreationMethod != "reconciliation_created" {
		return false
	}
	return link.RelationRole == "primary" || link.RelationRole == "transfer_counterpart" ||
		link.RelationRole == "refund_original" || link.RelationRole == "refund_transaction"
}

func (tx *RepositoryTransaction) executeImportPosting(c core.Context, execution *postingExecution, ledger PostingLedgerWriter, generateId func() int64, now int64) (*ImportPosting, error) {
	startedTime := now
	claim := &ImportPosting{
		Status:          IMPORT_POSTING_STATUS_POSTING,
		StartedUnixTime: &startedTime,
		UpdatedUnixTime: now,
	}
	updated, err := tx.session.Where("uid=? AND posting_id=? AND batch_id=? AND status=?", execution.Uid, execution.PostingId, execution.BatchId, IMPORT_POSTING_STATUS_READY).
		Cols("status", "started_unix_time", "updated_unix_time").
		Update(claim)

	if err != nil {
		return nil, wrapPostingPersistence("claim import posting", err)
	}

	if updated != 1 {
		persisted, findErr := tx.findImportPostingById(execution.Uid, execution.PostingId)

		if findErr != nil {
			return nil, findErr
		}

		if persisted != nil && persisted.BatchId == execution.BatchId && persisted.Status == IMPORT_POSTING_STATUS_COMPLETED {
			return persisted, nil
		}

		return nil, errPostingClaimLost
	}

	batchClaim := &ImportBatch{Status: IMPORT_BATCH_STATUS_POSTING, UpdatedUnixTime: now}
	updated, err = tx.session.Where("uid=? AND batch_id=?", execution.Uid, execution.BatchId).
		In("status", []string{string(IMPORT_BATCH_STATUS_READY), string(IMPORT_BATCH_STATUS_PARTIALLY_POSTED)}).
		Cols("status", "updated_unix_time").
		Update(batchClaim)

	if err != nil {
		return nil, wrapPostingPersistence("claim import batch", err)
	}

	if updated != 1 {
		batch := new(ImportBatch)
		found, findErr := tx.session.Where("uid=? AND batch_id=?", execution.Uid, execution.BatchId).Get(batch)

		if findErr != nil {
			return nil, wrapPostingPersistence("find import batch after failed claim", findErr)
		}

		if !found {
			return nil, errPostingBatchNotFound
		}

		return nil, errPostingClaimLost
	}

	rowsById, identityIds, err := tx.loadAndValidatePostingRows(execution)

	if err != nil {
		return nil, err
	}

	linksByIdentity, err := tx.loadPostingLinksByIdentity(execution.Uid, identityIds)

	if err != nil {
		return nil, err
	}

	transactionsById, err := tx.loadLinkedTransactions(execution.Uid, linksByIdentity)

	if err != nil {
		return nil, err
	}

	createdCount := int64(0)
	reusedCount := int64(0)
	selectedRowIds := make([]int64, 0, len(rowsById))

	for _, command := range execution.Commands {
		identityId := *rowsById[command.RowIds[0]].IdentityId

		for _, link := range linksByIdentity[identityId] {
			if _, selected := rowsById[link.RowId]; selected {
				return nil, errPostingEvidenceInvalid
			}
		}

		event, eventErr := resolvePostingExistingEvent(linksByIdentity[identityId], transactionsById)

		if eventErr != nil {
			return nil, eventErr
		}

		creationMethod := RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED

		if event == nil {
			if command.Transaction == nil {
				return nil, errPostingRowsInvalid
			}

			primary, counterpart, createErr := ledger.CreateTransactionInSession(c, tx.database, tx.session, command.Transaction, command.TagIds)

			if createErr != nil {
				if !appErrs.IsCustomError(createErr) {
					return nil, wrapPostingPersistence("create ledger transaction", createErr)
				}

				return nil, createErr
			}

			if err = validateCreatedPostingEvent(execution.Uid, primary, counterpart); err != nil {
				return nil, err
			}

			event = &postingExistingEvent{primary: primary, counterpart: counterpart}
			creationMethod = RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED
			createdCount++
		} else {
			reusedCount++
		}

		for _, rowId := range command.RowIds {
			if err = tx.insertPostingLink(execution, rowId, event.primary, RAW_ROW_TRANSACTION_RELATION_PRIMARY, creationMethod, generateId, now); err != nil {
				return nil, err
			}

			if event.counterpart != nil {
				if err = tx.insertPostingLink(execution, rowId, event.counterpart, RAW_ROW_TRANSACTION_RELATION_TRANSFER_COUNTERPART, creationMethod, generateId, now); err != nil {
					return nil, err
				}
			}

			selectedRowIds = append(selectedRowIds, rowId)
		}
	}

	rowUpdate := &RawImportRow{
		ProcessingState: PROCESSING_STATE_LINKED,
		Disposition:     IMPORT_DISPOSITION_NON_POSTABLE,
	}
	updated, err = tx.session.Where("uid=? AND batch_id=? AND processing_state=?", execution.Uid, execution.BatchId, PROCESSING_STATE_PENDING).
		In("row_id", selectedRowIds).
		Cols("processing_state", "disposition").
		Update(rowUpdate)

	if err != nil {
		return nil, wrapPostingPersistence("update posted import rows", err)
	}

	if updated != int64(len(selectedRowIds)) {
		return nil, errPostingClaimLost
	}

	pendingCount, err := tx.session.Where("uid=? AND batch_id=? AND processing_state=?", execution.Uid, execution.BatchId, PROCESSING_STATE_PENDING).Count(new(RawImportRow))

	if err != nil {
		return nil, wrapPostingPersistence("count pending import rows", err)
	}

	postedCount, err := tx.session.Where("uid=? AND batch_id=? AND processing_state=?", execution.Uid, execution.BatchId, PROCESSING_STATE_LINKED).Count(new(RawImportRow))

	if err != nil {
		return nil, wrapPostingPersistence("count linked import rows", err)
	}

	nextBatchStatus := IMPORT_BATCH_STATUS_PARTIALLY_POSTED

	if pendingCount == 0 {
		nextBatchStatus = IMPORT_BATCH_STATUS_COMPLETED
	}

	batchResult := &ImportBatch{
		Status:          nextBatchStatus,
		PendingRowCount: pendingCount,
		PostedRowCount:  postedCount,
		UpdatedUnixTime: now,
	}
	updated, err = tx.session.Where("uid=? AND batch_id=? AND status=?", execution.Uid, execution.BatchId, IMPORT_BATCH_STATUS_POSTING).
		Cols("status", "pending_row_count", "posted_row_count", "updated_unix_time").
		Update(batchResult)

	if err != nil {
		return nil, wrapPostingPersistence("complete import batch posting", err)
	}

	if updated != 1 {
		return nil, errPostingClaimLost
	}

	completedTime := now
	postingResult := &ImportPosting{
		Status:                  IMPORT_POSTING_STATUS_COMPLETED,
		CreatedTransactionCount: createdCount,
		ReusedTransactionCount:  reusedCount,
		ErrorCode:               "",
		CompletedUnixTime:       &completedTime,
		UpdatedUnixTime:         now,
	}
	updated, err = tx.session.Where("uid=? AND posting_id=? AND status=?", execution.Uid, execution.PostingId, IMPORT_POSTING_STATUS_POSTING).
		Cols("status", "created_transaction_count", "reused_transaction_count", "error_code", "completed_unix_time", "updated_unix_time").
		Update(postingResult)

	if err != nil {
		return nil, wrapPostingPersistence("complete import posting", err)
	}

	if updated != 1 {
		return nil, errPostingClaimLost
	}

	return tx.findImportPostingById(execution.Uid, execution.PostingId)
}

func (tx *RepositoryTransaction) loadAndValidatePostingRows(execution *postingExecution) (map[int64]*RawImportRow, []int64, error) {
	rowIds := make([]int64, 0)

	for _, command := range execution.Commands {
		rowIds = append(rowIds, command.RowIds...)
	}

	rows := make([]*RawImportRow, 0, len(rowIds))

	for start := 0; start < len(rowIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rowIds))
		chunk := make([]*RawImportRow, 0, end-start)
		sess := tx.session.Where("uid=? AND batch_id=?", execution.Uid, execution.BatchId).In("row_id", rowIds[start:end])

		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			sess = sess.ForUpdate()
		}

		if err := sess.Find(&chunk); err != nil {
			return nil, nil, wrapPostingPersistence("load import rows for posting", err)
		}

		rows = append(rows, chunk...)
	}

	if len(rows) != len(rowIds) {
		return nil, nil, errPostingRowsInvalid
	}

	rowsById := make(map[int64]*RawImportRow, len(rows))
	identitySet := make(map[int64]struct{})
	commandByIdentity := make(map[int64]int)

	for _, row := range rows {
		if row == nil || row.Uid != execution.Uid || row.BatchId != execution.BatchId || row.RowId < 1 ||
			row.ParseState != PARSE_STATE_VALID || row.ProcessingState != PROCESSING_STATE_PENDING || row.IdentityId == nil || *row.IdentityId < 1 ||
			(row.Disposition != IMPORT_DISPOSITION_POSTABLE && row.Disposition != IMPORT_DISPOSITION_REVIEW_REQUIRED) ||
			(row.IdentityState != IDENTITY_STATE_NEW && row.IdentityState != IDENTITY_STATE_EXACT_DUPLICATE && row.IdentityState != IDENTITY_STATE_BATCH_LOCAL) {
			return nil, nil, errPostingRowsInvalid
		}

		if _, exists := rowsById[row.RowId]; exists {
			return nil, nil, errPostingEvidenceInvalid
		}

		rowsById[row.RowId] = row
		identitySet[*row.IdentityId] = struct{}{}
	}

	for commandIndex, command := range execution.Commands {
		if len(command.RowIds) < 1 {
			return nil, nil, errPostingRowsInvalid
		}

		firstRow := rowsById[command.RowIds[0]]

		if firstRow == nil {
			return nil, nil, errPostingRowsInvalid
		}

		identityId := *firstRow.IdentityId

		if previous, exists := commandByIdentity[identityId]; exists && previous != commandIndex {
			return nil, nil, errPostingRowsInvalid
		}

		commandByIdentity[identityId] = commandIndex

		for _, rowId := range command.RowIds {
			row := rowsById[rowId]

			if row == nil || *row.IdentityId != identityId {
				return nil, nil, errPostingRowsInvalid
			}

			if command.Transaction == nil && (row.Disposition == IMPORT_DISPOSITION_REVIEW_REQUIRED || row.IdentityState == IDENTITY_STATE_BATCH_LOCAL) {
				return nil, nil, errPostingRowsInvalid
			}
		}
	}

	identityIds := make([]int64, 0, len(identitySet))

	for identityId := range identitySet {
		identityIds = append(identityIds, identityId)
	}

	sort.Slice(identityIds, func(left, right int) bool { return identityIds[left] < identityIds[right] })
	identityCount := 0

	for start := 0; start < len(identityIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(identityIds))
		identities := make([]*SourceIdentity, 0, end-start)
		sess := tx.session.Where("uid=?", execution.Uid).In("identity_id", identityIds[start:end])

		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			sess = sess.ForUpdate()
		}

		err := sess.Find(&identities)

		if err != nil {
			return nil, nil, wrapPostingPersistence("validate posting identities", err)
		}

		identityCount += len(identities)
	}

	if identityCount != len(identityIds) {
		return nil, nil, errPostingEvidenceInvalid
	}

	return rowsById, identityIds, nil
}

func (tx *RepositoryTransaction) loadPostingLinksByIdentity(uid int64, identityIds []int64) (map[int64][]*RawRowTransactionLink, error) {
	type identityRow struct {
		RowId      int64  `xorm:"row_id"`
		IdentityId *int64 `xorm:"identity_id"`
	}

	rows := make([]identityRow, 0)

	for start := 0; start < len(identityIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(identityIds))
		chunk := make([]identityRow, 0)

		if err := tx.session.Table(new(RawImportRow)).Cols("row_id", "identity_id").Where("uid=?", uid).
			In("identity_id", identityIds[start:end]).Find(&chunk); err != nil {
			return nil, wrapPostingPersistence("load rows for posting identities", err)
		}

		rows = append(rows, chunk...)
	}

	rowToIdentity := make(map[int64]int64, len(rows))
	rowIds := make([]int64, 0, len(rows))

	for _, row := range rows {
		if row.RowId < 1 || row.IdentityId == nil || *row.IdentityId < 1 {
			return nil, errPostingEvidenceInvalid
		}

		rowToIdentity[row.RowId] = *row.IdentityId
		rowIds = append(rowIds, row.RowId)
	}

	linksByIdentity := make(map[int64][]*RawRowTransactionLink, len(identityIds))

	for start := 0; start < len(rowIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(rowIds))
		links := make([]*RawRowTransactionLink, 0)
		sess := tx.session.Where("uid=?", uid).In("row_id", rowIds[start:end])

		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			sess = sess.ForUpdate()
		}

		if err := sess.Find(&links); err != nil {
			return nil, wrapPostingPersistence("load posting evidence links", err)
		}

		for _, link := range links {
			identityId, exists := rowToIdentity[link.RowId]

			if !exists {
				return nil, errPostingEvidenceInvalid
			}

			linksByIdentity[identityId] = append(linksByIdentity[identityId], link)
		}
	}

	return linksByIdentity, nil
}

func (tx *RepositoryTransaction) loadLinkedTransactions(uid int64, linksByIdentity map[int64][]*RawRowTransactionLink) (map[int64]*models.Transaction, error) {
	transactionIdSet := make(map[int64]struct{})

	for _, links := range linksByIdentity {
		for _, link := range links {
			if link == nil || link.Uid != uid || link.LinkId < 1 || link.RowId < 1 || link.TransactionId < 1 || link.PostingId < 1 ||
				link.TransactionUpdatedUnixTime < 1 || link.CreatedUnixTime < 1 ||
				link.RuleVersion != POSTING_LINK_VERSION_V1 ||
				(link.RelationRole != RAW_ROW_TRANSACTION_RELATION_PRIMARY && link.RelationRole != RAW_ROW_TRANSACTION_RELATION_TRANSFER_COUNTERPART) ||
				(link.CreationMethod != RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED && link.CreationMethod != RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED) {
				return nil, errPostingEvidenceInvalid
			}

			transactionIdSet[link.TransactionId] = struct{}{}
		}
	}

	transactionIds := make([]int64, 0, len(transactionIdSet))

	for transactionId := range transactionIdSet {
		transactionIds = append(transactionIds, transactionId)
	}

	transactionsById := make(map[int64]*models.Transaction, len(transactionIds))

	for start := 0; start < len(transactionIds); start += postingQueryChunkSize {
		end := min(start+postingQueryChunkSize, len(transactionIds))
		transactions := make([]*models.Transaction, 0)
		sess := tx.session.Where("uid=?", uid).In("transaction_id", transactionIds[start:end])

		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			sess = sess.ForUpdate()
		}

		if err := sess.Find(&transactions); err != nil {
			return nil, wrapPostingPersistence("load linked ledger transactions", err)
		}

		for _, transaction := range transactions {
			if transaction == nil || transaction.Uid != uid || transaction.TransactionId < 1 {
				return nil, errPostingEvidenceInvalid
			}

			transactionsById[transaction.TransactionId] = transaction
		}
	}

	if len(transactionsById) != len(transactionIds) {
		return nil, errPostingEvidenceInvalid
	}

	return transactionsById, nil
}

func resolvePostingExistingEvent(links []*RawRowTransactionLink, transactionsById map[int64]*models.Transaction) (*postingExistingEvent, error) {
	if len(links) < 1 {
		return nil, nil
	}

	primaryId := int64(0)
	counterpartId := int64(0)

	for _, link := range links {
		switch link.RelationRole {
		case RAW_ROW_TRANSACTION_RELATION_PRIMARY:
			if primaryId != 0 && primaryId != link.TransactionId {
				return nil, errPostingEvidenceInvalid
			}

			primaryId = link.TransactionId
		case RAW_ROW_TRANSACTION_RELATION_TRANSFER_COUNTERPART:
			if counterpartId != 0 && counterpartId != link.TransactionId {
				return nil, errPostingEvidenceInvalid
			}

			counterpartId = link.TransactionId
		default:
			return nil, errPostingEvidenceInvalid
		}
	}

	if primaryId < 1 || primaryId == counterpartId {
		return nil, errPostingEvidenceInvalid
	}

	primary := transactionsById[primaryId]

	if primary == nil || primary.Deleted {
		return nil, errPostingEvidenceInvalid
	}

	event := &postingExistingEvent{primary: primary}

	if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		counterpart := transactionsById[counterpartId]

		if counterpartId < 1 || counterpart == nil || counterpart.Deleted || !isCompleteTransferPair(primary, counterpart) {
			return nil, errPostingEvidenceInvalid
		}

		event.counterpart = counterpart
	} else if primary.Type != models.TRANSACTION_DB_TYPE_INCOME && primary.Type != models.TRANSACTION_DB_TYPE_EXPENSE {
		return nil, errPostingEvidenceInvalid
	} else if counterpartId != 0 {
		return nil, errPostingEvidenceInvalid
	}

	return event, nil
}

func validateCreatedPostingEvent(uid int64, primary *models.Transaction, counterpart *models.Transaction) error {
	if primary == nil || primary.Uid != uid || primary.TransactionId < 1 || primary.Deleted || primary.UpdatedUnixTime < 1 {
		return errPostingEvidenceInvalid
	}

	if primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT || primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN {
		if counterpart == nil || !isCompleteTransferPair(primary, counterpart) {
			return errPostingEvidenceInvalid
		}

		return nil
	}

	if (primary.Type != models.TRANSACTION_DB_TYPE_INCOME && primary.Type != models.TRANSACTION_DB_TYPE_EXPENSE) || counterpart != nil {
		return errPostingEvidenceInvalid
	}

	return nil
}

func isCompleteTransferPair(primary *models.Transaction, counterpart *models.Transaction) bool {
	if primary == nil || counterpart == nil || primary.Uid != counterpart.Uid ||
		primary.TransactionId < 1 || counterpart.TransactionId < 1 || primary.TransactionId == counterpart.TransactionId ||
		primary.RelatedId != counterpart.TransactionId || counterpart.RelatedId != primary.TransactionId ||
		primary.AccountId != counterpart.RelatedAccountId || primary.RelatedAccountId != counterpart.AccountId ||
		primary.Amount != counterpart.RelatedAccountAmount || primary.RelatedAccountAmount != counterpart.Amount ||
		primary.CategoryId != counterpart.CategoryId || primary.TimezoneUtcOffset != counterpart.TimezoneUtcOffset {
		return false
	}

	return (primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT && counterpart.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN && counterpart.TransactionTime == primary.TransactionTime+1) ||
		(primary.Type == models.TRANSACTION_DB_TYPE_TRANSFER_IN && counterpart.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT && counterpart.TransactionTime == primary.TransactionTime-1)
}

func (tx *RepositoryTransaction) insertPostingLink(execution *postingExecution, rowId int64, transaction *models.Transaction, role RawRowTransactionRelationRole, method RawRowTransactionCreationMethod, generateId func() int64, now int64) error {
	linkId := generateId()

	if linkId < 1 {
		return errPostingIdentifier
	}

	link := &RawRowTransactionLink{
		Uid:                        execution.Uid,
		RowId:                      rowId,
		TransactionId:              transaction.TransactionId,
		RelationRole:               role,
		CreationMethod:             method,
		PostingId:                  execution.PostingId,
		RuleVersion:                POSTING_LINK_VERSION_V1,
		TransactionUpdatedUnixTime: transaction.UpdatedUnixTime,
		CreatedUnixTime:            now,
		LinkId:                     linkId,
	}
	inserted, err := tx.session.Insert(link)

	if err != nil {
		return wrapPostingPersistence("insert posting evidence link", err)
	}

	if inserted != 1 {
		return wrapPostingPersistence("insert posting evidence link", fmt.Errorf("unexpected inserted row count %d", inserted))
	}

	return nil
}

func (r *Repository) findImportPostingByKey(c core.Context, uid int64, keyDigest string) (*ImportPosting, error) {
	database, err := r.database(uid)

	if err != nil {
		return nil, wrapPostingPersistence("select database", err)
	}

	posting := new(ImportPosting)
	sess := database.NewPrivacySession(c)
	found, err := sess.Where("uid=? AND idempotency_key_digest=?", uid, keyDigest).Get(posting)
	sess.Close()

	if err != nil {
		return nil, wrapPostingPersistence("find import posting by key", err)
	}

	if !found {
		return nil, nil
	}

	return posting, nil
}

func (r *Repository) findImportPostingById(c core.Context, uid int64, postingId int64) (*ImportPosting, error) {
	database, err := r.database(uid)

	if err != nil {
		return nil, wrapPostingPersistence("select database", err)
	}

	posting := new(ImportPosting)
	sess := database.NewPrivacySession(c)
	found, err := sess.Where("uid=? AND posting_id=?", uid, postingId).Get(posting)
	sess.Close()

	if err != nil {
		return nil, wrapPostingPersistence("find import posting", err)
	}

	if !found {
		return nil, nil
	}

	return posting, nil
}

func (tx *RepositoryTransaction) findImportPostingById(uid int64, postingId int64) (*ImportPosting, error) {
	posting := new(ImportPosting)
	sess := tx.session.Where("uid=? AND posting_id=?", uid, postingId)

	if tx.database.DatabaseType() != settings.Sqlite3DbType {
		sess = sess.ForUpdate()
	}

	found, err := sess.Get(posting)

	if err != nil {
		return nil, wrapPostingPersistence("find import posting in transaction", err)
	}

	if !found {
		return nil, nil
	}

	return posting, nil
}

func validateNewImportPosting(posting *ImportPosting) error {
	if posting == nil || posting.Uid < 1 || posting.BatchId < 1 || posting.PostingId < 1 ||
		!isLowerHexSHA256(posting.IdempotencyKeyDigest) || !isLowerHexSHA256(posting.RequestDigest) ||
		posting.IdempotencyKeyVersion != IDEMPOTENCY_KEY_VERSION_V1 || posting.RequestDigestVersion != POSTING_REQUEST_VERSION_V1 ||
		posting.Status != IMPORT_POSTING_STATUS_READY || posting.SelectedRowCount < 1 ||
		posting.CreatedTransactionCount != 0 || posting.ReusedTransactionCount != 0 || posting.ErrorCode != "" ||
		posting.CreatedUnixTime < 1 || posting.UpdatedUnixTime < posting.CreatedUnixTime ||
		posting.StartedUnixTime != nil || posting.CompletedUnixTime != nil || posting.FailedUnixTime != nil {
		return errPostingRowsInvalid
	}

	return nil
}

func isSafePostingErrorCode(value string) bool {
	if value == "" || len(value) > 64 || strings.ToLower(value) != value {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}

	return true
}

func wrapPostingPersistence(action string, err error) error {
	return fmt.Errorf("%w: %s: %w", errPostingPersistence, action, err)
}
