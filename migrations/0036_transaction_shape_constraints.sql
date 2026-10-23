-- Stable transaction shapes only. No ledger rewrite, FK change, or runtime privilege expansion.
-- NULL categories and unlinked refunds remain valid. Soft-deleted rows keep the same shape.
-- Guard each CHECK so a partially applied forward migration can be resumed.

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_type' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_type CHECK (CAST(type AS BINARY) IN (''expense'',''income'',''transfer'',''refund'',''balance_adjustment''))', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_origin' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_origin CHECK (CAST(origin AS BINARY) IN (''manual'',''import'',''system'',''loan_plan''))', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_amount' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_amount CHECK (amount_minor > 0)', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_version' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_version CHECK (version >= 1)', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_accounts' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_accounts CHECK ((type=''expense'' AND source_account_id IS NOT NULL AND destination_account_id IS NULL) OR (type IN (''income'',''refund'') AND source_account_id IS NULL AND destination_account_id IS NOT NULL) OR (type=''transfer'' AND source_account_id IS NOT NULL AND destination_account_id IS NOT NULL AND source_account_id<>destination_account_id) OR (type=''balance_adjustment'' AND ((source_account_id IS NOT NULL AND destination_account_id IS NULL) OR (source_account_id IS NULL AND destination_account_id IS NOT NULL))))', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_category' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_category CHECK (category_id IS NULL OR type IN (''expense'',''income'',''refund''))', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_original' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_original CHECK (original_transaction_id IS NULL OR (type=''refund'' AND original_transaction_id<>transaction_id))', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_local_date' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_local_date CHECK ((occurred_local_date=DATE(occurred_local_at)) IS TRUE)', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_offset' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_offset CHECK (timezone_offset_minutes BETWEEN -840 AND 840)', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;

SET @catledger_check_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
    AND constraint_name = 'ck_catledger_transaction_utc' AND constraint_type = 'CHECK'
);
SET @catledger_check_sql := IF(@catledger_check_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT ck_catledger_transaction_utc CHECK ((occurred_at_utc=DATE_ADD(occurred_local_at,INTERVAL timezone_offset_minutes MINUTE)) IS TRUE)', 'SELECT 1');
PREPARE catledger_check_statement FROM @catledger_check_sql;
EXECUTE catledger_check_statement;
DEALLOCATE PREPARE catledger_check_statement;
