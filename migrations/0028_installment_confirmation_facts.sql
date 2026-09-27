-- 历史清偿和实际凭证替换各保留金额；本金原确认快照保存在既有 progress_json 与审计中。
SET @catledger_fact_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charges' AND COLUMN_NAME='historical_settled_minor')=0,
  'ALTER TABLE catledger_loan_charges ADD COLUMN historical_settled_minor BIGINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_fact_stmt FROM @catledger_fact_sql;
EXECUTE catledger_fact_stmt;
DEALLOCATE PREPARE catledger_fact_stmt;

SET @catledger_fact_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charge_allocations' AND COLUMN_NAME='historical_replaced_minor')=0,
  'ALTER TABLE catledger_loan_charge_allocations ADD COLUMN historical_replaced_minor BIGINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_fact_stmt FROM @catledger_fact_sql;
EXECUTE catledger_fact_stmt;
DEALLOCATE PREPARE catledger_fact_stmt;

SET @catledger_fact_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_period_allocations' AND COLUMN_NAME='historical_principal_minor')=0,
  'ALTER TABLE catledger_loan_period_allocations ADD COLUMN historical_principal_minor BIGINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_fact_stmt FROM @catledger_fact_sql;
EXECUTE catledger_fact_stmt;
DEALLOCATE PREPARE catledger_fact_stmt;

-- 仅从0027成对余额保全交易恢复已证明的清偿金额，不推算旧计划或未知本金。
UPDATE catledger_loan_charges f JOIN catledger_transactions t
  ON t.uid=f.uid AND t.transaction_id=f.balance_adjustment_id
SET f.historical_settled_minor=t.amount_minor
WHERE f.state='recorded' AND f.historical_settled_minor=0 AND t.deleted_at IS NULL
  AND t.type='balance_adjustment' AND t.destination_account_id IS NOT NULL;
