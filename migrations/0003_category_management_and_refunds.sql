SET @catledger_category_normalized_name_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_categories'
     AND column_name = 'normalized_name'
);
SET @catledger_category_normalized_name_sql = IF(
  @catledger_category_normalized_name_exists = 0,
  'ALTER TABLE catledger_categories ADD COLUMN normalized_name VARCHAR(128) NULL AFTER name',
  'SELECT 1'
);
PREPARE catledger_category_normalized_name_statement FROM @catledger_category_normalized_name_sql;
EXECUTE catledger_category_normalized_name_statement;
DEALLOCATE PREPARE catledger_category_normalized_name_statement;

UPDATE catledger_categories
   SET normalized_name = LOWER(TRIM(name))
 WHERE normalized_name IS NULL OR normalized_name = '';

SET @catledger_category_normalized_name_nullable = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_categories'
     AND column_name = 'normalized_name' AND is_nullable = 'YES'
);
SET @catledger_category_normalized_name_not_null_sql = IF(
  @catledger_category_normalized_name_nullable = 1,
  'ALTER TABLE catledger_categories MODIFY COLUMN normalized_name VARCHAR(128) NOT NULL',
  'SELECT 1'
);
PREPARE catledger_category_normalized_name_not_null_statement FROM @catledger_category_normalized_name_not_null_sql;
EXECUTE catledger_category_normalized_name_not_null_statement;
DEALLOCATE PREPARE catledger_category_normalized_name_not_null_statement;

SET @catledger_category_version_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_categories'
     AND column_name = 'version'
);
SET @catledger_category_version_sql = IF(
  @catledger_category_version_exists = 0,
  'ALTER TABLE catledger_categories ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER is_system_default',
  'SELECT 1'
);
PREPARE catledger_category_version_statement FROM @catledger_category_version_sql;
EXECUTE catledger_category_version_statement;
DEALLOCATE PREPARE catledger_category_version_statement;

SET @catledger_category_active_name_key_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_categories'
     AND column_name = 'active_name_key'
);
SET @catledger_category_active_name_key_sql = IF(
  @catledger_category_active_name_key_exists = 0,
  'ALTER TABLE catledger_categories ADD COLUMN active_name_key VARCHAR(128) GENERATED ALWAYS AS (CASE WHEN archived_at IS NULL THEN normalized_name ELSE NULL END) STORED AFTER archived_at',
  'SELECT 1'
);
PREPARE catledger_category_active_name_key_statement FROM @catledger_category_active_name_key_sql;
EXECUTE catledger_category_active_name_key_statement;
DEALLOCATE PREPARE catledger_category_active_name_key_statement;

SET @catledger_category_active_name_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'catledger_categories'
     AND index_name = 'uk_catledger_category_active_name'
);
SET @catledger_category_active_name_index_sql = IF(
  @catledger_category_active_name_index_exists = 0,
  'ALTER TABLE catledger_categories ADD UNIQUE KEY uk_catledger_category_active_name (uid, kind, active_name_key)',
  'SELECT 1'
);
PREPARE catledger_category_active_name_index_statement FROM @catledger_category_active_name_index_sql;
EXECUTE catledger_category_active_name_index_statement;
DEALLOCATE PREPARE catledger_category_active_name_index_statement;

SET @catledger_transaction_original_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_transactions'
     AND column_name = 'original_transaction_id'
);
SET @catledger_transaction_original_sql = IF(
  @catledger_transaction_original_exists = 0,
  'ALTER TABLE catledger_transactions ADD COLUMN original_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER category_id',
  'SELECT 1'
);
PREPARE catledger_transaction_original_statement FROM @catledger_transaction_original_sql;
EXECUTE catledger_transaction_original_statement;
DEALLOCATE PREPARE catledger_transaction_original_statement;

SET @catledger_transaction_original_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'catledger_transactions'
     AND index_name = 'idx_catledger_transactions_original'
);
SET @catledger_transaction_original_index_sql = IF(
  @catledger_transaction_original_index_exists = 0,
  'ALTER TABLE catledger_transactions ADD KEY idx_catledger_transactions_original (uid, original_transaction_id, deleted_at)',
  'SELECT 1'
);
PREPARE catledger_transaction_original_index_statement FROM @catledger_transaction_original_index_sql;
EXECUTE catledger_transaction_original_index_statement;
DEALLOCATE PREPARE catledger_transaction_original_index_statement;

SET @catledger_transaction_original_fk_exists = (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE constraint_schema = DATABASE() AND table_name = 'catledger_transactions'
     AND constraint_name = 'fk_catledger_transaction_original'
     AND constraint_type = 'FOREIGN KEY'
);
SET @catledger_transaction_original_fk_sql = IF(
  @catledger_transaction_original_fk_exists = 0,
  'ALTER TABLE catledger_transactions ADD CONSTRAINT fk_catledger_transaction_original FOREIGN KEY (uid, original_transaction_id) REFERENCES catledger_transactions (uid, transaction_id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE catledger_transaction_original_fk_statement FROM @catledger_transaction_original_fk_sql;
EXECUTE catledger_transaction_original_fk_statement;
DEALLOCATE PREPARE catledger_transaction_original_fk_statement;
