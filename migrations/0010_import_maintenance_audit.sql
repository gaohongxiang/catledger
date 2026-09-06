SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_finance_update_account_drafts' AND column_name = 'superseded_at'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_finance_update_account_drafts ADD COLUMN superseded_at DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_economic_event_transactions' AND column_name = 'superseded_at'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_economic_event_transactions ADD COLUMN superseded_at DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_finance_updates' AND column_name = 'side_effects_json'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_finance_updates ADD COLUMN side_effects_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_category_mappings' AND column_name = 'disabled_at'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_category_mappings ADD COLUMN disabled_at DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;
