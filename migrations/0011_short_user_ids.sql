DROP PROCEDURE IF EXISTS catledger_migrate_short_user_ids;

DELIMITER $$
CREATE PROCEDURE catledger_migrate_short_user_ids()
SQL SECURITY INVOKER
BEGIN
  DECLARE v_done BOOLEAN DEFAULT FALSE;
  DECLARE v_locked BOOLEAN DEFAULT FALSE;
  DECLARE v_started BOOLEAN DEFAULT FALSE;
  DECLARE v_prepared BOOLEAN DEFAULT FALSE;
  DECLARE v_collision BOOLEAN DEFAULT FALSE;
  DECLARE v_fk_checks BOOLEAN DEFAULT @@SESSION.foreign_key_checks;
  DECLARE v_group_concat BIGINT UNSIGNED DEFAULT @@SESSION.group_concat_max_len;
  DECLARE v_old_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE v_new_uid CHAR(10) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE v_random BIGINT UNSIGNED;
  DECLARE v_attempt INT DEFAULT 0;
  DECLARE v_users BIGINT DEFAULT 0;
  DECLARE v_changed_users BIGINT DEFAULT 0;
  DECLARE v_changed_rows BIGINT DEFAULT 0;
  DECLARE v_expected_rows BIGINT DEFAULT 0;
  DECLARE v_tables INT DEFAULT 0;
  DECLARE v_foreign_keys INT DEFAULT 0;
  DECLARE v_invalid BIGINT DEFAULT 0;
  DECLARE v_table VARCHAR(64);
  DECLARE v_preserve_timestamps TEXT;
  DECLARE v_fk_query TEXT;

  DECLARE uid_tables CURSOR FOR
    SELECT c.table_name,
           COALESCE((SELECT GROUP_CONCAT(
             CONCAT(', t.`', REPLACE(ts.column_name, '`', '``'), '` = t.`',
                    REPLACE(ts.column_name, '`', '``'), '`') ORDER BY ts.ordinal_position SEPARATOR '')
             FROM information_schema.columns ts
             WHERE ts.table_schema = c.table_schema AND ts.table_name = c.table_name
               AND LOWER(ts.extra) LIKE '%on update%'), '')
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = DATABASE() AND LEFT(c.table_name, 10) = 'catledger_'
       AND c.column_name = 'uid' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name;

  DECLARE foreign_keys CURSOR FOR
    SELECT CONCAT(
      'SELECT COUNT(*) INTO @catledger_uid_invalid FROM `', REPLACE(k.table_name, '`', '``'), '` c ',
      'LEFT JOIN `', REPLACE(k.referenced_table_schema, '`', '``'), '`.`',
      REPLACE(k.referenced_table_name, '`', '``'), '` p ON ',
      GROUP_CONCAT(CONCAT('c.`', REPLACE(k.column_name, '`', '``'), '` = p.`',
        REPLACE(k.referenced_column_name, '`', '``'), '`') ORDER BY k.ordinal_position SEPARATOR ' AND '),
      ' WHERE ',
      GROUP_CONCAT(CONCAT('c.`', REPLACE(k.column_name, '`', '``'), '` IS NOT NULL')
        ORDER BY k.ordinal_position SEPARATOR ' AND '),
      ' AND p.`', SUBSTRING_INDEX(GROUP_CONCAT(REPLACE(k.referenced_column_name, '`', '``')
        ORDER BY k.ordinal_position SEPARATOR ','), ',', 1), '` IS NULL')
      FROM information_schema.key_column_usage k
     WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL
       AND (LEFT(k.table_name, 10) = 'catledger_'
         OR (k.referenced_table_schema = DATABASE() AND LEFT(k.referenced_table_name, 10) = 'catledger_'))
     GROUP BY k.constraint_schema, k.table_name, k.constraint_name,
              k.referenced_table_schema, k.referenced_table_name
     ORDER BY k.table_name, k.constraint_name;

  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = TRUE;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_started THEN ROLLBACK; END IF;
    SET SESSION foreign_key_checks = v_fk_checks;
    SET SESSION group_concat_max_len = v_group_concat;
    IF v_prepared THEN DEALLOCATE PREPARE catledger_uid_statement; END IF;
    DROP TEMPORARY TABLE IF EXISTS catledger_uid_migration_map;
    SET @catledger_uid_sql = NULL;
    SET @catledger_uid_invalid = NULL;
    SET @catledger_uid_expected = NULL;
    IF v_locked THEN DO RELEASE_LOCK('catledger:schema-migrations'); END IF;
    RESIGNAL;
  END;

  IF v_fk_checks <> 1 OR @@SESSION.autocommit <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration requires a clean autocommit connection with foreign keys enabled';
  END IF;
  SELECT COALESCE(GET_LOCK('catledger:schema-migrations', 30), 0) = 1 INTO v_locked;
  IF NOT v_locked THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration lock unavailable';
  END IF;
  SET SESSION group_concat_max_len = 16384;

  SELECT COUNT(*) INTO v_invalid
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = DATABASE() AND LEFT(c.table_name, 10) = 'catledger_'
     AND c.column_name = 'uid'
     AND (t.table_type <> 'BASE TABLE' OR t.engine <> 'InnoDB'
       OR c.data_type <> 'char' OR c.character_maximum_length <> 36);
  IF v_invalid <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration found an unsupported table or UID column';
  END IF;
  SELECT COUNT(*) INTO v_tables FROM information_schema.columns
   WHERE table_schema = DATABASE() AND LEFT(table_name, 10) = 'catledger_' AND column_name = 'uid';
  IF v_tables <> 29 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration requires the complete 0010 schema';
  END IF;
  SELECT COUNT(*) INTO v_invalid FROM information_schema.triggers
   WHERE event_object_schema = DATABASE() AND LEFT(event_object_table, 10) = 'catledger_';
  IF v_invalid <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration requires review of existing triggers';
  END IF;

  CREATE TEMPORARY TABLE catledger_uid_migration_map (
    old_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    new_uid CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (old_uid),
    UNIQUE KEY uk_catledger_uid_migration_new (new_uid)
  ) ENGINE=InnoDB;

  START TRANSACTION;
  SET v_started = TRUE;
  -- 同bootstrap先锁身份行，再锁用户行；只锁定，不改变身份数据或更新时间。
  UPDATE catledger_user_identities SET uid = uid;
  UPDATE catledger_users SET uid = uid, updated_at = updated_at;
  INSERT INTO catledger_uid_migration_map (old_uid, new_uid)
    SELECT uid, IF(uid REGEXP '^[1-9][0-9]{9}$', uid, NULL) FROM catledger_users;
  SELECT COUNT(*), COALESCE(SUM(new_uid IS NULL), 0) INTO v_users, v_changed_users
    FROM catledger_uid_migration_map;
  SELECT COUNT(*) INTO v_invalid FROM catledger_uid_migration_map
   WHERE new_uid IS NULL AND old_uid NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF v_invalid <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration found an unexpected legacy UID format';
  END IF;

  WHILE EXISTS (SELECT 1 FROM catledger_uid_migration_map WHERE new_uid IS NULL) DO
    SELECT old_uid INTO v_old_uid FROM catledger_uid_migration_map
     WHERE new_uid IS NULL ORDER BY old_uid LIMIT 1;
    SET v_attempt = 0;
    allocate_uid: LOOP
      SET v_attempt = v_attempt + 1;
      IF v_attempt > 32 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID allocation collision limit exceeded';
      END IF;
      -- 48位随机空间做拒绝采样，避免取模偏差；临时唯一键覆盖新旧短ID。
      SET v_random = CONV(HEX(RANDOM_BYTES(6)), 16, 10);
      WHILE v_random >= 281466000000000 DO
        SET v_random = CONV(HEX(RANDOM_BYTES(6)), 16, 10);
      END WHILE;
      SET v_new_uid = CAST(1000000000 + MOD(v_random, 9000000000) AS CHAR);
      SET v_collision = FALSE;
      BEGIN
        DECLARE CONTINUE HANDLER FOR 1062 SET v_collision = TRUE;
        UPDATE catledger_uid_migration_map SET new_uid = v_new_uid WHERE old_uid = v_old_uid;
      END;
      IF NOT v_collision THEN LEAVE allocate_uid; END IF;
    END LOOP;
  END WHILE;

  -- 仅当前连接关闭即时外键检查；所有业务修改仍在同一事务，下面逐约束复核。
  SET SESSION foreign_key_checks = 0;
  SET v_done = FALSE;
  OPEN uid_tables;
  update_tables: LOOP
    FETCH uid_tables INTO v_table, v_preserve_timestamps;
    IF v_done THEN LEAVE update_tables; END IF;
    SET @catledger_uid_sql = CONCAT('SELECT COUNT(*) INTO @catledger_uid_expected FROM `',
      REPLACE(v_table, '`', '``'), '` t JOIN catledger_uid_migration_map m ON t.uid = m.old_uid ',
      'WHERE m.old_uid <> m.new_uid');
    PREPARE catledger_uid_statement FROM @catledger_uid_sql;
    SET v_prepared = TRUE;
    EXECUTE catledger_uid_statement;
    DEALLOCATE PREPARE catledger_uid_statement;
    SET v_prepared = FALSE;
    SET v_expected_rows = @catledger_uid_expected;
    SET @catledger_uid_sql = CONCAT('UPDATE `', REPLACE(v_table, '`', '``'),
      '` t JOIN catledger_uid_migration_map m ON t.uid = m.old_uid SET t.uid = m.new_uid',
      v_preserve_timestamps, ' WHERE m.old_uid <> m.new_uid');
    PREPARE catledger_uid_statement FROM @catledger_uid_sql;
    SET v_prepared = TRUE;
    EXECUTE catledger_uid_statement;
    SET v_invalid = ROW_COUNT();
    DEALLOCATE PREPARE catledger_uid_statement;
    SET v_prepared = FALSE;
    IF v_invalid <> v_expected_rows THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration row coverage mismatch';
    END IF;
    SET v_changed_rows = v_changed_rows + v_expected_rows;
    SET @catledger_uid_sql = CONCAT('SELECT COUNT(*) INTO @catledger_uid_invalid FROM `',
      REPLACE(v_table, '`', '``'), '` WHERE uid NOT REGEXP ''^[1-9][0-9]{9}$''');
    PREPARE catledger_uid_statement FROM @catledger_uid_sql;
    SET v_prepared = TRUE;
    EXECUTE catledger_uid_statement;
    DEALLOCATE PREPARE catledger_uid_statement;
    SET v_prepared = FALSE;
    IF @catledger_uid_invalid <> 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration found unmapped ownership';
    END IF;
  END LOOP;
  CLOSE uid_tables;

  SET v_done = FALSE;
  OPEN foreign_keys;
  validate_foreign_keys: LOOP
    FETCH foreign_keys INTO v_fk_query;
    IF v_done THEN LEAVE validate_foreign_keys; END IF;
    SET @catledger_uid_sql = v_fk_query;
    PREPARE catledger_uid_statement FROM @catledger_uid_sql;
    SET v_prepared = TRUE;
    EXECUTE catledger_uid_statement;
    DEALLOCATE PREPARE catledger_uid_statement;
    SET v_prepared = FALSE;
    IF @catledger_uid_invalid <> 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration foreign key validation failed';
    END IF;
    SET v_foreign_keys = v_foreign_keys + 1;
  END LOOP;
  CLOSE foreign_keys;
  IF v_foreign_keys = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UID migration found no foreign keys to validate';
  END IF;

  SET SESSION foreign_key_checks = v_fk_checks;
  COMMIT;
  SET v_started = FALSE;
  DROP TEMPORARY TABLE catledger_uid_migration_map;
  SET SESSION group_concat_max_len = v_group_concat;
  SET @catledger_uid_sql = NULL;
  SET @catledger_uid_invalid = NULL;
  SET @catledger_uid_expected = NULL;
  DO RELEASE_LOCK('catledger:schema-migrations');
  SET v_locked = FALSE;
  SELECT v_users AS users_total, v_changed_users AS users_migrated,
         v_changed_rows AS ownership_rows_updated, v_tables AS tables_verified,
         v_foreign_keys AS foreign_keys_verified;
END$$
DELIMITER ;

CALL catledger_migrate_short_user_ids();
DROP PROCEDURE catledger_migrate_short_user_ids;
