CREATE TABLE IF NOT EXISTS catledger_finance_update_account_drafts (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(64) NOT NULL,
  normalized_name VARCHAR(64) NOT NULL,
  type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nature VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CNY',
  action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  materialized_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, draft_account_id),
  UNIQUE KEY uk_catledger_finance_update_account_draft_name
    (uid, update_id, normalized_name),
  CONSTRAINT fk_catledger_finance_update_account_draft_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_account_draft_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_account_draft_action
    FOREIGN KEY (uid, action_id)
    REFERENCES catledger_finance_actions (uid, action_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_finance_update_account_mapping_drafts (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_mapping_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_method_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_method_hint VARCHAR(128) DEFAULT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, draft_mapping_id),
  UNIQUE KEY uk_catledger_update_account_mapping_draft
    (uid, update_id, event_id, source_type, payment_method_key),
  KEY idx_catledger_update_account_mapping_draft_event
    (uid, update_id, event_id),
  KEY idx_catledger_update_account_mapping_draft_account
    (uid, account_id),
  CONSTRAINT fk_catledger_update_account_mapping_draft_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_update_account_mapping_draft_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_update_account_mapping_draft_event
    FOREIGN KEY (uid, event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE CASCADE,
  CONSTRAINT fk_catledger_update_account_mapping_draft_action
    FOREIGN KEY (uid, action_id)
    REFERENCES catledger_finance_actions (uid, action_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
