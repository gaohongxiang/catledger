-- MINI-1908F：分期录入的原始本金、历史进度、分类和优惠；历史记录不回填。
SET @catledger_has_installment_setup = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='installment_setup_json');
SET @catledger_installment_setup_sql = IF(@catledger_has_installment_setup=0, 'ALTER TABLE catledger_loans ADD COLUMN installment_setup_json JSON DEFAULT NULL', 'SELECT 1');
PREPARE catledger_installment_setup_stmt FROM @catledger_installment_setup_sql;
EXECUTE catledger_installment_setup_stmt;
DEALLOCATE PREPARE catledger_installment_setup_stmt;

SET @catledger_has_schedule_check = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_schedule_v2');
SET @catledger_schedule_check_sql = IF(@catledger_has_schedule_check=0,
  'ALTER TABLE catledger_loans ADD CONSTRAINT ck_catledger_loans_schedule_v2 CHECK (
    ((schedule_method IS NULL AND schedule_terms IS NULL AND measurement_kind IS NULL)
      OR (schedule_method IS NOT NULL AND schedule_terms IS NOT NULL AND measurement_kind IS NOT NULL))
    AND (schedule_method IS NULL OR schedule_method IN (''flat'',''equal_payment'',''equal_principal'',''interest_only''))
    AND (schedule_terms IS NULL OR schedule_terms BETWEEN 1 AND 600)
    AND (measurement_kind IS NULL
      OR (measurement_kind=''rate'' AND quote_type IS NOT NULL AND rate_ppm IS NOT NULL AND repayment_minor IS NULL)
      OR (measurement_kind=''repayment'' AND repayment_minor IS NOT NULL AND quote_type IS NULL AND rate_ppm IS NULL))
    AND (quote_type IS NULL OR quote_type IN (''annual'',''monthly'',''daily'',''installment''))
    AND (quote_type IS NULL OR quote_type<>''installment'' OR schedule_method=''flat'')
    AND (fee_upfront_minor IS NULL OR baseline_principal_minor IS NULL OR fee_upfront_minor < COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(installment_setup_json, ''$.originalPrincipalMinor'')) AS UNSIGNED), baseline_principal_minor))
    AND (installment_setup_json IS NULL OR (
      JSON_TYPE(installment_setup_json)=''OBJECT''
      AND JSON_CONTAINS_PATH(installment_setup_json, ''all'', ''$.schema'', ''$.originalPrincipalMinor'', ''$.historicalPaidTerms'')
      AND JSON_EXTRACT(installment_setup_json, ''$.schema'')=1
      AND JSON_UNQUOTE(JSON_EXTRACT(installment_setup_json, ''$.originalPrincipalMinor'')) REGEXP ''^[1-9][0-9]{0,18}$''
      AND JSON_TYPE(JSON_EXTRACT(installment_setup_json, ''$.historicalPaidTerms''))=''INTEGER''
      AND schedule_terms IS NOT NULL
      AND CAST(JSON_EXTRACT(installment_setup_json, ''$.historicalPaidTerms'') AS SIGNED) BETWEEN 0 AND schedule_terms
    ))
  )', 'SELECT 1');
PREPARE catledger_schedule_check_stmt FROM @catledger_schedule_check_sql;
EXECUTE catledger_schedule_check_stmt;
DEALLOCATE PREPARE catledger_schedule_check_stmt;

SET @catledger_old_schedule_check = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_schedule');
SET @catledger_drop_old_schedule_sql = IF(@catledger_old_schedule_check=1, 'ALTER TABLE catledger_loans DROP CHECK ck_catledger_loans_schedule', 'SELECT 1');
PREPARE catledger_drop_old_schedule_stmt FROM @catledger_drop_old_schedule_sql;
EXECUTE catledger_drop_old_schedule_stmt;
DEALLOCATE PREPARE catledger_drop_old_schedule_stmt;
