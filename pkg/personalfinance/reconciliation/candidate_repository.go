package reconciliation

import (
	"errors"
	"fmt"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/lib/pq"
	"github.com/mattn/go-sqlite3"
	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const (
	maximumCandidatePersistenceAttempts   = 8
	initialCandidatePersistenceRetryDelay = 5 * time.Millisecond
	maximumCaseRefreshAttempts            = 8
)

type candidateRepository struct {
	store *datastore.DataStore
}

func newCandidateRepository(store *datastore.DataStore) (*candidateRepository, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("reconciliation candidate repository requires a user data store")
	}

	return &candidateRepository{store: store}, nil
}

func (r *candidateRepository) database(uid int64) (*datastore.Database, error) {
	if r == nil || r.store == nil || uid < 1 {
		return nil, fmt.Errorf("reconciliation candidate repository requires a positive uid")
	}

	return r.store.Choose(uid), nil
}

func (r *candidateRepository) findAnchorBatch(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid reconciliation anchor batch")
	}

	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	batch := new(importing.ImportBatch)
	found, err := sess.Where("uid=? AND batch_id=?", uid, batchId).Get(batch)

	if err != nil {
		return nil, fmt.Errorf("find reconciliation anchor batch: %w", err)
	}

	if !found {
		return nil, nil
	}

	return batch, nil
}

func (r *candidateRepository) listEligibleAnchorRows(c core.Context, uid int64, batchId int64, offset int, limit int) ([]*importing.RawImportRow, error) {
	if uid < 1 || batchId < 1 || offset < 0 || limit != candidateAnchorPageSize {
		return nil, fmt.Errorf("invalid reconciliation anchor page")
	}

	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	rows := make([]*importing.RawImportRow, 0)
	err := candidateEligibleRowsQuery(sess, "uid=? AND batch_id=?", uid, batchId).
		Asc("row_number", "row_id").
		Limit(limit, offset).
		Find(&rows)

	if err != nil {
		return nil, fmt.Errorf("list reconciliation anchor rows: %w", err)
	}

	return rows, nil
}

func (r *candidateRepository) listHardFilteredCandidates(c core.Context, uid int64, anchorSourceAccountId int64, anchor *importing.RawImportRow, limit int) ([]*importing.RawImportRow, error) {
	if uid < 1 || anchorSourceAccountId < 1 || !isCandidateAnchorRow(anchor) || anchor.Uid != uid || limit != candidateSearchLimitPerSide {
		return nil, fmt.Errorf("invalid reconciliation hard candidate query")
	}

	windowStart, windowEnd := candidateWindow(*anchor.NormalizedUnixTime)
	database, _ := r.database(uid)
	rows := make([]*importing.RawImportRow, 0, limit*2)

	for _, beforeAnchor := range []bool{true, false} {
		sess := database.NewPrivacySession(c)
		part := make([]*importing.RawImportRow, 0, limit)
		query := sess.Table(new(importing.RawImportRow)).Alias("r").
			Join("INNER", "pf_import_batch", "pf_import_batch.uid=r.uid AND pf_import_batch.batch_id=r.batch_id").
			Select("r.*").
			Where("r.uid=? AND pf_import_batch.uid=?", uid, uid).
			And("pf_import_batch.source_account_id IS NOT NULL AND pf_import_batch.source_account_id<>?", anchorSourceAccountId).
			And("r.row_id<>?", anchor.RowId).
			And("r.parse_state=?", importing.PARSE_STATE_VALID).
			And("(r.processing_state=? OR (r.processing_state=? AND r.identity_id IS NOT NULL))", importing.PROCESSING_STATE_PENDING, importing.PROCESSING_STATE_LINKED).
			And("r.normalized_amount IS NOT NULL AND r.normalized_amount=?", *anchor.NormalizedAmount).
			And("r.currency=?", anchor.Currency).
			And("r.normalized_unix_time IS NOT NULL AND r.normalized_unix_time>=? AND r.normalized_unix_time<=?", windowStart, windowEnd).
			And("(r.processing_state=? OR (r.semantic_eligibility IN (?, ?) AND r.disposition IN (?, ?)))",
				importing.PROCESSING_STATE_LINKED,
				importing.SEMANTIC_ELIGIBILITY_POSTABLE, importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED,
				importing.IMPORT_DISPOSITION_POSTABLE, importing.IMPORT_DISPOSITION_REVIEW_REQUIRED).
			In("r.identity_state", importing.IDENTITY_STATE_NEW, importing.IDENTITY_STATE_EXACT_DUPLICATE, importing.IDENTITY_STATE_BATCH_LOCAL).
			Limit(limit)

		if beforeAnchor {
			query = query.And("r.normalized_unix_time<=?", *anchor.NormalizedUnixTime).
				Desc("r.normalized_unix_time").Asc("r.row_id")
		} else {
			query = query.And("r.normalized_unix_time>?", *anchor.NormalizedUnixTime).
				Asc("r.normalized_unix_time", "r.row_id")
		}

		err := query.Find(&part)
		sess.Close()

		if err != nil {
			return nil, fmt.Errorf("list reconciliation hard-filtered candidates: %w", err)
		}

		rows = append(rows, part...)
	}

	return rows, nil
}

func candidateEligibleRowsQuery(sess *xorm.Session, ownerCondition string, ownerArguments ...any) *xorm.Session {
	return sess.Where(ownerCondition, ownerArguments...).
		And("parse_state=? AND processing_state=?", importing.PARSE_STATE_VALID, importing.PROCESSING_STATE_PENDING).
		And("normalized_amount IS NOT NULL").
		And("normalized_unix_time IS NOT NULL").
		And("currency<>''").
		In("semantic_eligibility", importing.SEMANTIC_ELIGIBILITY_POSTABLE, importing.SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED).
		In("disposition", importing.IMPORT_DISPOSITION_POSTABLE, importing.IMPORT_DISPOSITION_REVIEW_REQUIRED).
		In("identity_state", importing.IDENTITY_STATE_NEW, importing.IDENTITY_STATE_EXACT_DUPLICATE, importing.IDENTITY_STATE_BATCH_LOCAL)
}

func candidateWindow(anchorUnixTime int64) (int64, int64) {
	start := anchorUnixTime - candidateTimeWindowSeconds
	end := anchorUnixTime + candidateTimeWindowSeconds

	if start > anchorUnixTime {
		start = -1 << 63
	}

	if end < anchorUnixTime {
		end = 1<<63 - 1
	}

	return start, end
}

func (r *candidateRepository) persistCandidates(c core.Context, uid int64, persistences []*candidatePersistence) ([]*Case, error) {
	if uid < 1 || len(persistences) > candidateMaximumCases {
		return nil, fmt.Errorf("invalid reconciliation candidate persistence")
	}

	if len(persistences) == 0 {
		return []*Case{}, nil
	}

	database, _ := r.database(uid)

	for attempt := 0; attempt < maximumCandidatePersistenceAttempts; attempt++ {
		persisted := make([]*Case, 0, len(persistences))
		err := database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
			for _, persistence := range persistences {
				caseRecord, persistErr := r.persistCandidate(sess, database.DatabaseType(), uid, persistence)

				if persistErr != nil {
					return persistErr
				}

				persisted = append(persisted, caseRecord)
			}

			return nil
		})

		if err == nil {
			return persisted, nil
		}

		if attempt+1 == maximumCandidatePersistenceAttempts || !isRetryableCandidatePersistenceError(database.DatabaseType(), err) {
			return nil, err
		}

		delay := initialCandidatePersistenceRetryDelay << attempt
		delay += time.Duration((uid+int64(attempt))%7) * time.Millisecond

		if err := waitCandidatePersistenceRetry(c, delay); err != nil {
			return nil, err
		}
	}

	return nil, fmt.Errorf("reconciliation candidate persistence retry limit reached")
}

func (r *candidateRepository) persistCandidate(sess *xorm.Session, databaseType string, uid int64, persistence *candidatePersistence) (*Case, error) {
	if err := validateCandidatePersistence(uid, persistence); err != nil {
		return nil, err
	}

	if err := validateCandidateMemberSources(sess, uid, persistence.members); err != nil {
		return nil, err
	}

	candidate := persistence.caseRecord
	insertSQL := `INSERT INTO pf_reconciliation_case (
		uid, case_key, case_key_version, status, version, member_count,
		suggested_relation_type, candidate_score, candidate_rule_version,
		explanation_version, reason_codes_json, current_decision_id,
		created_unix_time, last_evaluated_unix_time, updated_unix_time, case_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch databaseType {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		insertSQL += " ON CONFLICT (uid, case_key) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, fmt.Errorf("unsupported reconciliation candidate database type")
	}

	result, err := sess.Exec(
		insertSQL,
		candidate.Uid,
		candidate.CaseKey,
		candidate.CaseKeyVersion,
		candidate.Status,
		candidate.Version,
		candidate.MemberCount,
		candidate.SuggestedRelationType,
		candidate.CandidateScore,
		candidate.CandidateRuleVersion,
		candidate.ExplanationVersion,
		candidate.ReasonCodesJson,
		candidate.CurrentDecisionId,
		candidate.CreatedUnixTime,
		candidate.LastEvaluatedUnixTime,
		candidate.UpdatedUnixTime,
		candidate.CaseId,
	)
	inserted := false

	if err != nil {
		if databaseType != settings.MySqlDbType || !isMySQLCandidateDuplicateEntryError(err) {
			return nil, fmt.Errorf("insert reconciliation candidate case: %w", err)
		}
	} else {
		affected, affectedErr := result.RowsAffected()

		if affectedErr != nil || affected < 0 || affected > 1 {
			return nil, fmt.Errorf("read reconciliation candidate insert result")
		}

		inserted = affected == 1
	}

	if inserted {
		for _, member := range persistence.members {
			insertedMembers, insertErr := sess.Insert(member)

			if insertErr != nil {
				return nil, fmt.Errorf("insert reconciliation candidate member: %w", insertErr)
			}

			if insertedMembers != 1 {
				return nil, fmt.Errorf("reconciliation candidate member was not inserted")
			}
		}

		return cloneCandidateCase(candidate), nil
	}

	persisted := new(Case)
	found, err := sess.Where("uid=? AND case_key=?", uid, candidate.CaseKey).Get(persisted)

	if err != nil {
		return nil, fmt.Errorf("find existing reconciliation candidate case: %w", err)
	}

	if !found {
		return nil, fmt.Errorf("existing reconciliation candidate case is missing")
	}

	if err := validatePersistedCandidateMembers(sess, uid, persisted, persistence.members); err != nil {
		return nil, err
	}

	return refreshOpenCandidateCase(sess, uid, persisted, candidate)
}

func validateCandidateMemberSources(sess *xorm.Session, uid int64, members []*CaseMember) error {
	if sess == nil || uid < 1 || len(members) != 2 {
		return fmt.Errorf("invalid reconciliation candidate member sources")
	}

	sourceAccountIds := make([]int64, 2)

	for index, member := range members {
		switch member.MemberKind {
		case MEMBER_KIND_SOURCE_IDENTITY:
			identity := new(importing.SourceIdentity)
			found, err := sess.Where("uid=? AND identity_id=?", uid, member.MemberRefId).Get(identity)

			if err != nil {
				return fmt.Errorf("find reconciliation candidate source identity: %w", err)
			}

			if !found || identity.SourceAccountId < 1 || identity.IdentityKind == importing.IDENTITY_KIND_BATCH_LOCAL {
				return fmt.Errorf("reconciliation candidate source identity invariant mismatch")
			}

			sourceAccountIds[index] = identity.SourceAccountId
		case MEMBER_KIND_RAW_ROW:
			row := new(importing.RawImportRow)
			found, err := sess.Where("uid=? AND row_id=?", uid, member.MemberRefId).Get(row)

			if err != nil {
				return fmt.Errorf("find reconciliation candidate batch-local row: %w", err)
			}

			if !found || row.IdentityState != importing.IDENTITY_STATE_BATCH_LOCAL {
				return fmt.Errorf("reconciliation candidate batch-local row invariant mismatch")
			}

			batch := new(importing.ImportBatch)
			found, err = sess.Where("uid=? AND batch_id=?", uid, row.BatchId).Get(batch)

			if err != nil {
				return fmt.Errorf("find reconciliation candidate batch-local source: %w", err)
			}

			if !found || batch.SourceAccountId == nil || *batch.SourceAccountId < 1 {
				return fmt.Errorf("reconciliation candidate batch-local source invariant mismatch")
			}

			sourceAccountIds[index] = *batch.SourceAccountId
		default:
			return fmt.Errorf("invalid reconciliation candidate member kind")
		}
	}

	if sourceAccountIds[0] == sourceAccountIds[1] {
		return fmt.Errorf("reconciliation candidate members must use different source accounts")
	}

	return nil
}

func validateCandidatePersistence(uid int64, persistence *candidatePersistence) error {
	if persistence == nil || persistence.caseRecord == nil || len(persistence.members) != 2 {
		return fmt.Errorf("invalid reconciliation candidate persistence")
	}

	caseRecord := persistence.caseRecord

	if caseRecord.Uid != uid || caseRecord.CaseId < 1 || len(caseRecord.CaseKey) != 64 ||
		caseRecord.CaseKeyVersion != CASE_KEY_VERSION_V1 || caseRecord.Status != CASE_STATUS_OPEN ||
		caseRecord.Version != 1 || caseRecord.MemberCount != 2 || caseRecord.CurrentDecisionId != nil ||
		caseRecord.CandidateRuleVersion != CANDIDATE_RULE_VERSION_V3 ||
		caseRecord.ExplanationVersion != EXPLANATION_VERSION_V3 ||
		caseRecord.CreatedUnixTime < 1 || caseRecord.LastEvaluatedUnixTime != caseRecord.CreatedUnixTime ||
		caseRecord.UpdatedUnixTime != caseRecord.CreatedUnixTime {
		return fmt.Errorf("invalid reconciliation candidate case")
	}

	for index, member := range persistence.members {
		if member == nil || member.Uid != uid || member.CaseId != caseRecord.CaseId || member.MemberId < 1 ||
			member.MemberOrder != int64(index+1) || member.MemberRefId < 1 ||
			(member.MemberKind != MEMBER_KIND_SOURCE_IDENTITY && member.MemberKind != MEMBER_KIND_RAW_ROW) ||
			member.MemberRole != candidateMemberRoleEvidence || member.CreatedUnixTime != caseRecord.CreatedUnixTime {
			return fmt.Errorf("invalid reconciliation candidate member")
		}
	}

	if persistence.members[0].MemberKind == persistence.members[1].MemberKind &&
		persistence.members[0].MemberRefId == persistence.members[1].MemberRefId {
		return fmt.Errorf("reconciliation candidate members must be distinct")
	}

	return nil
}

func validatePersistedCandidateMembers(sess *xorm.Session, uid int64, persisted *Case, expected []*CaseMember) error {
	if persisted == nil || persisted.Uid != uid || persisted.CaseId < 1 || persisted.MemberCount != 2 || len(expected) != 2 {
		return fmt.Errorf("reconciliation candidate case invariant mismatch")
	}

	members := make([]*CaseMember, 0, 2)

	if err := sess.Where("uid=? AND case_id=?", uid, persisted.CaseId).Asc("member_order").Find(&members); err != nil {
		return fmt.Errorf("find existing reconciliation candidate members: %w", err)
	}

	if len(members) != 2 {
		return fmt.Errorf("reconciliation candidate member invariant mismatch")
	}

	for index, member := range members {
		if member.Uid != uid || member.CaseId != persisted.CaseId || member.MemberOrder != int64(index+1) ||
			member.MemberKind != expected[index].MemberKind || member.MemberRefId != expected[index].MemberRefId ||
			member.MemberRole != candidateMemberRoleEvidence {
			return fmt.Errorf("reconciliation candidate member invariant mismatch")
		}
	}

	return nil
}

func refreshOpenCandidateCase(sess *xorm.Session, uid int64, persisted *Case, candidate *Case) (*Case, error) {
	for attempt := 0; attempt < maximumCaseRefreshAttempts; attempt++ {
		if persisted.Status != CASE_STATUS_OPEN || persisted.CurrentDecisionId != nil {
			return persisted, nil
		}

		nextVersion := persisted.Version + 1
		updated, err := sess.Where(
			"uid=? AND case_id=? AND status=? AND current_decision_id IS NULL AND version=?",
			uid,
			persisted.CaseId,
			CASE_STATUS_OPEN,
			persisted.Version,
		).Cols(
			"version",
			"suggested_relation_type",
			"candidate_score",
			"candidate_rule_version",
			"explanation_version",
			"reason_codes_json",
			"last_evaluated_unix_time",
			"updated_unix_time",
		).Update(&Case{
			Version:               nextVersion,
			SuggestedRelationType: candidate.SuggestedRelationType,
			CandidateScore:        candidate.CandidateScore,
			CandidateRuleVersion:  candidate.CandidateRuleVersion,
			ExplanationVersion:    candidate.ExplanationVersion,
			ReasonCodesJson:       candidate.ReasonCodesJson,
			LastEvaluatedUnixTime: candidate.LastEvaluatedUnixTime,
			UpdatedUnixTime:       candidate.UpdatedUnixTime,
		})

		if err != nil {
			return nil, fmt.Errorf("refresh reconciliation candidate case: %w", err)
		}

		if updated == 1 {
			persisted.Version = nextVersion
			persisted.SuggestedRelationType = candidate.SuggestedRelationType
			persisted.CandidateScore = candidate.CandidateScore
			persisted.CandidateRuleVersion = candidate.CandidateRuleVersion
			persisted.ExplanationVersion = candidate.ExplanationVersion
			persisted.ReasonCodesJson = candidate.ReasonCodesJson
			persisted.LastEvaluatedUnixTime = candidate.LastEvaluatedUnixTime
			persisted.UpdatedUnixTime = candidate.UpdatedUnixTime
			return persisted, nil
		}

		latest := new(Case)
		found, findErr := sess.Where("uid=? AND case_id=?", uid, persisted.CaseId).Get(latest)

		if findErr != nil {
			return nil, fmt.Errorf("reload reconciliation candidate case: %w", findErr)
		}

		if !found {
			return nil, fmt.Errorf("reconciliation candidate case disappeared during refresh")
		}

		persisted = latest
	}

	return nil, fmt.Errorf("reconciliation candidate case refresh retry limit reached")
}

func cloneCandidateCase(value *Case) *Case {
	if value == nil {
		return nil
	}

	cloned := *value

	if value.CurrentDecisionId != nil {
		decisionId := *value.CurrentDecisionId
		cloned.CurrentDecisionId = &decisionId
	}

	return &cloned
}

func isMySQLCandidateDuplicateEntryError(err error) bool {
	var mysqlError *mysqlDriver.MySQLError

	return errors.As(err, &mysqlError) && mysqlError.Number == 1062
}

func isRetryableCandidatePersistenceError(databaseType string, err error) bool {
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

func waitCandidatePersistenceRetry(c core.Context, delay time.Duration) error {
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
