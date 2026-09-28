-- 整组删除与不可覆盖的创建证据。旧数据保持 NULL，运行时依据创建记录核对，不猜测回填。
SET @catledger_delete_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_transactions' AND COLUMN_NAME='creation_provenance_json')=0,
  'ALTER TABLE catledger_transactions ADD COLUMN creation_provenance_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_delete_stmt FROM @catledger_delete_sql;
EXECUTE catledger_delete_stmt;
DEALLOCATE PREPARE catledger_delete_stmt;

SET @catledger_delete_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='deleted_at')=0,
  'ALTER TABLE catledger_loans ADD COLUMN deleted_at DATETIME(3) DEFAULT NULL, ADD COLUMN deletion_snapshot_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_delete_stmt FROM @catledger_delete_sql;
EXECUTE catledger_delete_stmt;
DEALLOCATE PREPARE catledger_delete_stmt;

SET @catledger_delete_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loan_charges' AND COLUMN_NAME='plan_removed_at')=0,
  'ALTER TABLE catledger_loan_charges ADD COLUMN plan_removed_at DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_delete_stmt FROM @catledger_delete_sql;
EXECUTE catledger_delete_stmt;
DEALLOCATE PREPARE catledger_delete_stmt;
