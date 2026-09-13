-- 确认计划与实际付款保持独立；无未来 Transaction。
CREATE TABLE IF NOT EXISTS catledger_loan_periods (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_number INT UNSIGNED NOT NULL,
  due_date DATE NOT NULL,
  principal_minor BIGINT UNSIGNED NOT NULL,
  interest_minor BIGINT UNSIGNED NOT NULL,
  fee_minor BIGINT UNSIGNED NOT NULL,
  cancelled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,period_id),
  UNIQUE KEY uk_loan_period_number (uid,loan_id,period_number),
  UNIQUE KEY uk_loan_period_scope (uid,loan_id,period_id),
  KEY idx_loan_period_due (uid,loan_id,due_date,period_id),
  CONSTRAINT fk_loan_period_loan FOREIGN KEY (uid,loan_id) REFERENCES catledger_loans (uid,loan_id) ON DELETE RESTRICT,
  CONSTRAINT ck_loan_period_number CHECK (period_number BETWEEN 1 AND 9999),
  CONSTRAINT ck_loan_period_cancelled CHECK (cancelled IN (0,1)),
  CONSTRAINT ck_loan_period_amount CHECK (principal_minor>0 OR interest_minor>0 OR fee_minor>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_period_revisions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  snapshot_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,period_id,version),
  CONSTRAINT fk_loan_period_revision FOREIGN KEY (uid,period_id) REFERENCES catledger_loan_periods (uid,period_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_period_allocations (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  allocation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_minor BIGINT UNSIGNED NOT NULL,
  interest_minor BIGINT UNSIGNED NOT NULL,
  fee_minor BIGINT UNSIGNED NOT NULL,
  confirmed_period_version BIGINT UNSIGNED NOT NULL,
  confirmed_payment_version BIGINT UNSIGNED NOT NULL,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  active_period_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN active=1 THEN period_id ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,allocation_id),
  UNIQUE KEY uk_loan_period_allocation_active (uid,payment_id,loan_id,active_period_id),
  KEY idx_loan_period_allocation_period (uid,period_id,created_at,allocation_id),
  KEY idx_loan_period_paid (uid,period_id,active),
  KEY idx_loan_period_payment_active (uid,payment_id,active,period_id),
  CONSTRAINT fk_loan_period_allocation_period FOREIGN KEY (uid,loan_id,period_id) REFERENCES catledger_loan_periods (uid,loan_id,period_id) ON DELETE RESTRICT,
  CONSTRAINT fk_loan_period_allocation_payment FOREIGN KEY (uid,payment_id,loan_id) REFERENCES catledger_loan_payment_allocations (uid,payment_id,loan_id) ON DELETE RESTRICT,
  CONSTRAINT ck_loan_period_allocation_active CHECK (active IN (0,1)),
  CONSTRAINT ck_loan_period_allocation_amount CHECK (principal_minor>0 OR interest_minor>0 OR fee_minor>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
