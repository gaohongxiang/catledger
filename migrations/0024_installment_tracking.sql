-- MINI-1914：连续进度不是伪造的银行付款；实际费用仍由 Transaction 记账。
SET @has_progress = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='progress_json');
SET @progress_sql = IF(@has_progress=0,'ALTER TABLE catledger_loans ADD COLUMN progress_json JSON DEFAULT NULL, ADD COLUMN archived_at DATETIME(3) DEFAULT NULL','SELECT 1');
PREPARE progress_stmt FROM @progress_sql;
EXECUTE progress_stmt;
DEALLOCATE PREPARE progress_stmt;

CREATE TABLE IF NOT EXISTS catledger_installment_bindings (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reference_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (uid,account_id,reference_key),
  KEY idx_installment_binding_loan (uid,loan_id),
  CONSTRAINT fk_installment_binding_account FOREIGN KEY (uid,account_id) REFERENCES catledger_accounts(uid,account_id),
  CONSTRAINT fk_installment_binding_loan FOREIGN KEY (uid,loan_id) REFERENCES catledger_loans(uid,loan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_installment_items (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  reference_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  reference_label VARCHAR(120) DEFAULT NULL,
  period_number INT UNSIGNED NOT NULL,
  total_terms INT UNSIGNED DEFAULT NULL,
  component VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  occurred_date DATE NOT NULL,
  origin VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  source_identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  canonical TINYINT UNSIGNED NOT NULL DEFAULT 1,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  canonical_loan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN canonical=1 AND active=1 THEN loan_id ELSE NULL END) STORED,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid,item_id),
  UNIQUE KEY uk_installment_source_event (uid,source_event_id),
  UNIQUE KEY uk_installment_source_identity (uid,source_identity_id),
  UNIQUE KEY uk_installment_component (uid,canonical_loan_id,period_number,component),
  KEY idx_installment_loan_period (uid,loan_id,period_number),
  KEY idx_installment_pending (uid,account_id,loan_id,created_at,item_id),
  KEY idx_installment_reference (uid,account_id,reference_key),
  KEY idx_installment_transaction (uid,transaction_id),
  CONSTRAINT fk_installment_item_account FOREIGN KEY (uid,account_id) REFERENCES catledger_accounts(uid,account_id),
  CONSTRAINT fk_installment_item_loan FOREIGN KEY (uid,loan_id) REFERENCES catledger_loans(uid,loan_id),
  CONSTRAINT fk_installment_item_event FOREIGN KEY (uid,source_event_id) REFERENCES catledger_economic_events(uid,event_id),
  CONSTRAINT fk_installment_item_identity FOREIGN KEY (uid,source_identity_id) REFERENCES catledger_source_identities(uid,identity_id),
  CONSTRAINT fk_installment_item_transaction FOREIGN KEY (uid,transaction_id) REFERENCES catledger_transactions(uid,transaction_id),
  CONSTRAINT ck_installment_item_period CHECK (period_number BETWEEN 1 AND 600 AND (total_terms IS NULL OR total_terms BETWEEN period_number AND 600)),
  CONSTRAINT ck_installment_item_component CHECK (component IN ('principal','interest','fee')),
  CONSTRAINT ck_installment_item_origin CHECK (origin IN ('manual','import')),
  CONSTRAINT ck_installment_item_state CHECK (active IN (0,1) AND canonical IN (0,1)),
  CONSTRAINT ck_installment_item_amount CHECK (amount_minor>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
