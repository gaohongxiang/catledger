-- 实际付款已确认，贷款关系可以明确暂缓；不回填历史转账。
CREATE TABLE IF NOT EXISTS catledger_loan_repayment_details (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  liability_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_minor BIGINT UNSIGNED NOT NULL,
  interest_minor BIGINT UNSIGNED NOT NULL,
  fee_minor BIGINT UNSIGNED NOT NULL,
  interest_treatment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fee_treatment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  interest_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  fee_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  PRIMARY KEY (uid, payment_id),
  KEY idx_catledger_repayment_account (uid, liability_account_id, payment_id),
  CONSTRAINT fk_catledger_repayment_payment FOREIGN KEY (uid, payment_id) REFERENCES catledger_loan_payments (uid, payment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_repayment_account FOREIGN KEY (uid, liability_account_id) REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_repayment_interest FOREIGN KEY (uid, interest_category_id) REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_repayment_fee FOREIGN KEY (uid, fee_category_id) REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT,
  CONSTRAINT ck_catledger_repayment_treatment CHECK (interest_treatment IN ('expense','accrued') AND fee_treatment IN ('expense','accrued'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
