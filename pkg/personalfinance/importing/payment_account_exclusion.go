package importing

import (
	"fmt"
	"unicode/utf8"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

// PaymentAccountExclusion 记住某个付款方式整组不要入账。它不创建正式账户，也不改变来源身份。
type PaymentAccountExclusion struct {
	Uid               int64       `xorm:"BIGINT UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
	SourceType        SourceType  `xorm:"VARCHAR(32) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	Currency          string      `xorm:"VARCHAR(3) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	AliasKey          string      `xorm:"CHAR(64) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	AliasKeyVersion   RuleVersion `xorm:"VARCHAR(32) NOT NULL"`
	MaskedDisplayName string      `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64       `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64       `xorm:"BIGINT INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
	ExclusionId       int64       `xorm:"BIGINT PK INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
}

func (PaymentAccountExclusion) TableName() string {
	return "pf_payment_account_exclusion"
}

func (s *PaymentAccountService) ApplyPersistedExclusions(c core.Context, uid int64, batchId int64) error {
	if uid < 1 || batchId < 1 {
		return ErrPaymentAccountRequestInvalid
	}
	unlock := lockBatchMutation(uid, batchId)
	defer unlock()
	batch, rows, _, exclusions, err := s.loadBatchPaymentAccounts(c, uid, batchId)
	if err != nil {
		return err
	}
	rowIds := matchingPendingRowIds(batch, rows, exclusions, 0, nil)
	if len(rowIds) == 0 {
		return nil
	}
	return s.repository.UpdatePaymentAccountRowProcessing(c, uid, batchId, rowIds, PROCESSING_STATE_PENDING, PROCESSING_STATE_IGNORED)
}

func (s *PaymentAccountService) ExcludePaymentAccount(c core.Context, request PaymentAccountSkipRequest) (*PaymentAccountGroup, error) {
	return s.mutatePaymentAccountGroup(c, request, true)
}

func (s *PaymentAccountService) RestorePaymentAccount(c core.Context, request PaymentAccountSkipRequest) (*PaymentAccountGroup, error) {
	return s.mutatePaymentAccountGroup(c, request, false)
}

func (s *PaymentAccountService) SkipPaymentAccountRows(c core.Context, request PaymentAccountSkipRequest) (*PaymentAccountGroup, error) {
	return s.setPaymentAccountRowsState(c, request, PROCESSING_STATE_PENDING, PROCESSING_STATE_IGNORED)
}

func (s *PaymentAccountService) RestorePaymentAccountRows(c core.Context, request PaymentAccountSkipRequest) (*PaymentAccountGroup, error) {
	return s.setPaymentAccountRowsState(c, request, PROCESSING_STATE_IGNORED, PROCESSING_STATE_PENDING)
}

func (s *PaymentAccountService) ListPaymentAccountGroupRows(c core.Context, uid int64, batchId int64, sampleRowId int64) ([]*PaymentAccountRowView, error) {
	if uid < 1 || batchId < 1 || sampleRowId < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}
	batch, rows, _, exclusions, err := s.loadBatchPaymentAccounts(c, uid, batchId)
	if err != nil {
		return nil, err
	}
	sample, alias, err := findPaymentAccountSample(batch, rows, sampleRowId)
	if err != nil {
		return nil, err
	}
	excluded := paymentAccountExclusionByKey(batch.Uid, batch.SourceTypeSnapshot, exclusions, sample.Currency, alias.Key) != nil
	views := make([]*PaymentAccountRowView, 0)
	for _, row := range rows {
		if row == nil || !samePaymentAccountAlias(row, sample, alias.Key) {
			continue
		}
		skipped := isUserSkippedPaymentAccountRow(row)
		if row.ProcessingState != PROCESSING_STATE_PENDING && !skipped {
			continue
		}
		label := safePaymentAccountDisplayName(row.RawCounterparty)
		if label == "" {
			label = safePaymentAccountDisplayName(row.RawItem)
		}
		views = append(views, &PaymentAccountRowView{
			RowId: row.RowId, BatchId: row.BatchId, UnixTime: cloneInt64Pointer(row.NormalizedUnixTime), Amount: cloneInt64Pointer(row.NormalizedAmount),
			Currency: row.Currency, Direction: row.NormalizedDirection, Label: label, Skipped: skipped || excluded,
		})
	}
	return views, nil
}

func (s *PaymentAccountService) mutatePaymentAccountGroup(c core.Context, request PaymentAccountSkipRequest, exclude bool) (*PaymentAccountGroup, error) {
	if request.Uid < 1 || request.BatchId < 1 || request.RowId < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}
	unlock := lockBatchMutation(request.Uid, request.BatchId)
	defer unlock()
	batch, rows, mappings, exclusions, err := s.loadBatchPaymentAccounts(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}
	sample, alias, err := findPaymentAccountSample(batch, rows, request.RowId)
	if err != nil {
		return nil, err
	}
	if exclude {
		now := s.now().Unix()
		exclusionId := s.generateId()
		if now < 1 || exclusionId < 1 {
			return nil, ErrPaymentAccountRequestInvalid
		}
		if _, err := s.repository.SavePaymentAccountExclusion(c, &PaymentAccountExclusion{
			Uid: request.Uid, SourceType: batch.SourceTypeSnapshot, Currency: sample.Currency,
			AliasKey: alias.Key, AliasKeyVersion: alias.Version, MaskedDisplayName: qualifyPaymentAccountDisplayName(batch.SourceTypeSnapshot, alias.DisplayName),
			CreatedUnixTime: now, UpdatedUnixTime: now, ExclusionId: exclusionId,
		}); err != nil {
			return nil, ErrPaymentAccountExclusionUnavailable
		}
		rowIds := matchingPendingRowIds(batch, rows, nil, sample.RowId, &alias)
		if len(rowIds) > 0 {
			if err := s.repository.UpdatePaymentAccountRowProcessing(c, request.Uid, request.BatchId, rowIds, PROCESSING_STATE_PENDING, PROCESSING_STATE_IGNORED); err != nil {
				return nil, ErrPaymentAccountPersistenceUnavailable
			}
		}
	} else {
		if err := s.repository.DeletePaymentAccountExclusion(c, request.Uid, batch.SourceTypeSnapshot, sample.Currency, alias.Key); err != nil {
			return nil, ErrPaymentAccountExclusionUnavailable
		}
		rowIds := matchingUserSkippedRowIds(batch, rows, sample, alias.Key)
		if len(rowIds) > 0 {
			if err := s.repository.UpdatePaymentAccountRowProcessing(c, request.Uid, request.BatchId, rowIds, PROCESSING_STATE_IGNORED, PROCESSING_STATE_PENDING); err != nil {
				return nil, ErrPaymentAccountPersistenceUnavailable
			}
		}
	}
	batch, rows, mappings, exclusions, err = s.loadBatchPaymentAccounts(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}
	return findPaymentAccountGroup(buildPaymentAccountGroups(batch, rows, mappings, exclusions), request.RowId, alias.DisplayName), nil
}

func (s *PaymentAccountService) setPaymentAccountRowsState(c core.Context, request PaymentAccountSkipRequest, from ProcessingState, to ProcessingState) (*PaymentAccountGroup, error) {
	if request.Uid < 1 || request.BatchId < 1 || request.RowId < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}
	rowIds := normalizePaymentAccountRowIds(request.RowIds)
	if len(rowIds) < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}
	unlock := lockBatchMutation(request.Uid, request.BatchId)
	defer unlock()
	batch, rows, mappings, exclusions, err := s.loadBatchPaymentAccounts(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}
	sample, alias, err := findPaymentAccountSample(batch, rows, request.RowId)
	if err != nil {
		return nil, err
	}
	allowed := make(map[int64]struct{})
	for _, row := range rows {
		if row != nil && samePaymentAccountAlias(row, sample, alias.Key) && row.ProcessingState == from && (from == PROCESSING_STATE_PENDING || isUserSkippedPaymentAccountRow(row)) {
			allowed[row.RowId] = struct{}{}
		}
	}
	filtered := make([]int64, 0, len(rowIds))
	for _, rowId := range rowIds {
		if _, ok := allowed[rowId]; ok {
			filtered = append(filtered, rowId)
		}
	}
	if len(filtered) < 1 {
		return nil, ErrPaymentAccountRowNotFound
	}
	if err := s.repository.UpdatePaymentAccountRowProcessing(c, request.Uid, request.BatchId, filtered, from, to); err != nil {
		return nil, ErrPaymentAccountPersistenceUnavailable
	}
	batch, rows, mappings, exclusions, err = s.loadBatchPaymentAccounts(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}
	return findPaymentAccountGroup(buildPaymentAccountGroups(batch, rows, mappings, exclusions), request.RowId, alias.DisplayName), nil
}

func (r *Repository) ListPaymentAccountExclusions(c core.Context, uid int64, sourceType SourceType) ([]*PaymentAccountExclusion, error) {
	if uid < 1 || !isPaymentAccountSourceType(sourceType) {
		return nil, fmt.Errorf("invalid payment account exclusion owner or source")
	}
	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*PaymentAccountExclusion, 0)
	err := sess.Where("uid=? AND source_type=?", uid, sourceType).Asc("created_unix_time", "exclusion_id").Find(&items)
	if err != nil {
		return nil, fmt.Errorf("list personal finance payment account exclusions: %w", err)
	}
	return items, nil
}

func (r *Repository) SavePaymentAccountExclusion(c core.Context, candidate *PaymentAccountExclusion) (*PaymentAccountExclusion, error) {
	if !isValidPaymentAccountExclusion(candidate) {
		return nil, fmt.Errorf("invalid payment account exclusion")
	}
	var persisted *PaymentAccountExclusion
	err := r.DoTransaction(c, candidate.Uid, func(tx *RepositoryTransaction) error {
		statement := `INSERT INTO pf_payment_account_exclusion (
		uid, source_type, currency, alias_key, alias_key_version, masked_display_name,
		created_unix_time, updated_unix_time, exclusion_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		switch tx.database.DatabaseType() {
		case settings.Sqlite3DbType, settings.PostgresDbType:
			statement += " ON CONFLICT (uid, source_type, currency, alias_key) DO NOTHING"
		case settings.MySqlDbType:
		default:
			return fmt.Errorf("unsupported payment account exclusion database type")
		}
		result, execErr := tx.session.Exec(statement,
			candidate.Uid, candidate.SourceType, candidate.Currency, candidate.AliasKey, candidate.AliasKeyVersion,
			candidate.MaskedDisplayName, candidate.CreatedUnixTime, candidate.UpdatedUnixTime, candidate.ExclusionId,
		)
		if execErr != nil && (tx.database.DatabaseType() != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
			return fmt.Errorf("insert payment account exclusion: %w", execErr)
		}
		if execErr == nil {
			if _, err := result.RowsAffected(); err != nil {
				return fmt.Errorf("read payment account exclusion insert result")
			}
		}
		persisted = new(PaymentAccountExclusion)
		query := tx.session.Where(
			"uid=? AND source_type=? AND currency=? AND alias_key=?",
			candidate.Uid, candidate.SourceType, candidate.Currency, candidate.AliasKey,
		)
		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			query = query.ForUpdate()
		}
		found, err := query.Get(persisted)
		if err != nil {
			return fmt.Errorf("find payment account exclusion after insert: %w", err)
		}
		if !found || persisted.ExclusionId < 1 {
			return fmt.Errorf("payment account exclusion is missing or incompatible")
		}
		if persisted.MaskedDisplayName != candidate.MaskedDisplayName {
			if _, err := tx.session.Where("uid=? AND exclusion_id=?", persisted.Uid, persisted.ExclusionId).
				Cols("masked_display_name", "updated_unix_time").Update(&PaymentAccountExclusion{
				MaskedDisplayName: candidate.MaskedDisplayName, UpdatedUnixTime: candidate.UpdatedUnixTime,
			}); err != nil {
				return fmt.Errorf("update payment account exclusion")
			}
			persisted.MaskedDisplayName = candidate.MaskedDisplayName
			persisted.UpdatedUnixTime = candidate.UpdatedUnixTime
		}
		if candidate.SourceType == SOURCE_TYPE_ALIPAY {
			balanceAlias, ok := BuildPaymentAccountAlias("余额")
			if ok && candidate.AliasKey == balanceAlias.Key {
				if _, err := tx.session.Where(
					"uid=? AND source_type=? AND currency=? AND alias_key=?",
					candidate.Uid, candidate.SourceType, candidate.Currency, legacyAlipayAccountBalanceAliasKey(),
				).Delete(new(PaymentAccountExclusion)); err != nil {
					return fmt.Errorf("remove legacy alipay account balance exclusion: %w", err)
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return persisted, nil
}

func (r *Repository) DeletePaymentAccountExclusion(c core.Context, uid int64, sourceType SourceType, currency string, aliasKey string) error {
	if uid < 1 || !isPaymentAccountSourceType(sourceType) || !isValidPaymentAccountCurrency(currency) || !isLowerHexSHA256(aliasKey) {
		return fmt.Errorf("invalid payment account exclusion delete")
	}
	return r.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		if _, err := tx.session.Where("uid=? AND source_type=? AND currency=? AND alias_key=?", uid, sourceType, currency, aliasKey).
			Delete(new(PaymentAccountExclusion)); err != nil {
			return fmt.Errorf("delete payment account exclusion: %w", err)
		}
		if sourceType == SOURCE_TYPE_ALIPAY {
			balanceAlias, ok := BuildPaymentAccountAlias("余额")
			if ok && aliasKey == balanceAlias.Key {
				if _, err := tx.session.Where("uid=? AND source_type=? AND currency=? AND alias_key=?", uid, sourceType, currency, legacyAlipayAccountBalanceAliasKey()).
					Delete(new(PaymentAccountExclusion)); err != nil {
					return fmt.Errorf("delete legacy alipay account balance exclusion: %w", err)
				}
			}
		}
		return nil
	})
}

func (r *Repository) UpdatePaymentAccountRowProcessing(c core.Context, uid int64, batchId int64, rowIds []int64, from ProcessingState, to ProcessingState) error {
	uniqueRowIds := normalizePaymentAccountRowIds(rowIds)
	if uid < 1 || batchId < 1 || len(uniqueRowIds) < 1 || (from != PROCESSING_STATE_PENDING && from != PROCESSING_STATE_IGNORED) ||
		(to != PROCESSING_STATE_PENDING && to != PROCESSING_STATE_IGNORED) || from == to {
		return fmt.Errorf("invalid payment account row processing update")
	}
	return r.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		for start := 0; start < len(uniqueRowIds); start += paymentAccountUpdateChunkSize {
			end := start + paymentAccountUpdateChunkSize
			if end > len(uniqueRowIds) {
				end = len(uniqueRowIds)
			}
			updated, err := tx.session.Where("uid=? AND batch_id=? AND processing_state=?", uid, batchId, from).
				In("row_id", uniqueRowIds[start:end]).Cols("processing_state").Update(&RawImportRow{ProcessingState: to})
			if err != nil {
				return fmt.Errorf("update payment account row processing: %w", err)
			}
			if updated < 1 {
				return fmt.Errorf("payment account row processing was not updated")
			}
		}
		return nil
	})
}

func findPaymentAccountSample(batch *ImportBatch, rows []*RawImportRow, sampleRowId int64) (*RawImportRow, PaymentAccountAlias, error) {
	if batch == nil {
		return nil, PaymentAccountAlias{}, ErrPaymentAccountBatchNotFound
	}
	for _, row := range rows {
		if row == nil || row.RowId != sampleRowId {
			continue
		}
		if row.ParseState != PARSE_STATE_VALID {
			return nil, PaymentAccountAlias{}, ErrPaymentAccountRowNotFound
		}
		alias, ok := BuildPaymentAccountAlias(row.RawPaymentMethod)
		if !ok {
			return nil, PaymentAccountAlias{}, ErrPaymentAccountAliasUnavailable
		}
		return row, alias, nil
	}
	return nil, PaymentAccountAlias{}, ErrPaymentAccountRowNotFound
}

func matchingPendingRowIds(batch *ImportBatch, rows []*RawImportRow, exclusions []*PaymentAccountExclusion, sampleRowId int64, alias *PaymentAccountAlias) []int64 {
	rowIds := make([]int64, 0)
	var sampleCurrency string
	if sampleRowId > 0 {
		for _, row := range rows {
			if row != nil && row.RowId == sampleRowId {
				sampleCurrency = row.Currency
				break
			}
		}
	}
	for _, row := range rows {
		if row == nil || row.ParseState != PARSE_STATE_VALID || row.ProcessingState != PROCESSING_STATE_PENDING {
			continue
		}
		rowAlias, ok := BuildPaymentAccountAlias(row.RawPaymentMethod)
		if !ok {
			continue
		}
		if alias != nil {
			if (sampleCurrency != "" && row.Currency != sampleCurrency) || rowAlias.Key != alias.Key {
				continue
			}
		} else if paymentAccountExclusionByKey(batch.Uid, batch.SourceTypeSnapshot, exclusions, row.Currency, rowAlias.Key) == nil {
			continue
		}
		rowIds = append(rowIds, row.RowId)
	}
	_ = batch
	return rowIds
}

func matchingUserSkippedRowIds(batch *ImportBatch, rows []*RawImportRow, sample *RawImportRow, aliasKey string) []int64 {
	rowIds := make([]int64, 0)
	for _, row := range rows {
		if row != nil && samePaymentAccountAlias(row, sample, aliasKey) && isUserSkippedPaymentAccountRow(row) {
			rowIds = append(rowIds, row.RowId)
		}
	}
	_ = batch
	return rowIds
}

func samePaymentAccountAlias(row *RawImportRow, sample *RawImportRow, aliasKey string) bool {
	if row == nil || sample == nil || row.ParseState != PARSE_STATE_VALID || row.Currency != sample.Currency {
		return false
	}
	alias, ok := BuildPaymentAccountAlias(row.RawPaymentMethod)
	return ok && alias.Key == aliasKey
}

func isUserSkippedPaymentAccountRow(row *RawImportRow) bool {
	return row != nil && row.ProcessingState == PROCESSING_STATE_IGNORED &&
		(row.Disposition == IMPORT_DISPOSITION_POSTABLE || row.Disposition == IMPORT_DISPOSITION_REVIEW_REQUIRED)
}

func paymentAccountExclusionByKey(uid int64, sourceType SourceType, exclusions []*PaymentAccountExclusion, currency string, aliasKey string) *PaymentAccountExclusion {
	for _, exclusion := range exclusions {
		if exclusion != nil && exclusion.Uid == uid && exclusion.SourceType == sourceType && exclusion.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 &&
			exclusion.Currency == currency && exclusion.AliasKey == aliasKey {
			return exclusion
		}
	}
	if sourceType != SOURCE_TYPE_ALIPAY {
		return nil
	}
	balanceAlias, ok := BuildPaymentAccountAlias("余额")
	if !ok || aliasKey != balanceAlias.Key {
		return nil
	}
	legacyKey := legacyAlipayAccountBalanceAliasKey()
	for _, exclusion := range exclusions {
		if exclusion != nil && exclusion.Uid == uid && exclusion.SourceType == sourceType && exclusion.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 &&
			exclusion.Currency == currency && exclusion.AliasKey == legacyKey {
			return exclusion
		}
	}
	return nil
}

func findPaymentAccountGroup(groups []*PaymentAccountGroup, sampleRowId int64, displayName string) *PaymentAccountGroup {
	for _, group := range groups {
		if group != nil && (group.SampleRowId == sampleRowId || group.DisplayName == displayName) {
			return group
		}
	}
	if len(groups) == 1 {
		return groups[0]
	}
	return nil
}

func isValidPaymentAccountExclusion(exclusion *PaymentAccountExclusion) bool {
	return exclusion != nil && exclusion.Uid > 0 &&
		isPaymentAccountSourceType(exclusion.SourceType) &&
		isValidPaymentAccountCurrency(exclusion.Currency) && isLowerHexSHA256(exclusion.AliasKey) &&
		exclusion.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 &&
		exclusion.MaskedDisplayName != "" && utf8.RuneCountInString(exclusion.MaskedDisplayName) <= maximumPaymentAccountDisplayRunes &&
		exclusion.CreatedUnixTime > 0 && exclusion.UpdatedUnixTime >= exclusion.CreatedUnixTime && exclusion.ExclusionId > 0
}
