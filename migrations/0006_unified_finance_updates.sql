CREATE TABLE IF NOT EXISTS catledger_finance_updates (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  plan_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  source_count INT UNSIGNED NOT NULL DEFAULT 0,
  valid_evidence_count INT UNSIGNED NOT NULL DEFAULT 0,
  duplicate_evidence_count INT UNSIGNED NOT NULL DEFAULT 0,
  final_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  posted_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  ready_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  needs_action_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  excluded_event_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, update_id),
  KEY idx_catledger_finance_updates_status (uid, status, updated_at, update_id),
  CONSTRAINT fk_catledger_finance_update_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_finance_update_sources (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_order INT UNSIGNED NOT NULL,
  import_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  source_type_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_format_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parser_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  normalization_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_name_snapshot VARCHAR(255) NOT NULL,
  file_content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  total_row_count INT UNSIGNED NOT NULL,
  valid_row_count INT UNSIGNED NOT NULL,
  invalid_row_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, source_id),
  UNIQUE KEY uk_catledger_finance_update_source_batch (uid, update_id, batch_id),
  UNIQUE KEY uk_catledger_finance_update_source_order (uid, update_id, source_order),
  KEY idx_catledger_finance_update_source_import (uid, import_id, created_at),
  KEY idx_catledger_finance_update_source_batch (uid, batch_id, created_at),
  CONSTRAINT fk_catledger_finance_update_source_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_source_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_source_file
    FOREIGN KEY (uid, import_id)
    REFERENCES catledger_import_files (uid, import_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_source_batch_ref
    FOREIGN KEY (uid, batch_id)
    REFERENCES catledger_import_batches (uid, batch_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_source_profile
    FOREIGN KEY (uid, source_profile_id)
    REFERENCES catledger_import_source_profiles (uid, source_profile_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @catledger_event_update_id_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_economic_events' AND column_name = 'update_id'
);
SET @catledger_event_update_id_sql := IF(
  @catledger_event_update_id_exists = 0,
  'ALTER TABLE catledger_economic_events ADD COLUMN update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER batch_id',
  'SELECT 1'
);
PREPARE catledger_event_update_id_statement FROM @catledger_event_update_id_sql;
EXECUTE catledger_event_update_id_statement;
DEALLOCATE PREPARE catledger_event_update_id_statement;

SET @catledger_event_domain_columns := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_economic_events' AND column_name = 'event_key'
);
SET @catledger_event_domain_columns_sql := IF(
  @catledger_event_domain_columns = 0,
  'ALTER TABLE catledger_economic_events ADD COLUMN event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER update_id, ADD COLUMN event_key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER event_key, ADD COLUMN status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER state, ADD COLUMN flow_direction VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER status, ADD COLUMN economic_nature VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER flow_direction, ADD COLUMN ledger_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER economic_nature, ADD COLUMN counterparty_ledger_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER ledger_account_id, ADD COLUMN event_local_date DATE DEFAULT NULL AFTER counterparty_ledger_account_id, ADD COLUMN event_local_at DATETIME(3) DEFAULT NULL AFTER event_local_date, ADD COLUMN event_utc_at DATETIME(3) DEFAULT NULL AFTER event_local_at, ADD COLUMN timezone_offset_minutes SMALLINT DEFAULT NULL AFTER event_utc_at, ADD COLUMN amount_minor BIGINT UNSIGNED DEFAULT NULL AFTER timezone_offset_minutes, ADD COLUMN currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER amount_minor, ADD COLUMN category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER currency, ADD COLUMN manual_field_mask BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER category_id, ADD COLUMN field_sources_json JSON DEFAULT NULL AFTER manual_field_mask, ADD COLUMN reason_codes_json JSON DEFAULT NULL AFTER field_sources_json',
  'SELECT 1'
);
PREPARE catledger_event_domain_columns_statement FROM @catledger_event_domain_columns_sql;
EXECUTE catledger_event_domain_columns_statement;
DEALLOCATE PREPARE catledger_event_domain_columns_statement;

SET @catledger_event_update_index_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'catledger_economic_events' AND index_name = 'uk_catledger_event_update_key'
);
SET @catledger_event_update_index_sql := IF(
  @catledger_event_update_index_exists = 0,
  'ALTER TABLE catledger_economic_events ADD UNIQUE KEY uk_catledger_event_update_key (uid, update_id, event_key), ADD KEY idx_catledger_events_update_status (uid, update_id, status, event_local_at, event_id)',
  'SELECT 1'
);
PREPARE catledger_event_update_index_statement FROM @catledger_event_update_index_sql;
EXECUTE catledger_event_update_index_statement;
DEALLOCATE PREPARE catledger_event_update_index_statement;

SET @catledger_evidence_update_id_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'catledger_event_evidence' AND column_name = 'update_id'
);
SET @catledger_evidence_update_id_sql := IF(
  @catledger_evidence_update_id_exists = 0,
  'ALTER TABLE catledger_event_evidence ADD COLUMN evidence_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER uid, ADD COLUMN update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER evidence_id, ADD COLUMN field_mask BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER evidence_role, ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER created_at, ADD UNIQUE KEY uk_catledger_event_evidence_id (uid, evidence_id), ADD UNIQUE KEY uk_catledger_event_evidence_update_row (uid, update_id, row_id), ADD KEY idx_catledger_event_evidence_update_event (uid, update_id, event_id)',
  'SELECT 1'
);
PREPARE catledger_evidence_update_id_statement FROM @catledger_evidence_update_id_sql;
EXECUTE catledger_evidence_update_id_statement;
DEALLOCATE PREPARE catledger_evidence_update_id_statement;

CREATE TABLE IF NOT EXISTS catledger_import_batch_issues (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_issue_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  severity VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_locator VARCHAR(255) NOT NULL DEFAULT '',
  details_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, batch_issue_id),
  UNIQUE KEY uk_catledger_import_batch_issue (uid, batch_id, issue_code, source_locator),
  KEY idx_catledger_import_batch_issues_batch (uid, batch_id, severity, batch_issue_id),
  CONSTRAINT fk_catledger_import_batch_issue_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_import_batch_issue_batch
    FOREIGN KEY (uid, batch_id)
    REFERENCES catledger_import_batches (uid, batch_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_economic_event_relations (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  source_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_minor BIGINT UNSIGNED DEFAULT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manual TINYINT(1) NOT NULL DEFAULT 0,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_codes_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, relation_id),
  UNIQUE KEY uk_catledger_event_relation_key (uid, relation_key),
  KEY idx_catledger_event_relations_source (uid, update_id, source_event_id, status),
  KEY idx_catledger_event_relations_target (uid, update_id, target_event_id, status),
  CONSTRAINT fk_catledger_event_relation_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_relation_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_relation_source
    FOREIGN KEY (uid, source_event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_relation_target
    FOREIGN KEY (uid, target_event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_economic_event_transactions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creation_method VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, link_id),
  UNIQUE KEY uk_catledger_event_transaction_role (uid, event_id, transaction_id, role),
  KEY idx_catledger_event_transactions_event (uid, update_id, event_id),
  KEY idx_catledger_event_transactions_tx (uid, transaction_id),
  CONSTRAINT fk_catledger_event_transaction_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_transaction_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_transaction_event
    FOREIGN KEY (uid, event_id)
    REFERENCES catledger_economic_events (uid, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_event_transaction_transaction
    FOREIGN KEY (uid, transaction_id)
    REFERENCES catledger_transactions (uid, transaction_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_finance_actions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_update_version BIGINT UNSIGNED NOT NULL,
  applied_update_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  action_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision_json JSON DEFAULT NULL,
  reason_codes_json JSON NOT NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  started_at DATETIME(3) DEFAULT NULL,
  completed_at DATETIME(3) DEFAULT NULL,
  failed_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, action_id),
  UNIQUE KEY uk_catledger_finance_action_key (uid, idempotency_key_digest),
  KEY idx_catledger_finance_actions_update (uid, update_id, created_at, action_id),
  KEY idx_catledger_finance_actions_status (uid, status, updated_at),
  CONSTRAINT fk_catledger_finance_action_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_action_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_review_issues (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  blocking TINYINT(1) NOT NULL DEFAULT 1,
  primary_reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  member_count INT UNSIGNED NOT NULL,
  candidate_count INT UNSIGNED NOT NULL DEFAULT 0,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_codes_json JSON NOT NULL,
  resolved_action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, issue_id),
  UNIQUE KEY uk_catledger_review_issue_key (uid, update_id, issue_key),
  KEY idx_catledger_review_issues_open (uid, update_id, status, blocking, issue_id),
  CONSTRAINT fk_catledger_review_issue_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_review_issue_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_review_issue_action
    FOREIGN KEY (uid, resolved_action_id)
    REFERENCES catledger_finance_actions (uid, action_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_review_issue_members (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issue_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_version BIGINT UNSIGNED NOT NULL,
  member_role VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, member_id),
  UNIQUE KEY uk_catledger_review_issue_member (uid, issue_id, object_type, object_id, member_role),
  KEY idx_catledger_review_issue_members_issue (uid, update_id, issue_id, sort_order),
  CONSTRAINT fk_catledger_review_issue_member_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_review_issue_member_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_review_issue_member_issue
    FOREIGN KEY (uid, issue_id)
    REFERENCES catledger_review_issues (uid, issue_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_finance_update_postings (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  posting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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
  UNIQUE KEY uk_catledger_finance_update_posting_request (uid, update_id, request_digest),
  KEY idx_catledger_finance_update_postings_state (uid, state, updated_at),
  CONSTRAINT fk_catledger_finance_update_posting_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE RESTRICT,
  CONSTRAINT fk_catledger_finance_update_posting_update
    FOREIGN KEY (uid, update_id)
    REFERENCES catledger_finance_updates (uid, update_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO catledger_finance_updates
  (uid, update_id, status, version, plan_version, source_count,
   valid_evidence_count, duplicate_evidence_count, final_event_count,
   posted_event_count, ready_event_count, needs_action_event_count, excluded_event_count,
   created_at, updated_at)
SELECT f.uid, f.import_id, 'posted', 1, 'legacy-backfill-v1', COUNT(DISTINCT b.batch_id),
       COALESCE(SUM(b.valid_row_count), 0), 0,
       COUNT(DISTINCT e.event_id),
       COUNT(DISTINCT CASE WHEN e.state IN ('posted', 'linked') THEN e.event_id END),
       0, 0,
       COUNT(DISTINCT CASE WHEN e.state = 'ignored' THEN e.event_id END),
       f.created_at, f.updated_at
  FROM catledger_import_files f
  JOIN catledger_import_batches b
    ON b.uid = f.uid AND b.import_id = f.import_id AND b.state = 'committed'
  LEFT JOIN catledger_economic_events e
    ON e.uid = b.uid AND e.batch_id = b.batch_id
 WHERE f.state = 'committed'
 GROUP BY f.uid, f.import_id, f.created_at, f.updated_at;

INSERT IGNORE INTO catledger_finance_update_sources
  (uid, source_id, update_id, source_order, import_id, batch_id, source_profile_id,
   source_type_snapshot, source_format_snapshot, parser_version, normalization_version,
   identity_version, file_name_snapshot, file_content_sha256, total_row_count,
   valid_row_count, invalid_row_count, created_at)
SELECT ranked.uid, ranked.batch_id, ranked.import_id, ranked.source_order,
       ranked.import_id, ranked.batch_id, ranked.source_profile_id,
       ranked.source_type, ranked.source_format, ranked.parser_version,
       ranked.normalization_version, ranked.identity_version,
       ranked.original_file_name, ranked.content_sha256, ranked.total_row_count,
       ranked.valid_row_count, ranked.invalid_row_count, ranked.created_at
  FROM (
    SELECT b.*, f.original_file_name, f.content_sha256,
           ROW_NUMBER() OVER (PARTITION BY b.uid, b.import_id ORDER BY b.created_at, b.batch_id) - 1 AS source_order
      FROM catledger_import_batches b
      JOIN catledger_import_files f
        ON f.uid = b.uid AND f.import_id = b.import_id
     WHERE b.state = 'committed' AND f.state = 'committed' AND f.content_sha256 IS NOT NULL
  ) ranked;

UPDATE catledger_economic_events event_row
JOIN catledger_import_batches batch_row
  ON batch_row.uid = event_row.uid AND batch_row.batch_id = event_row.batch_id
JOIN catledger_import_files file_row
  ON file_row.uid = batch_row.uid AND file_row.import_id = batch_row.import_id
JOIN catledger_event_evidence evidence_row
  ON evidence_row.uid = event_row.uid AND evidence_row.event_id = event_row.event_id
 AND evidence_row.evidence_role = 'primary'
JOIN catledger_import_rows source_row
  ON source_row.uid = evidence_row.uid AND source_row.row_id = evidence_row.row_id
LEFT JOIN (
  SELECT decision_row.*
    FROM catledger_import_decisions decision_row
    JOIN (
      SELECT uid, event_id, MAX(decision_version) AS decision_version
        FROM catledger_import_decisions GROUP BY uid, event_id
    ) latest
      ON latest.uid = decision_row.uid AND latest.event_id = decision_row.event_id
     AND latest.decision_version = decision_row.decision_version
) decision_row
  ON decision_row.uid = event_row.uid AND decision_row.event_id = event_row.event_id
LEFT JOIN catledger_import_transaction_links legacy_link
  ON legacy_link.uid = event_row.uid AND legacy_link.event_id = event_row.event_id
LEFT JOIN catledger_transactions transaction_row
  ON transaction_row.uid = legacy_link.uid AND transaction_row.transaction_id = legacy_link.transaction_id
 SET event_row.update_id = file_row.import_id,
     event_row.event_key = SHA2(CONCAT('legacy-event-v1:', event_row.event_id), 256),
     event_row.event_key_version = 'legacy-event-v1',
     event_row.status = CASE
       WHEN event_row.state IN ('posted', 'linked') THEN 'posted'
       WHEN event_row.state = 'ignored' THEN 'excluded'
       ELSE 'needs_action'
     END,
     event_row.flow_direction = CASE source_row.normalized_direction
       WHEN 'income' THEN 'inflow'
       WHEN 'expense' THEN 'outflow'
       ELSE 'neutral'
     END,
     event_row.economic_nature = CASE source_row.normalized_direction
       WHEN 'income' THEN 'income'
       WHEN 'expense' THEN 'expense'
       ELSE 'unknown'
     END,
     event_row.ledger_account_id = COALESCE(
       decision_row.account_id,
       transaction_row.source_account_id,
       transaction_row.destination_account_id
     ),
     event_row.event_local_date = source_row.normalized_local_date,
     event_row.event_local_at = source_row.normalized_local_at,
     event_row.event_utc_at = source_row.normalized_utc_at,
     event_row.timezone_offset_minutes = source_row.timezone_offset_minutes,
     event_row.amount_minor = source_row.normalized_amount_minor,
     event_row.currency = source_row.currency,
     event_row.category_id = COALESCE(decision_row.category_id, transaction_row.category_id),
     event_row.field_sources_json = JSON_OBJECT('legacyRowId', source_row.row_id),
     event_row.reason_codes_json = JSON_ARRAY('legacy_single_file_backfill')
WHERE file_row.state = 'committed' AND event_row.update_id IS NULL;

UPDATE catledger_event_evidence evidence_row
JOIN catledger_economic_events event_row
  ON event_row.uid = evidence_row.uid AND event_row.event_id = evidence_row.event_id
 SET evidence_row.evidence_id = COALESCE(evidence_row.evidence_id, UUID()),
     evidence_row.update_id = event_row.update_id
WHERE event_row.update_id IS NOT NULL AND evidence_row.update_id IS NULL;

INSERT IGNORE INTO catledger_economic_event_transactions
  (uid, link_id, update_id, event_id, transaction_id, role,
   creation_method, rule_version, transaction_version, created_at)
SELECT legacy_link.uid, legacy_link.link_id, event_row.update_id,
       legacy_link.event_id, legacy_link.transaction_id, 'historical_primary',
       legacy_link.creation_method, 'legacy-import-link-v1', transaction_row.version,
       legacy_link.created_at
  FROM catledger_import_transaction_links legacy_link
  JOIN catledger_economic_events event_row
    ON event_row.uid = legacy_link.uid AND event_row.event_id = legacy_link.event_id
  JOIN catledger_transactions transaction_row
    ON transaction_row.uid = legacy_link.uid AND transaction_row.transaction_id = legacy_link.transaction_id
 WHERE event_row.update_id IS NOT NULL;

INSERT IGNORE INTO catledger_finance_update_postings
  (uid, posting_id, update_id, request_digest, state, selected_event_count,
   created_transaction_count, reused_transaction_count, created_at, completed_at, updated_at)
SELECT posting_row.uid, posting_row.posting_id, posting_row.import_id,
       posting_row.request_digest, posting_row.state, posting_row.selected_event_count,
       posting_row.created_transaction_count, posting_row.reused_transaction_count,
       posting_row.created_at, posting_row.completed_at, posting_row.updated_at
  FROM catledger_import_postings posting_row
  JOIN catledger_finance_updates update_row
    ON update_row.uid = posting_row.uid AND update_row.update_id = posting_row.import_id
 WHERE posting_row.state = 'completed';
