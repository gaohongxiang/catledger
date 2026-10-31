-- 账户绑定只追加确认依据；旧映射保持 NULL，读取时仅作候选，不回填归属。
SET @catledger_binding_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'catledger_import_account_mappings' AND COLUMN_NAME = 'binding_json'
);
SET @catledger_binding_sql := IF(@catledger_binding_exists = 0,
  'ALTER TABLE catledger_import_account_mappings ADD COLUMN binding_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_binding_statement FROM @catledger_binding_sql;
EXECUTE catledger_binding_statement;
DEALLOCATE PREPARE catledger_binding_statement;

SET @catledger_external_ready := (
  SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_catledger_import_account_mapping_action'
    AND CHECK_CLAUSE LIKE '%external%'
);
SET @catledger_external_sql := IF(@catledger_external_ready = 0,
  'ALTER TABLE catledger_import_account_mappings DROP CHECK chk_catledger_import_account_mapping_action,
    ADD CONSTRAINT chk_catledger_import_account_mapping_action CHECK ((mapping_action = ''account'' AND account_id IS NOT NULL)
      OR (mapping_action IN (''ignore'', ''external'') AND account_id IS NULL))', 'SELECT 1');
PREPARE catledger_external_statement FROM @catledger_external_sql;
EXECUTE catledger_external_statement;
DEALLOCATE PREPARE catledger_external_statement;

SET @catledger_binding_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'catledger_finance_update_account_mapping_drafts' AND COLUMN_NAME = 'binding_json'
);
SET @catledger_binding_sql := IF(@catledger_binding_exists = 0,
  'ALTER TABLE catledger_finance_update_account_mapping_drafts ADD COLUMN binding_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_binding_statement FROM @catledger_binding_sql;
EXECUTE catledger_binding_statement;
DEALLOCATE PREPARE catledger_binding_statement;

SET @catledger_external_ready := (
  SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_catledger_finance_update_draft_mapping_action'
    AND CHECK_CLAUSE LIKE '%external%'
);
SET @catledger_external_sql := IF(@catledger_external_ready = 0,
  'ALTER TABLE catledger_finance_update_account_mapping_drafts DROP CHECK chk_catledger_finance_update_draft_mapping_action,
    ADD CONSTRAINT chk_catledger_finance_update_draft_mapping_action CHECK ((mapping_action = ''account'' AND account_id IS NOT NULL)
      OR (mapping_action IN (''ignore'', ''external'') AND account_id IS NULL))', 'SELECT 1');
PREPARE catledger_external_statement FROM @catledger_external_sql;
EXECUTE catledger_external_statement;
DEALLOCATE PREPARE catledger_external_statement;
