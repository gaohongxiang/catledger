-- MINI-1908D: 贷款结构化分期参数；利率用 ppm 整数、金额用整数分，生成期次不产生交易，改参数不自动重算。
SET @catledger_has_schedule_method = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='schedule_method');
SET @catledger_schedule_method_sql = IF(@catledger_has_schedule_method=0,
  'ALTER TABLE catledger_loans ADD COLUMN schedule_method VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL', 'SELECT 1');
PREPARE catledger_schedule_method_stmt FROM @catledger_schedule_method_sql;
EXECUTE catledger_schedule_method_stmt;
DEALLOCATE PREPARE catledger_schedule_method_stmt;

SET @catledger_has_schedule_terms = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='schedule_terms');
SET @catledger_schedule_terms_sql = IF(@catledger_has_schedule_terms=0,
  'ALTER TABLE catledger_loans ADD COLUMN schedule_terms INT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_schedule_terms_stmt FROM @catledger_schedule_terms_sql;
EXECUTE catledger_schedule_terms_stmt;
DEALLOCATE PREPARE catledger_schedule_terms_stmt;

SET @catledger_has_measurement_kind = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='measurement_kind');
SET @catledger_measurement_kind_sql = IF(@catledger_has_measurement_kind=0,
  'ALTER TABLE catledger_loans ADD COLUMN measurement_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL', 'SELECT 1');
PREPARE catledger_measurement_kind_stmt FROM @catledger_measurement_kind_sql;
EXECUTE catledger_measurement_kind_stmt;
DEALLOCATE PREPARE catledger_measurement_kind_stmt;

SET @catledger_has_quote_type = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='quote_type');
SET @catledger_quote_type_sql = IF(@catledger_has_quote_type=0,
  'ALTER TABLE catledger_loans ADD COLUMN quote_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL', 'SELECT 1');
PREPARE catledger_quote_type_stmt FROM @catledger_quote_type_sql;
EXECUTE catledger_quote_type_stmt;
DEALLOCATE PREPARE catledger_quote_type_stmt;

SET @catledger_has_rate_ppm = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='rate_ppm');
SET @catledger_rate_ppm_sql = IF(@catledger_has_rate_ppm=0,
  'ALTER TABLE catledger_loans ADD COLUMN rate_ppm BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_rate_ppm_stmt FROM @catledger_rate_ppm_sql;
EXECUTE catledger_rate_ppm_stmt;
DEALLOCATE PREPARE catledger_rate_ppm_stmt;

SET @catledger_has_repayment_minor = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='repayment_minor');
SET @catledger_repayment_minor_sql = IF(@catledger_has_repayment_minor=0,
  'ALTER TABLE catledger_loans ADD COLUMN repayment_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_repayment_minor_stmt FROM @catledger_repayment_minor_sql;
EXECUTE catledger_repayment_minor_stmt;
DEALLOCATE PREPARE catledger_repayment_minor_stmt;

SET @catledger_has_fee_per_term = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='fee_per_term_minor');
SET @catledger_fee_per_term_sql = IF(@catledger_has_fee_per_term=0,
  'ALTER TABLE catledger_loans ADD COLUMN fee_per_term_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_fee_per_term_stmt FROM @catledger_fee_per_term_sql;
EXECUTE catledger_fee_per_term_stmt;
DEALLOCATE PREPARE catledger_fee_per_term_stmt;

SET @catledger_has_fee_upfront = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='fee_upfront_minor');
SET @catledger_fee_upfront_sql = IF(@catledger_has_fee_upfront=0,
  'ALTER TABLE catledger_loans ADD COLUMN fee_upfront_minor BIGINT UNSIGNED DEFAULT NULL', 'SELECT 1');
PREPARE catledger_fee_upfront_stmt FROM @catledger_fee_upfront_sql;
EXECUTE catledger_fee_upfront_stmt;
DEALLOCATE PREPARE catledger_fee_upfront_stmt;

SET @catledger_has_first_payment = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='first_payment_date');
SET @catledger_first_payment_sql = IF(@catledger_has_first_payment=0,
  'ALTER TABLE catledger_loans ADD COLUMN first_payment_date DATE DEFAULT NULL', 'SELECT 1');
PREPARE catledger_first_payment_stmt FROM @catledger_first_payment_sql;
EXECUTE catledger_first_payment_stmt;
DEALLOCATE PREPARE catledger_first_payment_stmt;

SET @catledger_has_schedule_check = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND CONSTRAINT_NAME='ck_catledger_loans_schedule');
SET @catledger_schedule_check_sql = IF(@catledger_has_schedule_check=0,
  'ALTER TABLE catledger_loans ADD CONSTRAINT ck_catledger_loans_schedule CHECK (
    ((schedule_method IS NULL AND schedule_terms IS NULL AND measurement_kind IS NULL)
      OR (schedule_method IS NOT NULL AND schedule_terms IS NOT NULL AND measurement_kind IS NOT NULL))
    AND (schedule_method IS NULL OR schedule_method IN (''flat'',''equal_payment'',''equal_principal'',''interest_only''))
    AND (schedule_terms IS NULL OR schedule_terms BETWEEN 1 AND 600)
    AND (measurement_kind IS NULL
      OR (measurement_kind=''rate'' AND quote_type IS NOT NULL AND rate_ppm IS NOT NULL AND repayment_minor IS NULL)
      OR (measurement_kind=''repayment'' AND repayment_minor IS NOT NULL AND quote_type IS NULL AND rate_ppm IS NULL))
    AND (quote_type IS NULL OR quote_type IN (''annual'',''monthly'',''daily'',''installment''))
    AND (quote_type IS NULL OR quote_type<>''installment'' OR schedule_method=''flat'')
    AND (fee_upfront_minor IS NULL OR baseline_principal_minor IS NULL OR fee_upfront_minor < baseline_principal_minor)
  )', 'SELECT 1');
PREPARE catledger_schedule_check_stmt FROM @catledger_schedule_check_sql;
EXECUTE catledger_schedule_check_stmt;
DEALLOCATE PREPARE catledger_schedule_check_stmt;
