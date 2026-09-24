-- 负债账单设置只描述账户资料，不生成交易或改动已有余额。
SET @catledger_billing_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='statement_day')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN statement_day TINYINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_billing_stmt FROM @catledger_billing_sql;
EXECUTE catledger_billing_stmt;
DEALLOCATE PREPARE catledger_billing_stmt;

SET @catledger_billing_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='repayment_day')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN repayment_day TINYINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_billing_stmt FROM @catledger_billing_sql;
EXECUTE catledger_billing_stmt;
DEALLOCATE PREPARE catledger_billing_stmt;

SET @catledger_billing_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='credit_limit_minor')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN credit_limit_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_billing_stmt FROM @catledger_billing_sql;
EXECUTE catledger_billing_stmt;
DEALLOCATE PREPARE catledger_billing_stmt;

SET @catledger_billing_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND CONSTRAINT_NAME='chk_catledger_account_billing')=0,
  'ALTER TABLE catledger_accounts ADD CONSTRAINT chk_catledger_account_billing CHECK ((statement_day IS NULL OR statement_day BETWEEN 1 AND 31) AND (repayment_day IS NULL OR repayment_day BETWEEN 1 AND 31) AND (credit_limit_minor IS NULL OR credit_limit_minor <= 9223372036854775807) AND (nature = ''liability'' OR (statement_day IS NULL AND repayment_day IS NULL AND credit_limit_minor IS NULL)))', 'SELECT 1');
PREPARE catledger_billing_stmt FROM @catledger_billing_sql;
EXECUTE catledger_billing_stmt;
DEALLOCATE PREPARE catledger_billing_stmt;
