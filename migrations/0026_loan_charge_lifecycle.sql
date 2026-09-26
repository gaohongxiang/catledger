-- LOAN-LIFECYCLE A1：只增加持久关系；旧贷款无授权，迁移不生成任何交易。
CREATE TABLE IF NOT EXISTS catledger_loan_charge_contracts (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reference_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  origin_kind VARCHAR(24) NOT NULL,
  plan_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  authorization_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,contract_id),
  UNIQUE KEY uk_charge_contract_loan (uid,loan_id),
  UNIQUE KEY uk_charge_contract_reference (uid,account_id,reference_key),
  FOREIGN KEY (uid,loan_id) REFERENCES catledger_loans(uid,loan_id),
  FOREIGN KEY (uid,account_id) REFERENCES catledger_accounts(uid,account_id),
  CHECK (origin_kind IN ('cash_borrowing','recorded_consumption','new_consumption','historical'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_charges (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  component VARCHAR(12) NOT NULL,
  period_number INT UNSIGNED DEFAULT NULL,
  charge_date DATE NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'planned',
  basis VARCHAR(16) NOT NULL DEFAULT 'plan',
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  covered_by_charge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  plan_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,charge_id),
  UNIQUE KEY uk_charge_identity (uid,contract_id,charge_key),
  UNIQUE KEY uk_charge_transaction (uid,transaction_id),
  KEY idx_charge_due (uid,state,charge_date,charge_id),
  FOREIGN KEY (uid,contract_id) REFERENCES catledger_loan_charge_contracts(uid,contract_id),
  FOREIGN KEY (uid,category_id) REFERENCES catledger_categories(uid,category_id),
  FOREIGN KEY (uid,transaction_id) REFERENCES catledger_transactions(uid,transaction_id),
  FOREIGN KEY (uid,covered_by_charge_id) REFERENCES catledger_loan_charges(uid,charge_id),
  CHECK (component IN ('interest','fee')),
  CHECK (state IN ('planned','recorded','baseline','covered','suppressed','paused','cancelled')),
  CHECK (basis IN ('plan','actual','baseline','manual')),
  CHECK (period_number IS NULL OR period_number BETWEEN 1 AND 600),
  CHECK (amount_minor>0),
  CHECK (state<>'recorded' OR transaction_id IS NOT NULL),
  CHECK (state<>'covered' OR covered_by_charge_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_charge_sources (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,charge_id,item_id),
  UNIQUE KEY uk_charge_source (uid,item_id),
  FOREIGN KEY (uid,charge_id) REFERENCES catledger_loan_charges(uid,charge_id),
  FOREIGN KEY (uid,item_id) REFERENCES catledger_installment_items(uid,item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_charge_allocations (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,payment_id,charge_id),
  FOREIGN KEY (uid,payment_id) REFERENCES catledger_loan_payments(uid,payment_id),
  FOREIGN KEY (uid,charge_id) REFERENCES catledger_loan_charges(uid,charge_id),
  CHECK (amount_minor>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_charge_audit (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  charge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,audit_id),
  KEY idx_charge_audit (uid,contract_id,created_at),
  FOREIGN KEY (uid,contract_id) REFERENCES catledger_loan_charge_contracts(uid,contract_id),
  FOREIGN KEY (uid,charge_id) REFERENCES catledger_loan_charges(uid,charge_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
