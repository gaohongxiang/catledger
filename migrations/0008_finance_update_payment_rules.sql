SET @catledger_draft_mapping_action_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'catledger_finance_update_account_mapping_drafts'
    AND column_name = 'mapping_action'
);
SET @catledger_draft_mapping_action_sql := IF(
  @catledger_draft_mapping_action_exists = 0,
  'ALTER TABLE catledger_finance_update_account_mapping_drafts ADD COLUMN mapping_action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''account'' AFTER payment_method_hint',
  'SELECT 1'
);
PREPARE catledger_draft_mapping_action_statement FROM @catledger_draft_mapping_action_sql;
EXECUTE catledger_draft_mapping_action_statement;
DEALLOCATE PREPARE catledger_draft_mapping_action_statement;

SET @catledger_draft_mapping_account_not_nullable := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'catledger_finance_update_account_mapping_drafts'
    AND column_name = 'account_id'
    AND is_nullable = 'NO'
);
SET @catledger_draft_mapping_account_nullable_sql := IF(
  @catledger_draft_mapping_account_not_nullable = 1,
  'ALTER TABLE catledger_finance_update_account_mapping_drafts MODIFY COLUMN account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL',
  'SELECT 1'
);
PREPARE catledger_draft_mapping_account_nullable_statement FROM @catledger_draft_mapping_account_nullable_sql;
EXECUTE catledger_draft_mapping_account_nullable_statement;
DEALLOCATE PREPARE catledger_draft_mapping_account_nullable_statement;

SET @catledger_draft_mapping_action_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'catledger_finance_update_account_mapping_drafts'
    AND constraint_name = 'chk_catledger_finance_update_draft_mapping_action'
    AND constraint_type = 'CHECK'
);
SET @catledger_draft_mapping_action_check_sql := IF(
  @catledger_draft_mapping_action_check_exists = 0,
  'ALTER TABLE catledger_finance_update_account_mapping_drafts ADD CONSTRAINT chk_catledger_finance_update_draft_mapping_action CHECK ((mapping_action = ''account'' AND account_id IS NOT NULL) OR (mapping_action = ''ignore'' AND account_id IS NULL))',
  'SELECT 1'
);
PREPARE catledger_draft_mapping_action_check_statement FROM @catledger_draft_mapping_action_check_sql;
EXECUTE catledger_draft_mapping_action_check_statement;
DEALLOCATE PREPARE catledger_draft_mapping_action_check_statement;
