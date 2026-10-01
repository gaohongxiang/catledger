-- 仅保存明确的来源对及必要事实；无旧数据回填，不生成交易。
CREATE TABLE IF NOT EXISTS catledger_bank_channel_decisions (
  uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pair_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bank_identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform_identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  basis_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decision VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, pair_digest),
  KEY idx_bank_channel_bank (uid, bank_identity_id),
  KEY idx_bank_channel_platform (uid, platform_identity_id),
  FOREIGN KEY (uid, bank_identity_id) REFERENCES catledger_source_identities(uid, identity_id),
  FOREIGN KEY (uid, platform_identity_id) REFERENCES catledger_source_identities(uid, identity_id),
  FOREIGN KEY (uid, action_id) REFERENCES catledger_finance_actions(uid, action_id),
  CHECK (decision IN ('same', 'distinct'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
