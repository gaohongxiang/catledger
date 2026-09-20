-- 昵称是可修改的账号展示资料；不参与身份映射或业务唯一性。
SET @catledger_has_user_nickname = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_users' AND COLUMN_NAME='nickname');
SET @catledger_user_nickname_sql = IF(@catledger_has_user_nickname=0,
  'ALTER TABLE catledger_users ADD COLUMN nickname VARCHAR(24) DEFAULT NULL', 'SELECT 1');
PREPARE catledger_user_nickname_stmt FROM @catledger_user_nickname_sql;
EXECUTE catledger_user_nickname_stmt;
DEALLOCATE PREPARE catledger_user_nickname_stmt;
