-- 负债账户欠款模型：最近一期账单的汇总快照。
-- 只记录账单事实（本期应还款总额／本期最低还款额／到期还款日／账单周期），
-- 不生成交易、不改动已有余额。总欠款由读取侧 = 本期应还 + 未来未到期次分期剩余本息派生。
SET @catledger_statement_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='statement_due_minor')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN statement_due_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_statement_stmt FROM @catledger_statement_sql;
EXECUTE catledger_statement_stmt;
DEALLOCATE PREPARE catledger_statement_stmt;

SET @catledger_statement_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='statement_minimum_minor')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN statement_minimum_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_statement_stmt FROM @catledger_statement_sql;
EXECUTE catledger_statement_stmt;
DEALLOCATE PREPARE catledger_statement_stmt;

SET @catledger_statement_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='statement_due_date')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN statement_due_date DATE DEFAULT NULL', 'SELECT 1');
PREPARE catledger_statement_stmt FROM @catledger_statement_sql;
EXECUTE catledger_statement_stmt;
DEALLOCATE PREPARE catledger_statement_stmt;

SET @catledger_statement_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='statement_cycle')=0,
  'ALTER TABLE catledger_accounts ADD COLUMN statement_cycle VARCHAR(40) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_statement_stmt FROM @catledger_statement_sql;
EXECUTE catledger_statement_stmt;
DEALLOCATE PREPARE catledger_statement_stmt;

SET @catledger_statement_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND CONSTRAINT_NAME='chk_catledger_account_statement')=0,
  'ALTER TABLE catledger_accounts ADD CONSTRAINT chk_catledger_account_statement CHECK ((statement_due_minor IS NULL OR (nature = ''liability'' AND statement_due_minor <= 9223372036854775807)) AND (statement_minimum_minor IS NULL OR (nature = ''liability'' AND statement_minimum_minor <= 9223372036854775807)) AND (statement_due_date IS NULL OR nature = ''liability'') AND (statement_cycle IS NULL OR (nature = ''liability'' AND CHAR_LENGTH(statement_cycle) <= 40)))', 'SELECT 1');
PREPARE catledger_statement_stmt FROM @catledger_statement_sql;
EXECUTE catledger_statement_stmt;
DEALLOCATE PREPARE catledger_statement_stmt;
