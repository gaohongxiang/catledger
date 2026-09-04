SET @catledger_mapping_action_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'catledger_import_account_mappings'
    AND column_name = 'mapping_action'
);
SET @catledger_mapping_action_sql := IF(
  @catledger_mapping_action_exists = 0,
  'ALTER TABLE catledger_import_account_mappings ADD COLUMN mapping_action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''account'' AFTER payment_method_hint',
  'SELECT 1'
);
PREPARE catledger_mapping_action_statement FROM @catledger_mapping_action_sql;
EXECUTE catledger_mapping_action_statement;
DEALLOCATE PREPARE catledger_mapping_action_statement;

SET @catledger_mapping_disabled_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'catledger_import_account_mappings'
    AND column_name = 'disabled_at'
);
SET @catledger_mapping_disabled_sql := IF(
  @catledger_mapping_disabled_exists = 0,
  'ALTER TABLE catledger_import_account_mappings ADD COLUMN disabled_at DATETIME(3) DEFAULT NULL AFTER version',
  'SELECT 1'
);
PREPARE catledger_mapping_disabled_statement FROM @catledger_mapping_disabled_sql;
EXECUTE catledger_mapping_disabled_statement;
DEALLOCATE PREPARE catledger_mapping_disabled_statement;

SET @catledger_mapping_account_not_nullable := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'catledger_import_account_mappings'
    AND column_name = 'account_id'
    AND is_nullable = 'NO'
);
SET @catledger_mapping_account_nullable_sql := IF(
  @catledger_mapping_account_not_nullable = 1,
  'ALTER TABLE catledger_import_account_mappings MODIFY COLUMN account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL',
  'SELECT 1'
);
PREPARE catledger_mapping_account_nullable_statement FROM @catledger_mapping_account_nullable_sql;
EXECUTE catledger_mapping_account_nullable_statement;
DEALLOCATE PREPARE catledger_mapping_account_nullable_statement;

SET @catledger_mapping_action_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'catledger_import_account_mappings'
    AND constraint_name = 'chk_catledger_import_account_mapping_action'
    AND constraint_type = 'CHECK'
);
SET @catledger_mapping_action_check_sql := IF(
  @catledger_mapping_action_check_exists = 0,
  'ALTER TABLE catledger_import_account_mappings ADD CONSTRAINT chk_catledger_import_account_mapping_action CHECK ((mapping_action = ''account'' AND account_id IS NOT NULL) OR (mapping_action = ''ignore'' AND account_id IS NULL))',
  'SELECT 1'
);
PREPARE catledger_mapping_action_check_statement FROM @catledger_mapping_action_check_sql;
EXECUTE catledger_mapping_action_check_statement;
DEALLOCATE PREPARE catledger_mapping_action_check_statement;
