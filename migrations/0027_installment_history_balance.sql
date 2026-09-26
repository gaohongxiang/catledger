-- 已还历史的费用补记与余额保全成对保存；只加关系，不回填真实账目。
SET @catledger_history_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charges' AND COLUMN_NAME='balance_adjustment_id')=0,
  'ALTER TABLE catledger_loan_charges ADD COLUMN balance_adjustment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL', 'SELECT 1');
PREPARE catledger_history_stmt FROM @catledger_history_sql;
EXECUTE catledger_history_stmt;
DEALLOCATE PREPARE catledger_history_stmt;

SET @catledger_history_sql = IF((SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charges' AND INDEX_NAME='uk_charge_history_balance')=0,
  'ALTER TABLE catledger_loan_charges ADD UNIQUE KEY uk_charge_history_balance (uid,balance_adjustment_id)', 'SELECT 1');
PREPARE catledger_history_stmt FROM @catledger_history_sql;
EXECUTE catledger_history_stmt;
DEALLOCATE PREPARE catledger_history_stmt;

SET @catledger_history_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charges' AND CONSTRAINT_NAME='fk_charge_history_balance')=0,
  'ALTER TABLE catledger_loan_charges ADD CONSTRAINT fk_charge_history_balance FOREIGN KEY (uid,balance_adjustment_id) REFERENCES catledger_transactions(uid,transaction_id)', 'SELECT 1');
PREPARE catledger_history_stmt FROM @catledger_history_sql;
EXECUTE catledger_history_stmt;
DEALLOCATE PREPARE catledger_history_stmt;
