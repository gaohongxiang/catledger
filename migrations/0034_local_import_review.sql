-- 有版本的导入快照和不可替换的决定载荷。不存文件二进制，不提前创建正式账务。
SET @catledger_local_mode_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_finance_updates' AND COLUMN_NAME='review_mode')=0,
  'ALTER TABLE catledger_finance_updates ADD COLUMN review_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''server''', 'SELECT 1');
PREPARE catledger_local_mode_stmt FROM @catledger_local_mode_sql;
EXECUTE catledger_local_mode_stmt;
DEALLOCATE PREPARE catledger_local_mode_stmt;

CREATE TABLE IF NOT EXISTS catledger_import_review_objects (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  object_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_version BIGINT UNSIGNED NOT NULL,
  rule_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol_version TINYINT UNSIGNED NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chunk_count INT UNSIGNED NOT NULL,
  byte_count INT UNSIGNED NOT NULL DEFAULT 0,
  content_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, object_id),
  KEY idx_import_review_update (uid, update_id, object_kind, base_version),
  FOREIGN KEY (uid, update_id) REFERENCES catledger_finance_updates(uid, update_id),
  CHECK (object_kind IN ('snapshot','decisions','recheck')),
  CHECK (state IN ('writing','sealed','consumed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_import_review_chunks (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part_index INT UNSIGNED NOT NULL,
  byte_count INT UNSIGNED NOT NULL,
  content_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_text MEDIUMTEXT NOT NULL,
  PRIMARY KEY (uid, object_id, part_index),
  FOREIGN KEY (uid, object_id) REFERENCES catledger_import_review_objects(uid, object_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
