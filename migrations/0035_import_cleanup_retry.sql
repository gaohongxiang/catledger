-- Maintenance-only retry metadata. Never advance business updated_at for retries.
-- Each guard permits retry after an interrupted forward migration.
SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_files' AND column_name = 'cleanup_retry_after'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_files ADD COLUMN cleanup_retry_after DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_files' AND column_name = 'cleanup_failure_count'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_files ADD COLUMN cleanup_failure_count SMALLINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_finance_updates' AND column_name = 'cleanup_retry_after'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_finance_updates ADD COLUMN cleanup_retry_after DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_finance_updates' AND column_name = 'cleanup_failure_count'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_finance_updates ADD COLUMN cleanup_failure_count SMALLINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_index_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'catledger_finance_updates' AND index_name = 'idx_catledger_updates_cleanup'
);
SET @catledger_index_sql := IF(@catledger_index_exists = 0,
  'ALTER TABLE catledger_finance_updates ADD INDEX idx_catledger_updates_cleanup (status, updated_at, cleanup_retry_after)', 'SELECT 1');
PREPARE catledger_index_statement FROM @catledger_index_sql;
EXECUTE catledger_index_statement;
DEALLOCATE PREPARE catledger_index_statement;
