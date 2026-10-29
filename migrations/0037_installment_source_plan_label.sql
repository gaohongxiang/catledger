-- 计划名是账单事实的持久化副本：本金摘要去掉期次后缀。旧来源保持 NULL，读取时回退原展示。
-- 不改变来源身份、费用关系或账务；不重建索引，按账户/贷款读取不受影响。
SET @catledger_plan_label_ready := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catledger_installment_items' AND COLUMN_NAME = 'plan_label'
);
SET @catledger_plan_label_sql := IF(@catledger_plan_label_ready = 0,
  'ALTER TABLE catledger_installment_items ADD COLUMN plan_label VARCHAR(120) DEFAULT NULL AFTER reference_label', 'SELECT 1');
PREPARE catledger_plan_label_statement FROM @catledger_plan_label_sql;
EXECUTE catledger_plan_label_statement;
DEALLOCATE PREPARE catledger_plan_label_statement;
