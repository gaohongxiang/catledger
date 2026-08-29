SET @catledger_category_scope_index_exists = (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'catledger_categories'
     AND index_name = 'uk_catledger_category_scope'
);

SET @catledger_category_scope_index_sql = IF(
  @catledger_category_scope_index_exists = 0,
  'ALTER TABLE catledger_categories ADD UNIQUE KEY uk_catledger_category_scope (uid, category_id)',
  'SELECT 1'
);

PREPARE catledger_category_scope_index_statement
  FROM @catledger_category_scope_index_sql;
EXECUTE catledger_category_scope_index_statement;
DEALLOCATE PREPARE catledger_category_scope_index_statement;

CREATE TABLE IF NOT EXISTS catledger_accounts (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nature VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(32) NOT NULL,
  normalized_name VARCHAR(64) NOT NULL,
  archived_at DATETIME(3) DEFAULT NULL,
  active_name_key VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE WHEN archived_at IS NULL THEN normalized_name ELSE NULL END
    ) STORED,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CNY',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, account_id),
  UNIQUE KEY uk_catledger_account_active_name (uid, active_name_key),
  KEY idx_catledger_accounts_status (uid, archived_at, nature, created_at),
  CONSTRAINT fk_catledger_account_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_transactions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  destination_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  occurred_local_date DATE NOT NULL,
  occurred_local_at DATETIME(3) NOT NULL,
  timezone_offset_minutes SMALLINT NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  note VARCHAR(200) DEFAULT NULL,
  origin VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  deleted_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, transaction_id),
  KEY idx_catledger_transactions_month_cursor
    (uid, occurred_local_date, deleted_at, occurred_local_at, transaction_id),
  KEY idx_catledger_transactions_source
    (uid, source_account_id, deleted_at, occurred_local_at),
  KEY idx_catledger_transactions_destination
    (uid, destination_account_id, deleted_at, occurred_local_at),
  KEY idx_catledger_transactions_category
    (uid, category_id, deleted_at, occurred_local_at),
  CONSTRAINT fk_catledger_transaction_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_transaction_source_account
    FOREIGN KEY (uid, source_account_id)
    REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_transaction_destination_account
    FOREIGN KEY (uid, destination_account_id)
    REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_transaction_category
    FOREIGN KEY (uid, category_id)
    REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_mutation_receipts (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, idempotency_key_digest),
  KEY idx_catledger_mutation_receipts_created (uid, created_at),
  CONSTRAINT fk_catledger_mutation_receipt_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
