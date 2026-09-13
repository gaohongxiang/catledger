-- MINI-1908A：完整来源组占用与更正审计；原交易及来源原文不物理删除。
CREATE TABLE IF NOT EXISTS catledger_loan_payment_sources (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  original_event_json JSON DEFAULT NULL,
  original_links_json JSON NOT NULL,
  applied_event_version BIGINT UNSIGNED DEFAULT NULL,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  active_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN active=1 THEN event_id ELSE NULL END) STORED,
  PRIMARY KEY (uid,payment_id),
  UNIQUE KEY uk_catledger_loan_source_event (uid,active_event_id),
  CONSTRAINT fk_catledger_loan_source_payment FOREIGN KEY (uid,payment_id) REFERENCES catledger_loan_payments (uid,payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_source_update FOREIGN KEY (uid,update_id) REFERENCES catledger_finance_updates (uid,update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_source_event FOREIGN KEY (uid,event_id) REFERENCES catledger_economic_events (uid,event_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_loan_source_active CHECK (active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_replaced_transactions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deleted_version BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (uid,payment_id,transaction_id),
  CONSTRAINT fk_catledger_loan_replaced_payment FOREIGN KEY (uid,payment_id) REFERENCES catledger_loan_payments (uid,payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_replaced_transaction FOREIGN KEY (uid,transaction_id) REFERENCES catledger_transactions (uid,transaction_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_loan_payment_corrections (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  previous_payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (uid,payment_id),
  UNIQUE KEY uk_catledger_loan_correction_previous (uid,previous_payment_id),
  CONSTRAINT fk_catledger_loan_correction_payment FOREIGN KEY (uid,payment_id) REFERENCES catledger_loan_payments (uid,payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_loan_correction_previous FOREIGN KEY (uid,previous_payment_id) REFERENCES catledger_loan_payments (uid,payment_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
