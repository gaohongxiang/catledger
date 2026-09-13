-- MINI-1908A：实际借还关联现有正式交易；未知构成不能写成全本金。
CREATE TABLE IF NOT EXISTS catledger_loan_payments (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  asset_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  total_minor BIGINT UNSIGNED NOT NULL,
  occurred_local_at DATETIME(3) NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  timezone_offset_minutes SMALLINT NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, payment_id),
  KEY idx_catledger_loan_payments_time (uid, occurred_local_at, payment_id),
  CONSTRAINT fk_catledger_loan_payments_user FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_payments_asset FOREIGN KEY (uid, asset_account_id) REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_loan_payment_total CHECK (total_minor > 0),
  CONSTRAINT ck_catledger_loan_payment_kind CHECK (kind IN ('drawdown','repayment')),
  CONSTRAINT ck_catledger_loan_payment_status CHECK (status IN ('active','reversed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_payment_allocations (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_minor BIGINT UNSIGNED NOT NULL,
  interest_minor BIGINT UNSIGNED NOT NULL,
  fee_minor BIGINT UNSIGNED NOT NULL,
  interest_treatment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fee_treatment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  interest_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  fee_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  confirmed_loan_version BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (uid, payment_id, loan_id),
  KEY idx_catledger_loan_allocations_loan (uid, loan_id, payment_id),
  CONSTRAINT fk_catledger_loan_allocations_payment FOREIGN KEY (uid, payment_id) REFERENCES catledger_loan_payments (uid, payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_allocations_loan FOREIGN KEY (uid, loan_id) REFERENCES catledger_loans (uid, loan_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_allocations_interest FOREIGN KEY (uid, interest_category_id) REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_allocations_fee FOREIGN KEY (uid, fee_category_id) REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_loan_allocations_treatment CHECK (interest_treatment IN ('expense','accrued') AND fee_treatment IN ('expense','accrued'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_payment_transactions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_version BIGINT UNSIGNED NOT NULL,
  created_by_payment TINYINT UNSIGNED NOT NULL,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  active_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN active=1 THEN transaction_id ELSE NULL END) STORED,
  PRIMARY KEY (uid, payment_id, transaction_id),
  UNIQUE KEY uk_catledger_loan_transaction_active (uid, active_transaction_id),
  KEY idx_catledger_loan_transaction (uid, transaction_id, active),
  CONSTRAINT fk_catledger_loan_transactions_payment FOREIGN KEY (uid, payment_id) REFERENCES catledger_loan_payments (uid, payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_transactions_transaction FOREIGN KEY (uid, transaction_id) REFERENCES catledger_transactions (uid, transaction_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_loan_transaction_flags CHECK (active IN (0,1) AND created_by_payment IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
