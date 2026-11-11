-- 负债分期新模型：剩余本金按逐期未还本金计算，不再依赖「本金基准日」。
-- 放宽 0013 的 ck_catledger_loans_baseline：允许有基准本金但无基准日；
-- 仍禁止「有基准日却无基准本金」（基准日无意义）。
-- 迁移需可重入：先删旧约束（若有），再按新定义加回（若无）。
SET @catledger_baseline_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_baseline')>0,
  'ALTER TABLE catledger_loans DROP CHECK ck_catledger_loans_baseline', 'SELECT 1');
PREPARE catledger_baseline_stmt FROM @catledger_baseline_sql;
EXECUTE catledger_baseline_stmt;
DEALLOCATE PREPARE catledger_baseline_stmt;

SET @catledger_baseline_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_baseline')=0,
  'ALTER TABLE catledger_loans ADD CONSTRAINT ck_catledger_loans_baseline CHECK (baseline_date IS NULL OR baseline_principal_minor IS NOT NULL)', 'SELECT 1');
PREPARE catledger_baseline_stmt FROM @catledger_baseline_sql;
EXECUTE catledger_baseline_stmt;
DEALLOCATE PREPARE catledger_baseline_stmt;
