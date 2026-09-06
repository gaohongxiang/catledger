SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_batches' AND column_name = 'analysis_json'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_batches ADD COLUMN analysis_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_rows' AND column_name = 'semantic_json'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_rows ADD COLUMN semantic_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;

SET @catledger_column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'catledger_import_rows' AND column_name = 'observations_json'
);
SET @catledger_column_sql := IF(@catledger_column_exists = 0,
  'ALTER TABLE catledger_import_rows ADD COLUMN observations_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_column_statement FROM @catledger_column_sql;
EXECUTE catledger_column_statement;
DEALLOCATE PREPARE catledger_column_statement;
