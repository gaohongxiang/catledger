-- SCHEDULE-20261109: 分期本金取整口径。cent=到分（历史默认），yuan=整元平摊、尾差进末期（跟银行账单一致）。
-- 只加列并重建 0021 的 ck_catledger_loans_schedule_v2（追加 principal_rounding 取值范围），不改既有数据：
-- 老计划 principal_rounding 为 NULL，读取层按 'cent' 解释，行为不变。
SET @catledger_has_principal_rounding = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='principal_rounding');
SET @catledger_principal_rounding_sql = IF(@catledger_has_principal_rounding=0,
  'ALTER TABLE catledger_loans ADD COLUMN principal_rounding VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL', 'SELECT 1');
PREPARE catledger_principal_rounding_stmt FROM @catledger_principal_rounding_sql;
EXECUTE catledger_principal_rounding_stmt;
DEALLOCATE PREPARE catledger_principal_rounding_stmt;

-- 删掉 0021 的 schedule_v2（若存在）再按「原 v2 全部子句 + principal_rounding 校验」重建，可重入。
-- 同时兜底删可能残留的旧名 ck_catledger_loans_schedule，避免留下两份重叠约束。
SET @catledger_has_schedule_v2 = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_schedule_v2');
SET @catledger_drop_schedule_v2 = IF(@catledger_has_schedule_v2>0,
  'ALTER TABLE catledger_loans DROP CONSTRAINT ck_catledger_loans_schedule_v2', 'SELECT 1');
PREPARE catledger_drop_schedule_v2_stmt FROM @catledger_drop_schedule_v2;
EXECUTE catledger_drop_schedule_v2_stmt;
DEALLOCATE PREPARE catledger_drop_schedule_v2_stmt;

SET @catledger_has_old_schedule = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_schedule');
SET @catledger_drop_old_schedule = IF(@catledger_has_old_schedule>0,
  'ALTER TABLE catledger_loans DROP CONSTRAINT ck_catledger_loans_schedule', 'SELECT 1');
PREPARE catledger_drop_old_schedule_stmt FROM @catledger_drop_old_schedule;
EXECUTE catledger_drop_old_schedule_stmt;
DEALLOCATE PREPARE catledger_drop_old_schedule_stmt;

ALTER TABLE catledger_loans ADD CONSTRAINT ck_catledger_loans_schedule_v2 CHECK (
    ((schedule_method IS NULL AND schedule_terms IS NULL AND measurement_kind IS NULL)
      OR (schedule_method IS NOT NULL AND schedule_terms IS NOT NULL AND measurement_kind IS NOT NULL))
    AND (schedule_method IS NULL OR schedule_method IN ('flat','equal_payment','equal_principal','interest_only'))
    AND (schedule_terms IS NULL OR schedule_terms BETWEEN 1 AND 600)
    AND (measurement_kind IS NULL
      OR (measurement_kind='rate' AND quote_type IS NOT NULL AND rate_ppm IS NOT NULL AND repayment_minor IS NULL)
      OR (measurement_kind='repayment' AND repayment_minor IS NOT NULL AND quote_type IS NULL AND rate_ppm IS NULL))
    AND (quote_type IS NULL OR quote_type IN ('annual','monthly','daily','installment'))
    AND (quote_type IS NULL OR quote_type<>'installment' OR schedule_method='flat')
    AND (principal_rounding IS NULL OR principal_rounding IN ('cent','yuan'))
    AND (fee_upfront_minor IS NULL OR baseline_principal_minor IS NULL OR fee_upfront_minor < COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(installment_setup_json, '$.originalPrincipalMinor')) AS UNSIGNED), baseline_principal_minor))
    AND (installment_setup_json IS NULL OR (
      JSON_TYPE(installment_setup_json)='OBJECT'
      AND JSON_CONTAINS_PATH(installment_setup_json, 'all', '$.schema', '$.originalPrincipalMinor', '$.historicalPaidTerms')
      AND JSON_EXTRACT(installment_setup_json, '$.schema')=1
      AND JSON_UNQUOTE(JSON_EXTRACT(installment_setup_json, '$.originalPrincipalMinor')) REGEXP '^[1-9][0-9]{0,18}$'
      AND JSON_TYPE(JSON_EXTRACT(installment_setup_json, '$.historicalPaidTerms'))='INTEGER'
      AND schedule_terms IS NOT NULL
      AND CAST(JSON_EXTRACT(installment_setup_json, '$.historicalPaidTerms') AS SIGNED) BETWEEN 0 AND schedule_terms
    ))
  );
