-- ACC-SORT-20261112: 账户手动排序。给 catledger_accounts 加 sort_order 列（同一 uid 内、同 nature 内排序）。
-- 老数据为 NULL：读取层把 NULL 排到最后，按原 created_at 兜底，行为不变。可重入。
SET @catledger_has_account_sort_order = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND COLUMN_NAME='sort_order');
SET @catledger_account_sort_order_sql = IF(@catledger_has_account_sort_order=0,
  'ALTER TABLE catledger_accounts ADD COLUMN sort_order INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_account_sort_order_stmt FROM @catledger_account_sort_order_sql;
EXECUTE catledger_account_sort_order_stmt;
DEALLOCATE PREPARE catledger_account_sort_order_stmt;

-- 覆盖「按 uid + nature 排序」的读路径，避免全表扫。
SET @catledger_has_account_sort_idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_accounts' AND INDEX_NAME='idx_catledger_accounts_uid_nature_sort');
SET @catledger_account_sort_idx_sql = IF(@catledger_has_account_sort_idx=0,
  'CREATE INDEX idx_catledger_accounts_uid_nature_sort ON catledger_accounts (uid, nature, sort_order)', 'SELECT 1');
PREPARE catledger_account_sort_idx_stmt FROM @catledger_account_sort_idx_sql;
EXECUTE catledger_account_sort_idx_stmt;
DEALLOCATE PREPARE catledger_account_sort_idx_stmt;
