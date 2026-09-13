-- MINI-1908A: 贷款明细不是另一份总账；资料创建不产生交易。
CREATE TABLE IF NOT EXISTS catledger_loans (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  institution VARCHAR(80) DEFAULT NULL,
  kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  baseline_principal_minor BIGINT UNSIGNED DEFAULT NULL,
  baseline_date DATE DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  end_date DATE DEFAULT NULL,
  repayment_method VARCHAR(80) DEFAULT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, loan_id),
  KEY idx_catledger_loans_created (uid, created_at, loan_id),
  KEY idx_catledger_loans_account (uid, account_id),
  CONSTRAINT fk_catledger_loans_user FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loans_account FOREIGN KEY (uid, account_id) REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_loans_baseline CHECK ((baseline_principal_minor IS NULL AND baseline_date IS NULL) OR (baseline_principal_minor IS NOT NULL AND baseline_date IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
