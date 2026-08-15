package importing

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const paymentAccountUpdateChunkSize = 500

func (r *Repository) ListPaymentAccountRows(c core.Context, uid int64, batchId int64) ([]*RawImportRow, error) {
	if uid < 1 || batchId < 1 {
		return nil, fmt.Errorf("invalid payment account row owner or batch")
	}

	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	rows := make([]*RawImportRow, 0)
	err := sess.Cols(
		"uid", "batch_id", "row_id", "row_number", "raw_payment_method", "raw_counterparty", "raw_item", "currency",
		"parse_state", "processing_state", "disposition", "ledger_account_id",
		"normalized_unix_time", "normalized_amount", "normalized_direction",
	).Where("uid=? AND batch_id=?", uid, batchId).Asc("row_number").Find(&rows)

	if err != nil {
		return nil, fmt.Errorf("list personal finance payment account rows: %w", err)
	}
	return rows, nil
}

func (r *Repository) ListPaymentAccountMappings(c core.Context, uid int64, sourceType SourceType) ([]*PaymentAccountMapping, error) {
	if uid < 1 || (sourceType != SOURCE_TYPE_ALIPAY && sourceType != SOURCE_TYPE_WECHAT) {
		return nil, fmt.Errorf("invalid payment account mapping owner or source")
	}

	db, _ := r.database(uid)
	sess := db.NewPrivacySession(c)
	defer sess.Close()
	mappings := make([]*PaymentAccountMapping, 0)
	err := sess.Where("uid=? AND source_type=?", uid, sourceType).
		Asc("created_unix_time", "mapping_id").Find(&mappings)

	if err != nil {
		return nil, fmt.Errorf("list personal finance payment account mappings: %w", err)
	}
	return mappings, nil
}

func (r *Repository) SavePaymentAccountMappingAndApply(c core.Context, candidate *PaymentAccountMapping, batchId int64, rowIds []int64) (*PaymentAccountMapping, error) {
	if !isValidNewPaymentAccountMapping(candidate) || batchId < 1 {
		return nil, fmt.Errorf("invalid payment account mapping")
	}

	uniqueRowIds := normalizePaymentAccountRowIds(rowIds)
	if uniqueRowIds == nil {
		return nil, fmt.Errorf("invalid payment account mapping rows")
	}

	var persisted *PaymentAccountMapping
	err := r.DoTransaction(c, candidate.Uid, func(tx *RepositoryTransaction) error {
		batch := new(ImportBatch)
		query := tx.session.Where("uid=? AND batch_id=?", candidate.Uid, batchId)
		if tx.database.DatabaseType() != settings.Sqlite3DbType {
			query = query.ForUpdate()
		}
		found, err := query.Get(batch)
		if err != nil {
			return fmt.Errorf("find payment account mapping batch: %w", err)
		}
		if !found || batch.SourceTypeSnapshot != candidate.SourceType {
			return ErrPaymentAccountBatchNotFound
		}

		persisted, err = tx.resolvePaymentAccountMapping(candidate)
		if err != nil {
			return err
		}

		for start := 0; start < len(uniqueRowIds); start += paymentAccountUpdateChunkSize {
			end := start + paymentAccountUpdateChunkSize
			if end > len(uniqueRowIds) {
				end = len(uniqueRowIds)
			}
			ledgerAccountId := persisted.LedgerAccountId
			_, err = tx.session.Where(
				"uid=? AND batch_id=? AND currency=? AND processing_state=?",
				candidate.Uid, batchId, candidate.Currency, PROCESSING_STATE_PENDING,
			).In("row_id", uniqueRowIds[start:end]).Cols("ledger_account_id").Update(&RawImportRow{LedgerAccountId: &ledgerAccountId})
			if err != nil {
				return fmt.Errorf("apply payment account mapping to batch rows: %w", err)
			}
		}
		return nil
	})

	if err != nil {
		return nil, err
	}
	return clonePaymentAccountMapping(persisted), nil
}

func (tx *RepositoryTransaction) resolvePaymentAccountMapping(candidate *PaymentAccountMapping) (*PaymentAccountMapping, error) {
	statement := `INSERT INTO pf_payment_account_mapping (
		uid, source_type, currency, alias_key, alias_key_version, ledger_account_id,
		masked_display_name, created_unix_time, updated_unix_time, mapping_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	switch tx.database.DatabaseType() {
	case settings.Sqlite3DbType, settings.PostgresDbType:
		statement += " ON CONFLICT (uid, source_type, currency, alias_key) DO NOTHING"
	case settings.MySqlDbType:
	default:
		return nil, fmt.Errorf("unsupported payment account mapping database type")
	}

	result, execErr := tx.session.Exec(statement,
		candidate.Uid, candidate.SourceType, candidate.Currency, candidate.AliasKey, candidate.AliasKeyVersion,
		candidate.LedgerAccountId, candidate.MaskedDisplayName, candidate.CreatedUnixTime, candidate.UpdatedUnixTime, candidate.MappingId,
	)
	if execErr != nil && (tx.database.DatabaseType() != settings.MySqlDbType || !isMySQLDuplicateEntryError(execErr)) {
		return nil, fmt.Errorf("insert payment account mapping: %w", execErr)
	}
	if execErr == nil {
		affected, err := result.RowsAffected()
		if err != nil || affected < 0 || affected > 1 {
			return nil, fmt.Errorf("read payment account mapping insert result")
		}
	}

	persisted := new(PaymentAccountMapping)
	query := tx.session.Where(
		"uid=? AND source_type=? AND currency=? AND alias_key=?",
		candidate.Uid, candidate.SourceType, candidate.Currency, candidate.AliasKey,
	)
	if tx.database.DatabaseType() != settings.Sqlite3DbType {
		query = query.ForUpdate()
	}
	found, err := query.Get(persisted)
	if err != nil {
		return nil, fmt.Errorf("find payment account mapping after insert: %w", err)
	}
	if !found || persisted.AliasKeyVersion != candidate.AliasKeyVersion {
		return nil, fmt.Errorf("payment account mapping is missing or incompatible")
	}

	if persisted.LedgerAccountId != candidate.LedgerAccountId || persisted.MaskedDisplayName != candidate.MaskedDisplayName {
		updated, err := tx.session.Where("uid=? AND mapping_id=?", candidate.Uid, persisted.MappingId).
			Cols("ledger_account_id", "masked_display_name", "updated_unix_time").Update(&PaymentAccountMapping{
			LedgerAccountId: candidate.LedgerAccountId, MaskedDisplayName: candidate.MaskedDisplayName,
			UpdatedUnixTime: candidate.UpdatedUnixTime,
		})
		if err != nil || updated != 1 {
			return nil, fmt.Errorf("update payment account mapping")
		}
		persisted.LedgerAccountId = candidate.LedgerAccountId
		persisted.MaskedDisplayName = candidate.MaskedDisplayName
		persisted.UpdatedUnixTime = candidate.UpdatedUnixTime
	}

	return persisted, nil
}

func (tx *RepositoryTransaction) paymentAccountMappingLookup(uid int64, sourceType SourceType) (map[string]*PaymentAccountMapping, error) {
	lookup := make(map[string]*PaymentAccountMapping)
	if sourceType != SOURCE_TYPE_ALIPAY && sourceType != SOURCE_TYPE_WECHAT {
		return lookup, nil
	}

	mappings := make([]*PaymentAccountMapping, 0)
	if err := tx.session.Where("uid=? AND source_type=?", uid, sourceType).Find(&mappings); err != nil {
		return nil, fmt.Errorf("load payment account mappings for evidence: %w", err)
	}
	for _, mapping := range mappings {
		if mapping != nil && mapping.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 &&
			isLowerHexSHA256(mapping.AliasKey) && isValidPaymentAccountCurrency(mapping.Currency) && mapping.LedgerAccountId > 0 {
			lookup[mapping.Currency+"\x00"+mapping.AliasKey] = mapping
		}
	}
	return lookup, nil
}

func resolveEvidenceLedgerAccount(account *SourceAccount, sourceType SourceType, row *RawImportRow, mappings map[string]*PaymentAccountMapping) *int64 {
	if row == nil || row.ParseState != PARSE_STATE_VALID {
		return nil
	}
	if sourceType == SOURCE_TYPE_BANK {
		return cloneInt64Pointer(account.LedgerAccountId)
	}
	if sourceType != SOURCE_TYPE_ALIPAY && sourceType != SOURCE_TYPE_WECHAT {
		return nil
	}
	if strings.TrimSpace(row.RawPaymentMethod) == "" {
		return cloneInt64Pointer(account.LedgerAccountId)
	}

	alias, ok := BuildPaymentAccountAlias(row.RawPaymentMethod)
	if !ok {
		return nil
	}
	mapping := mappings[row.Currency+"\x00"+alias.Key]
	if mapping == nil || mapping.LedgerAccountId < 1 {
		return nil
	}
	ledgerAccountId := mapping.LedgerAccountId
	return &ledgerAccountId
}

func isValidNewPaymentAccountMapping(mapping *PaymentAccountMapping) bool {
	return mapping != nil && mapping.Uid > 0 &&
		(mapping.SourceType == SOURCE_TYPE_ALIPAY || mapping.SourceType == SOURCE_TYPE_WECHAT) &&
		isValidPaymentAccountCurrency(mapping.Currency) && isLowerHexSHA256(mapping.AliasKey) &&
		mapping.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 && mapping.LedgerAccountId > 0 &&
		mapping.MaskedDisplayName != "" && utf8.RuneCountInString(mapping.MaskedDisplayName) <= maximumPaymentAccountDisplayRunes &&
		mapping.CreatedUnixTime > 0 && mapping.UpdatedUnixTime >= mapping.CreatedUnixTime && mapping.MappingId > 0
}

func normalizePaymentAccountRowIds(rowIds []int64) []int64 {
	seen := make(map[int64]struct{}, len(rowIds))
	result := make([]int64, 0, len(rowIds))
	for _, rowId := range rowIds {
		if rowId < 1 {
			return nil
		}
		if _, exists := seen[rowId]; exists {
			continue
		}
		seen[rowId] = struct{}{}
		result = append(result, rowId)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func clonePaymentAccountMapping(mapping *PaymentAccountMapping) *PaymentAccountMapping {
	if mapping == nil {
		return nil
	}
	cloned := *mapping
	return &cloned
}
