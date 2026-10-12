-- 显示名称独立于原始文件名、文件格式、对象键及内容身份；旧记录继续显示原名。
SET @catledger_file_name_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_import_files' AND COLUMN_NAME='display_name')=0,
  'ALTER TABLE catledger_import_files ADD COLUMN display_name VARCHAR(255) NULL AFTER original_file_name', 'SELECT 1');
PREPARE catledger_file_name_stmt FROM @catledger_file_name_sql;
EXECUTE catledger_file_name_stmt;
DEALLOCATE PREPARE catledger_file_name_stmt;
