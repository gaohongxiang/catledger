CREATE TABLE IF NOT EXISTS catledger_users (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid),
  KEY idx_catledger_users_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_user_identities (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, provider),
  UNIQUE KEY uk_catledger_identity_subject (provider, subject_hash),
  CONSTRAINT fk_catledger_identity_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catledger_categories (
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  system_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  name VARCHAR(64) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  is_system_default TINYINT(1) NOT NULL DEFAULT 0,
  archived_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (category_id),
  UNIQUE KEY uk_catledger_category_system (uid, kind, system_key),
  KEY idx_catledger_categories_active (uid, kind, archived_at, sort_order),
  CONSTRAINT fk_catledger_category_user
    FOREIGN KEY (uid) REFERENCES catledger_users (uid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
