-- 仅标记已完成的默认分类初始化版本；已有用户保持 0，在可信身份和用户锁下补齐一次。
-- 不回填用户数据，不恢复归档分类；标记本身不推进账务 data_revision。
SET @catledger_initialization_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_users' AND COLUMN_NAME='initialization_version')=0,
  'ALTER TABLE catledger_users ADD COLUMN initialization_version SMALLINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE catledger_initialization_stmt FROM @catledger_initialization_sql;
EXECUTE catledger_initialization_stmt;
DEALLOCATE PREPARE catledger_initialization_stmt;
