package importing

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
	"unicode/utf8"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/lib/pq"
	"github.com/mattn/go-sqlite3"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const (
	maximumEvidencePersistenceAttempts   = 8
	initialEvidencePersistenceRetryDelay = 5 * time.Millisecond
)

// PersistEvidenceBatch 在一个隐私事务中完成来源身份唯一裁决、批次和全部原始行写入。
// source_identity 的核心摘要永不被后来的冲突证据覆盖。
func (r *Repository) PersistEvidenceBatch(c core.Context, persistence *EvidenceBatchPersistence) error {
	if err := validateEvidenceBatchPersistence(persistence); err != nil {
		return err
	}

	database, _ := r.database(persistence.Batch.Uid)

	for attempt := 0; attempt < maximumEvidencePersistenceAttempts; attempt++ {
		working := cloneEvidenceBatchPersistence(persistence)
		err := r.DoTransaction(c, working.Batch.Uid, func(tx *RepositoryTransaction) error {
			return tx.persistEvidenceBatch(working)
		})

		if err == nil {
			*persistence.Batch = *working.Batch

			for index := range persistence.Rows {
				*persistence.Rows[index].Row = *working.Rows[index].Row
			}

			return nil
		}

		if attempt+1 == maximumEvidencePersistenceAttempts ||
			!isRetryableEvidencePersistenceError(database.DatabaseType(), err) {
			return err
		}

		delay := initialEvidencePersistenceRetryDelay << attempt
		delay += time.Duration((persistence.Batch.BatchId+int64(attempt))%7) * time.Millisecond

		if err := waitEvidencePersistenceRetry(c, delay); err != nil {
			return err
		}
	}

	return fmt.Errorf("personal finance evidence persistence retry limit reached")
}

func isRetryableEvidencePersistenceError(databaseType string, err error) bool {
	switch databaseType {
	case settings.Sqlite3DbType:
		var sqliteError sqlite3.Error

		return errors.As(err, &sqliteError) &&
			(sqliteError.Code == sqlite3.ErrBusy || sqliteError.Code == sqlite3.ErrLocked)
	case settings.MySqlDbType:
		var mysqlError *mysqlDriver.MySQLError

		return errors.As(err, &mysqlError) && (mysqlError.Number == 1205 || mysqlError.Number == 1213)
	case settings.PostgresDbType:
		var postgresError *pq.Error

		return errors.As(err, &postgresError) &&
			(postgresError.Code == "40001" || postgresError.Code == "40P01")
	default:
		return false
	}
}

func waitEvidencePersistenceRetry(c core.Context, delay time.Duration) error {
	if c == nil {
		time.Sleep(delay)
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-c.Done():
		return c.Err()
	}
}

func (tx *RepositoryTransaction) persistEvidenceBatch(persistence *EvidenceBatchPersistence) error {
	batch := persistence.Batch
	file, err := tx.findImportFileForEvidence(batch.Uid, batch.FileId)

	if err != nil {
		return err
	}

	if file == nil {
		return errEvidenceImportFileNotFound
	}

	if file.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE || !isLowerHexSHA256(file.FileSha256) {
		return errEvidenceImportFileContentUnavailable
	}

	account, err := tx.findSourceAccountForEvidence(batch.Uid, *batch.SourceAccountId)

	if err != nil {
		return err
	}

	if account == nil {
		return errEvidenceSourceAccountNotFound
	}

	versions := CurrentCentralRuleVersions()

	if account.Status != SOURCE_ACCOUNT_STATUS_ACTIVE ||
		account.SourceType != batch.SourceTypeSnapshot ||
		account.SourceAccountKey != persistence.ExpectedSourceAccountKey ||
		account.SourceAccountKeyVersion != versions.SourceAccountKeyVersion ||
		(account.LedgerAccountId != nil && *account.LedgerAccountId < 1) {
		return errEvidenceSourceAccountUnavailable
	}

	batch.LedgerAccountId = cloneInt64Pointer(account.LedgerAccountId)
	resetImportBatchCounts(batch)
	resolutionOrder := evidenceIdentityResolutionOrder(persistence.Rows)

	for _, index := range resolutionOrder {
		entry := &persistence.Rows[index]
		identity, inserted, err := tx.resolveSourceIdentity(
			batch.Uid,
			account.SourceAccountId,
			entry.CandidateIdentityId,
			entry.IdentityCandidate,
			batch.CreatedUnixTime,
		)

		if err != nil {
			return err
		}

		candidate := entry.IdentityCandidate

		identityId := identity.IdentityId
		entry.Row.IdentityId = &identityId

		switch {
		case candidate.Kind == IDENTITY_KIND_BATCH_LOCAL:
			entry.Row.IdentityState = IDENTITY_STATE_BATCH_LOCAL
		case inserted:
			entry.Row.IdentityState = IDENTITY_STATE_NEW
		case identity.SourceCoreDigest == candidate.SourceCoreDigest:
			entry.Row.IdentityState = IDENTITY_STATE_EXACT_DUPLICATE
		default:
			entry.Row.IdentityState = IDENTITY_STATE_IDENTITY_CONFLICT
		}
	}

	for index := range persistence.Rows {
		entry := &persistence.Rows[index]
		row := entry.Row

		if row.ParseState == PARSE_STATE_INVALID {
			row.IdentityId = nil
			row.IdentityState = IDENTITY_STATE_NOT_EVALUATED
		}

		row.LedgerAccountId = nil

		if row.ParseState == PARSE_STATE_VALID {
			row.LedgerAccountId = cloneInt64Pointer(account.LedgerAccountId)
		}

		outcome, err := ResolveImportDisposition(row.ParseState, row.SemanticEligibility, row.IdentityState, false)

		if err != nil {
			return fmt.Errorf("resolve personal finance evidence row disposition: %w", err)
		}

		row.Disposition = outcome.Disposition
		row.ProcessingState = outcome.ProcessingState
		accumulateImportBatchCounts(batch, row)
	}

	inserted, err := tx.session.Insert(batch)

	if err != nil {
		return fmt.Errorf("insert personal finance import batch: %w", err)
	}

	if inserted != 1 {
		return fmt.Errorf("personal finance import batch was not inserted")
	}

	for _, issue := range persistence.DocumentIssues {
		inserted, err = tx.session.Insert(issue)

		if err != nil {
			return fmt.Errorf("insert personal finance import batch issue: %w", err)
		}

		if inserted != 1 {
			return fmt.Errorf("personal finance import batch issue was not inserted")
		}
	}

	for index := range persistence.Rows {
		inserted, err = tx.session.Insert(persistence.Rows[index].Row)

		if err != nil {
			return fmt.Errorf("insert personal finance raw import row: %w", err)
		}

		if inserted != 1 {
			return fmt.Errorf("personal finance raw import row was not inserted")
		}
	}

	return nil
}

func (tx *RepositoryTransaction) findImportFileForEvidence(uid int64, fileId int64) (*ImportFile, error) {
	file := new(ImportFile)
	sess := tx.session.Where("uid=? AND file_id=?", uid, fileId)

	if tx.database.DatabaseType() != settings.Sqlite3DbType {
		sess = sess.ForUpdate()
	}

	found, err := sess.Get(file)

	if err != nil {
		return nil, fmt.Errorf("find personal finance import file for evidence: %w", err)
	}

	if !found {
		return nil, nil
	}

	return file, nil
}

func (tx *RepositoryTransaction) findSourceAccountForEvidence(uid int64, sourceAccountId int64) (*SourceAccount, error) {
	account := new(SourceAccount)
	sess := tx.session.Where("uid=? AND source_account_id=?", uid, sourceAccountId)

	if tx.database.DatabaseType() != settings.Sqlite3DbType {
		sess = sess.ForUpdate()
	}

	found, err := sess.Get(account)

	if err != nil {
		return nil, fmt.Errorf("find personal finance source account for evidence: %w", err)
	}

	if !found {
		return nil, nil
	}

	return account, nil
}

func (tx *RepositoryTransaction) resolveSourceIdentity(uid int64, sourceAccountId int64, candidateIdentityId int64, candidate *IdentityCandidate, seenUnixTime int64) (*SourceIdentity, bool, error) {
	identity := &SourceIdentity{
		Uid:                uid,
		SourceAccountId:    sourceAccountId,
		IdentityKind:       candidate.Kind,
		SourceIdentityKey:  candidate.SourceIdentityKey,
		SourceCoreDigest:   candidate.SourceCoreDigest,
		IdentityKeyVersion: candidate.IdentityKeyVersion,
		CoreDigestVersion:  candidate.CoreDigestVersion,
		FingerprintVersion: candidate.FingerprintVersion,
		FirstSeenUnixTime:  seenUnixTime,
		LastSeenUnixTime:   seenUnixTime,
		IdentityId:         candidateIdentityId,
	}
	insertSQL := `INSERT INTO pf_source_identity (
		uid, source_account_id, identity_kind, source_identity_key, source_core_digest,
		identity_key_version, core_digest_version, fingerprint_version,
		first_seen_unix_time, last_seen_unix_time, identity_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch tx.database.DatabaseType() {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		insertSQL += " ON CONFLICT (uid, source_identity_key) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, false, fmt.Errorf("unsupported personal finance database type")
	}

	result, err := tx.session.Exec(
		insertSQL,
		identity.Uid,
		identity.SourceAccountId,
		identity.IdentityKind,
		identity.SourceIdentityKey,
		identity.SourceCoreDigest,
		identity.IdentityKeyVersion,
		identity.CoreDigestVersion,
		identity.FingerprintVersion,
		identity.FirstSeenUnixTime,
		identity.LastSeenUnixTime,
		identity.IdentityId,
	)

	inserted := false

	if err != nil {
		// MySQL 的普通 INSERT 在 1062 时只回滚当前语句，事务仍可继续。
		// 只收敛这一种唯一冲突；不使用 INSERT IGNORE 吞掉截断或其他数据警告。
		if tx.database.DatabaseType() != settings.MySqlDbType || !isMySQLDuplicateEntryError(err) {
			return nil, false, fmt.Errorf("insert personal finance source identity: %w", err)
		}
	} else {
		affected, rowsAffectedErr := result.RowsAffected()

		if rowsAffectedErr != nil {
			return nil, false, fmt.Errorf("read personal finance source identity insert result: %w", rowsAffectedErr)
		}

		if affected < 0 || affected > 1 {
			return nil, false, fmt.Errorf("read personal finance source identity insert result")
		}

		inserted = affected == 1
	}

	persisted := new(SourceIdentity)
	sess := tx.session.Where("uid=? AND source_identity_key=?", uid, candidate.SourceIdentityKey)

	if tx.database.DatabaseType() != settings.Sqlite3DbType {
		sess = sess.ForUpdate()
	}

	found, err := sess.Get(persisted)

	if err != nil {
		return nil, false, fmt.Errorf("find resolved personal finance source identity: %w", err)
	}

	if !found {
		return nil, false, fmt.Errorf("resolved personal finance source identity is missing")
	}

	if err := validateResolvedSourceIdentity(persisted, uid, sourceAccountId, candidate); err != nil {
		return nil, false, err
	}

	if persisted.LastSeenUnixTime < seenUnixTime {
		updated, err := tx.session.Where(
			"uid=? AND identity_id=? AND last_seen_unix_time<?",
			uid,
			persisted.IdentityId,
			seenUnixTime,
		).Cols("last_seen_unix_time").Update(&SourceIdentity{LastSeenUnixTime: seenUnixTime})

		if err != nil {
			return nil, false, fmt.Errorf("update personal finance source identity last seen time: %w", err)
		}

		if updated != 1 {
			return nil, false, fmt.Errorf("personal finance source identity last seen time was not updated")
		}

		persisted.LastSeenUnixTime = seenUnixTime
	}

	return persisted, inserted, nil
}

func isMySQLDuplicateEntryError(err error) bool {
	var mysqlError *mysqlDriver.MySQLError

	return errors.As(err, &mysqlError) && mysqlError.Number == 1062
}

func validateResolvedSourceIdentity(identity *SourceIdentity, uid int64, sourceAccountId int64, candidate *IdentityCandidate) error {
	if identity == nil || candidate == nil || identity.Uid != uid || identity.SourceAccountId != sourceAccountId ||
		identity.IdentityId < 1 || identity.IdentityKind != candidate.Kind ||
		identity.SourceIdentityKey != candidate.SourceIdentityKey || !isLowerHexSHA256(identity.SourceCoreDigest) ||
		identity.IdentityKeyVersion != candidate.IdentityKeyVersion ||
		identity.CoreDigestVersion != candidate.CoreDigestVersion ||
		identity.FingerprintVersion != candidate.FingerprintVersion ||
		identity.FirstSeenUnixTime < 1 || identity.LastSeenUnixTime < identity.FirstSeenUnixTime {
		return fmt.Errorf("personal finance source identity invariant mismatch")
	}

	return nil
}

func validateEvidenceBatchPersistence(persistence *EvidenceBatchPersistence) error {
	if persistence == nil || persistence.Batch == nil {
		return fmt.Errorf("invalid personal finance evidence batch persistence")
	}

	batch := persistence.Batch

	if batch.Uid < 1 || batch.FileId < 1 || batch.BatchId < 1 ||
		batch.SourceAccountId == nil || *batch.SourceAccountId < 1 ||
		batch.Status != IMPORT_BATCH_STATUS_READY || !isValidSourceType(batch.SourceTypeSnapshot) ||
		!isTechnicalIdentifier(batch.ParserName, 64) ||
		!isTechnicalIdentifier(string(batch.ParserVersion), 32) ||
		!isTechnicalIdentifier(string(batch.NormalizationVersion), 32) ||
		!isTechnicalIdentifier(batch.ReparseReasonCode, 64) ||
		!isLowerHexSHA256(persistence.ExpectedSourceAccountKey) ||
		!isLowerHexSHA256(batch.ParseOptionsDigest) ||
		batch.CreatedUnixTime < 1 || batch.StartedUnixTime == nil || batch.CompletedUnixTime == nil ||
		*batch.StartedUnixTime < batch.CreatedUnixTime || *batch.CompletedUnixTime < *batch.StartedUnixTime ||
		batch.UpdatedUnixTime < *batch.CompletedUnixTime || batch.ErrorCode != "" || batch.ErrorSummary != "" ||
		batch.TotalRowCount != 0 || batch.ValidRowCount != 0 || batch.InvalidRowCount != 0 ||
		batch.ExactDuplicateRowCount != 0 || batch.IdentityConflictRowCount != 0 ||
		batch.PendingRowCount != 0 || batch.PostedRowCount != 0 ||
		(batch.LedgerAccountId != nil && *batch.LedgerAccountId < 1) {
		return fmt.Errorf("invalid personal finance evidence batch persistence")
	}

	versions := CurrentCentralRuleVersions()

	if batch.IdentityKeyVersion != versions.IdentityKeyVersion ||
		batch.CoreDigestVersion != versions.CoreDigestVersion ||
		batch.FingerprintVersion != versions.FingerprintVersion ||
		batch.RawSnapshotVersion != versions.RawSnapshotVersion {
		return fmt.Errorf("invalid personal finance evidence batch versions")
	}

	if batch.StatementStartUnixTime != nil && batch.StatementEndUnixTime != nil &&
		*batch.StatementEndUnixTime < *batch.StatementStartUnixTime {
		return fmt.Errorf("invalid personal finance evidence statement period")
	}

	if offset := batch.StatementTimezoneUtcOffset; offset != nil &&
		(*offset < minimumTimezoneUtcOffset || *offset > maximumTimezoneUtcOffset) {
		return fmt.Errorf("invalid personal finance evidence statement timezone")
	}

	for index, issue := range persistence.DocumentIssues {
		if issue == nil || issue.Uid != batch.Uid || issue.BatchId != batch.BatchId ||
			issue.IssueOrder != int64(index+1) || issue.IssueId < 1 ||
			issue.CreatedUnixTime != batch.CreatedUnixTime || !isValidIssueCode(issue.Code) ||
			!isValidIssueSeverity(issue.Severity) ||
			len(issue.Field) > 64 || !utf8.ValidString(issue.Field) ||
			validateIssueCodesForSource(batch.SourceTypeSnapshot, []EvidenceIssue{{Code: issue.Code, Field: issue.Field, Severity: issue.Severity}}) != nil {
			return fmt.Errorf("invalid personal finance import batch issue persistence")
		}
	}

	totalSnapshotBytes := 0

	for index := range persistence.Rows {
		entry := &persistence.Rows[index]
		snapshotBytes := persistentEvidenceSnapshotBytes(entry.Row)
		encodedLocator, locatorErr := EncodeSourceLocator(entry.Locator)

		if locatorErr != nil || entry.Row == nil || encodedLocator != entry.Row.SourceLocator ||
			entry.Row.Uid != batch.Uid || entry.Row.BatchId != batch.BatchId ||
			entry.Row.RowNumber != int64(index+1) || entry.Row.RowId < 1 || entry.Row.IdentityId != nil ||
			entry.Row.IdentityState != "" || entry.Row.ProcessingState != "" || entry.Row.Disposition != "" ||
			entry.Row.CreatedUnixTime != batch.CreatedUnixTime ||
			entry.Row.ParserVersion != batch.ParserVersion ||
			entry.Row.NormalizationVersion != batch.NormalizationVersion ||
			entry.Row.IdentityKeyVersion != batch.IdentityKeyVersion ||
			entry.Row.CoreDigestVersion != batch.CoreDigestVersion ||
			entry.Row.FingerprintVersion != batch.FingerprintVersion ||
			entry.Row.RawSnapshotVersion != batch.RawSnapshotVersion ||
			!isValidPersistentEvidenceSnapshots(batch.SourceTypeSnapshot, entry.Row) {
			return fmt.Errorf("invalid personal finance evidence row persistence")
		}

		if snapshotBytes > maximumEvidenceBatchSnapshotBytes-totalSnapshotBytes {
			return fmt.Errorf("personal finance evidence batch snapshot exceeds byte limit")
		}

		totalSnapshotBytes += snapshotBytes

		if entry.Row.ParseState == PARSE_STATE_INVALID {
			if entry.IdentityCandidate != nil || entry.CandidateIdentityId != 0 ||
				entry.FingerprintMaterials != (StrongFingerprintMaterials{}) ||
				entry.Row.SemanticEligibility != SEMANTIC_ELIGIBILITY_NON_POSTABLE ||
				entry.Row.ObservedSourceIdentityKey != "" || entry.Row.ObservedSourceCoreDigest != "" ||
				entry.Row.NormalizedUnixTime != nil || entry.Row.NormalizedTimezoneUtcOffset != nil ||
				entry.Row.NormalizedAmount != nil || entry.Row.Currency != "" ||
				entry.Row.NormalizedDirection != "" || entry.Row.NormalizedTransactionType != "" ||
				entry.Row.EconomicEffect != "" || entry.Row.LedgerAccountId != nil {
				return fmt.Errorf("invalid row cannot have a personal finance source identity")
			}

			continue
		}

		candidate := entry.IdentityCandidate

		if entry.Row.ParseState != PARSE_STATE_VALID || candidate == nil || entry.CandidateIdentityId < 1 ||
			!isValidIdentityKind(candidate.Kind) || entry.Row.NormalizedUnixTime == nil ||
			entry.Row.NormalizedTimezoneUtcOffset == nil || entry.Row.NormalizedAmount == nil ||
			!isLowerHexSHA256(candidate.SourceIdentityKey) || !isLowerHexSHA256(candidate.SourceCoreDigest) ||
			candidate.IdentityKeyVersion != versions.IdentityKeyVersion ||
			candidate.CoreDigestVersion != versions.CoreDigestVersion ||
			candidate.FingerprintVersion != versions.FingerprintVersion ||
			entry.Row.ObservedSourceIdentityKey != candidate.SourceIdentityKey ||
			entry.Row.ObservedSourceCoreDigest != candidate.SourceCoreDigest {
			return fmt.Errorf("invalid personal finance source identity candidate")
		}

		normalized := NormalizedEvidence{
			UnixTime:          entry.Row.NormalizedUnixTime,
			TimezoneUtcOffset: *entry.Row.NormalizedTimezoneUtcOffset,
			Amount:            entry.Row.NormalizedAmount,
			Currency:          entry.Row.Currency,
			Direction:         entry.Row.NormalizedDirection,
			TransactionType:   entry.Row.NormalizedTransactionType,
			EconomicEffect:    entry.Row.EconomicEffect,
		}

		rebuiltCandidate, err := BuildIdentityCandidate(IdentityBuildInput{
			ParseState:       entry.Row.ParseState,
			SourceType:       batch.SourceTypeSnapshot,
			SourceAccountKey: persistence.ExpectedSourceAccountKey,
			BatchId:          batch.BatchId,
			RowNumber:        entry.Row.RowNumber,
			Identifiers: SourceIdentifiers{
				TransactionId:   entry.Row.SourceTransactionId,
				OrderId:         entry.Row.SourceOrderId,
				MerchantOrderId: entry.Row.SourceMerchantOrderId,
			},
			Normalized:           normalized,
			FingerprintMaterials: entry.FingerprintMaterials,
		})

		if err != nil || rebuiltCandidate == nil || *rebuiltCandidate != *candidate {
			return fmt.Errorf("personal finance source identity candidate does not match evidence")
		}

		switch entry.Row.SemanticEligibility {
		case SEMANTIC_ELIGIBILITY_POSTABLE, SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED, SEMANTIC_ELIGIBILITY_NON_POSTABLE:
		default:
			return fmt.Errorf("invalid personal finance evidence row eligibility")
		}
	}

	return nil
}

func isValidIdentityKind(kind IdentityKind) bool {
	switch kind {
	case IDENTITY_KIND_SOURCE_TRANSACTION_ID,
		IDENTITY_KIND_ORDER_COMBINATION,
		IDENTITY_KIND_STRONG_FINGERPRINT,
		IDENTITY_KIND_BATCH_LOCAL:
		return true
	default:
		return false
	}
}

func isValidPersistentEvidenceSnapshots(sourceType SourceType, row *RawImportRow) bool {
	if row == nil || !utf8.ValidString(row.SourceLocator) ||
		len(row.SourceLocator) < 1 || len(row.SourceLocator) > maximumPersistentSourceLocatorBytes ||
		len(row.RawFieldsJson) > MaxRawFieldsJSONBytes || len(row.IssuesJson) > MaxIssuesJSONBytes ||
		!json.Valid([]byte(row.RawFieldsJson)) || !json.Valid([]byte(row.IssuesJson)) {
		return false
	}

	raw := CanonicalRawEvidence{
		TransactionTime: row.RawTransactionTime,
		Amount:          row.RawAmount,
		Direction:       row.RawDirection,
		Status:          row.RawStatus,
		TransactionType: row.RawTransactionType,
		Counterparty:    row.RawCounterparty,
		Item:            row.RawItem,
		PaymentMethod:   row.RawPaymentMethod,
		Note:            row.RawNote,
	}

	if validateCanonicalRawEvidence(raw) != nil {
		return false
	}

	for _, identifier := range []string{row.SourceTransactionId, row.SourceOrderId, row.SourceMerchantOrderId} {
		if !utf8.ValidString(identifier) || utf8.RuneCountInString(identifier) > 255 {
			return false
		}
	}

	var rawFields []RawField

	if err := json.Unmarshal([]byte(row.RawFieldsJson), &rawFields); err != nil {
		return false
	}

	canonicalRawFields, err := MarshalRawFields(rawFields)

	if err != nil || canonicalRawFields != row.RawFieldsJson {
		return false
	}

	var issues []EvidenceIssue

	if err := json.Unmarshal([]byte(row.IssuesJson), &issues); err != nil ||
		validateIssueCodesForSource(sourceType, issues) != nil {
		return false
	}

	hasErrorIssue := false

	for _, issue := range issues {
		if issue.Severity == ISSUE_SEVERITY_ERROR {
			hasErrorIssue = true
			break
		}
	}

	if (row.ParseState == PARSE_STATE_INVALID) != hasErrorIssue {
		return false
	}

	canonicalIssues, err := MarshalEvidenceIssues(issues)
	return err == nil && canonicalIssues == row.IssuesJson && SelectPrimaryIssue(issues) == row.PrimaryIssueCode
}

func cloneEvidenceBatchPersistence(source *EvidenceBatchPersistence) *EvidenceBatchPersistence {
	batch := *source.Batch
	batch.SourceAccountId = cloneInt64Pointer(source.Batch.SourceAccountId)
	batch.LedgerAccountId = cloneInt64Pointer(source.Batch.LedgerAccountId)
	batch.StatementStartUnixTime = cloneInt64Pointer(source.Batch.StatementStartUnixTime)
	batch.StatementEndUnixTime = cloneInt64Pointer(source.Batch.StatementEndUnixTime)
	batch.StatementTimezoneUtcOffset = cloneInt16Pointer(source.Batch.StatementTimezoneUtcOffset)
	batch.StartedUnixTime = cloneInt64Pointer(source.Batch.StartedUnixTime)
	batch.CompletedUnixTime = cloneInt64Pointer(source.Batch.CompletedUnixTime)
	rows := make([]EvidenceBatchPersistenceRow, len(source.Rows))
	documentIssues := make([]*ImportBatchIssue, len(source.DocumentIssues))

	for index := range source.DocumentIssues {
		issue := *source.DocumentIssues[index]
		documentIssues[index] = &issue
	}

	for index := range source.Rows {
		rows[index] = source.Rows[index]
		row := *source.Rows[index].Row
		row.IdentityId = cloneInt64Pointer(source.Rows[index].Row.IdentityId)
		row.NormalizedUnixTime = cloneInt64Pointer(source.Rows[index].Row.NormalizedUnixTime)
		row.NormalizedTimezoneUtcOffset = cloneInt16Pointer(source.Rows[index].Row.NormalizedTimezoneUtcOffset)
		row.NormalizedAmount = cloneInt64Pointer(source.Rows[index].Row.NormalizedAmount)
		row.LedgerAccountId = cloneInt64Pointer(source.Rows[index].Row.LedgerAccountId)
		rows[index].Row = &row
	}

	return &EvidenceBatchPersistence{
		Batch:                    &batch,
		ExpectedSourceAccountKey: source.ExpectedSourceAccountKey,
		DocumentIssues:           documentIssues,
		Rows:                     rows,
	}
}

func evidenceIdentityResolutionOrder(rows []EvidenceBatchPersistenceRow) []int {
	order := make([]int, 0, len(rows))

	for index := range rows {
		if rows[index].IdentityCandidate != nil {
			order = append(order, index)
		}
	}

	sort.SliceStable(order, func(left int, right int) bool {
		leftKey := rows[order[left]].IdentityCandidate.SourceIdentityKey
		rightKey := rows[order[right]].IdentityCandidate.SourceIdentityKey

		if leftKey == rightKey {
			return rows[order[left]].Row.RowNumber < rows[order[right]].Row.RowNumber
		}

		return leftKey < rightKey
	})

	return order
}

func resetImportBatchCounts(batch *ImportBatch) {
	batch.TotalRowCount = 0
	batch.ValidRowCount = 0
	batch.InvalidRowCount = 0
	batch.ExactDuplicateRowCount = 0
	batch.IdentityConflictRowCount = 0
	batch.PendingRowCount = 0
	batch.PostedRowCount = 0
}

func accumulateImportBatchCounts(batch *ImportBatch, row *RawImportRow) {
	batch.TotalRowCount++

	if row.ParseState == PARSE_STATE_VALID {
		batch.ValidRowCount++
	} else {
		batch.InvalidRowCount++
	}

	if row.IdentityState == IDENTITY_STATE_EXACT_DUPLICATE {
		batch.ExactDuplicateRowCount++
	}

	if row.IdentityState == IDENTITY_STATE_IDENTITY_CONFLICT {
		batch.IdentityConflictRowCount++
	}

	if row.ProcessingState == PROCESSING_STATE_PENDING {
		batch.PendingRowCount++
	}

	if row.ProcessingState == PROCESSING_STATE_LINKED {
		batch.PostedRowCount++
	}
}
