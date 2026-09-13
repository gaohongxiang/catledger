-- 显式前向迁移；业务写修订用于乐观导出快照，不在运行时建表。
SET @catledger_has_revision = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_users' AND COLUMN_NAME='data_revision');
SET @catledger_revision_sql = IF(@catledger_has_revision=0,
  'ALTER TABLE catledger_users ADD COLUMN data_revision BIGINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_revision_stmt FROM @catledger_revision_sql;
EXECUTE catledger_revision_stmt;
DEALLOCATE PREPARE catledger_revision_stmt;

CREATE TABLE IF NOT EXISTS catledger_data_exports (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  export_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_revision BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) DEFAULT NULL,
  result_json JSON DEFAULT NULL,
  PRIMARY KEY (uid),
  CONSTRAINT fk_data_export_user FOREIGN KEY (uid) REFERENCES catledger_users(uid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
