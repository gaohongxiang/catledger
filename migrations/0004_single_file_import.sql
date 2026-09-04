CREATE TABLE IF NOT EXISTS catledger_import_files (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  import_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  declared_size BIGINT UNSIGNED NOT NULL,
  actual_size BIGINT UNSIGNED DEFAULT NULL,
  file_extension VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime_type VARCHAR(127) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  storage_object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cloud_file_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  content_deleted_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, import_id),
  UNIQUE KEY uk_catledger_import_file_object (uid, storage_object_key),
  UNIQUE KEY uk_catledger_import_file_content (uid, content_sha256),
  KEY idx_catledger_import_files_state (uid, state, updated_at, import_id),
  KEY idx_catledger_import_files_cleanup (state, content_deleted_at, updated_at),
  CONSTRAINT fk_catledger_import_file_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_source_profiles (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  masked_display_name VARCHAR(128) DEFAULT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, source_profile_id),
  UNIQUE KEY uk_catledger_source_profile_key (uid, source_type, profile_key),
  KEY idx_catledger_source_profiles_seen (uid, source_type, last_seen_at),
  CONSTRAINT fk_catledger_source_profile_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_batches (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  import_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_format VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parser_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parser_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  normalization_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  raw_snapshot_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parse_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  statement_start_local DATE DEFAULT NULL,
  statement_end_local DATE DEFAULT NULL,
  timezone_offset_minutes SMALLINT DEFAULT NULL,
  total_row_count INT UNSIGNED NOT NULL DEFAULT 0,
  valid_row_count INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_row_count INT UNSIGNED NOT NULL DEFAULT 0,
  pending_row_count INT UNSIGNED NOT NULL DEFAULT 0,
  posted_row_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, batch_id),
  UNIQUE KEY uk_catledger_import_batch_parse (uid, import_id, parse_fingerprint),
  KEY idx_catledger_import_batches_file (uid, import_id, created_at),
  KEY idx_catledger_import_batches_state (uid, state, updated_at),
  CONSTRAINT fk_catledger_import_batch_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_batch_file
    FOREIGN KEY (uid, import_id)
    REFERENCES catledger_import_files (uid, import_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_batch_profile
    FOREIGN KEY (uid, source_profile_id)
    REFERENCES catledger_import_source_profiles (uid, source_profile_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_source_identities (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  core_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  core_digest_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, identity_id),
  UNIQUE KEY uk_catledger_source_identity_key (uid, source_type, identity_key),
  KEY idx_catledger_source_identities_profile (uid, source_profile_id, last_seen_at),
  CONSTRAINT fk_catledger_source_identity_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_source_identity_profile
    FOREIGN KEY (uid, source_profile_id)
    REFERENCES catledger_import_source_profiles (uid, source_profile_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_rows (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  row_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  source_row_number INT UNSIGNED NOT NULL,
  source_locator VARCHAR(255) NOT NULL,
  parse_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processing_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_time_raw VARCHAR(64) DEFAULT NULL,
  amount_raw VARCHAR(64) DEFAULT NULL,
  direction_raw VARCHAR(32) DEFAULT NULL,
  status_raw VARCHAR(128) DEFAULT NULL,
  transaction_type_raw VARCHAR(128) DEFAULT NULL,
  counterparty_raw VARCHAR(255) DEFAULT NULL,
  item_raw VARCHAR(255) DEFAULT NULL,
  payment_method_raw VARCHAR(255) DEFAULT NULL,
  note_raw VARCHAR(1024) DEFAULT NULL,
  source_transaction_id_raw VARCHAR(255) DEFAULT NULL,
  source_order_id_raw VARCHAR(255) DEFAULT NULL,
  source_merchant_order_id_raw VARCHAR(255) DEFAULT NULL,
  normalized_local_date DATE DEFAULT NULL,
  normalized_local_at DATETIME(3) DEFAULT NULL,
  normalized_utc_at DATETIME(3) DEFAULT NULL,
  timezone_offset_minutes SMALLINT DEFAULT NULL,
  normalized_amount_minor BIGINT UNSIGNED DEFAULT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CNY',
  normalized_direction VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  normalized_transaction_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  economic_effect VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_method_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  category_evidence_json JSON NOT NULL,
  observed_identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  observed_core_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  primary_issue_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  issues_json JSON NOT NULL,
  raw_fields_json JSON NOT NULL,
  raw_snapshot_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parser_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  normalization_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, row_id),
  UNIQUE KEY uk_catledger_import_row_number (uid, batch_id, source_row_number),
  KEY idx_catledger_import_rows_review
    (uid, batch_id, processing_state, source_row_number),
  KEY idx_catledger_import_rows_identity (uid, identity_id),
  CONSTRAINT fk_catledger_import_row_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_row_batch
    FOREIGN KEY (uid, batch_id)
    REFERENCES catledger_import_batches (uid, batch_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_row_identity
    FOREIGN KEY (uid, identity_id)
    REFERENCES catledger_source_identities (uid, identity_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_economic_events (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_core_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, event_id),
  KEY idx_catledger_events_batch (uid, batch_id, state, event_id),
  CONSTRAINT fk_catledger_economic_event_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_economic_event_batch
    FOREIGN KEY (uid, batch_id)
    REFERENCES catledger_import_batches (uid, batch_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_event_evidence (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  row_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, event_id, row_id, evidence_role),
  KEY idx_catledger_event_evidence_row (uid, row_id, event_id),
  CONSTRAINT fk_catledger_event_evidence_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_evidence_event
    FOREIGN KEY (uid, event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_evidence_row
    FOREIGN KEY (uid, row_id)
    REFERENCES catledger_import_rows (uid, row_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_account_mappings (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mapping_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_method_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_method_hint VARCHAR(128) DEFAULT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, mapping_id),
  UNIQUE KEY uk_catledger_import_account_mapping
    (uid, source_type, payment_method_key),
  KEY idx_catledger_import_account_mapping_account (uid, account_id),
  CONSTRAINT fk_catledger_import_account_mapping_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_account_mapping_account
    FOREIGN KEY (uid, account_id)
    REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_category_mappings (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mapping_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  alias_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  alias_key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, mapping_id),
  UNIQUE KEY uk_catledger_import_category_mapping
    (uid, source_type, alias_key),
  KEY idx_catledger_import_category_mapping_category (uid, category_id),
  CONSTRAINT fk_catledger_import_category_mapping_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_category_mapping_category
    FOREIGN KEY (uid, category_id)
    REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_decisions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision_version INT UNSIGNED NOT NULL,
  disposition VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision_origin VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  decision_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, decision_id),
  UNIQUE KEY uk_catledger_import_decision_version (uid, event_id, decision_version),
  KEY idx_catledger_import_decisions_account (uid, account_id),
  KEY idx_catledger_import_decisions_category (uid, category_id),
  CONSTRAINT fk_catledger_import_decision_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_decision_event
    FOREIGN KEY (uid, event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_decision_account
    FOREIGN KEY (uid, account_id)
    REFERENCES catledger_accounts (uid, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_decision_category
    FOREIGN KEY (uid, category_id)
    REFERENCES catledger_categories (uid, category_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_postings (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  posting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  import_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selected_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_transaction_count INT UNSIGNED NOT NULL DEFAULT 0,
  reused_transaction_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, posting_id),
  UNIQUE KEY uk_catledger_import_posting_request (uid, import_id, request_digest),
  KEY idx_catledger_import_postings_state (uid, state, updated_at),
  CONSTRAINT fk_catledger_import_posting_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_posting_file
    FOREIGN KEY (uid, import_id)
    REFERENCES catledger_import_files (uid, import_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_transaction_links (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  posting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  row_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creation_method VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, link_id),
  UNIQUE KEY uk_catledger_import_transaction_relation
    (uid, row_id, transaction_id, relation_role),
  KEY idx_catledger_import_transaction_links_tx (uid, transaction_id),
  KEY idx_catledger_import_transaction_links_event (uid, event_id),
  KEY idx_catledger_import_transaction_links_posting (uid, posting_id),
  CONSTRAINT fk_catledger_import_transaction_link_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_transaction_link_posting
    FOREIGN KEY (uid, posting_id)
    REFERENCES catledger_import_postings (uid, posting_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_transaction_link_event
    FOREIGN KEY (uid, event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_transaction_link_row
    FOREIGN KEY (uid, row_id)
    REFERENCES catledger_import_rows (uid, row_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_transaction_link_transaction
    FOREIGN KEY (uid, transaction_id)
    REFERENCES catledger_transactions (uid, transaction_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
