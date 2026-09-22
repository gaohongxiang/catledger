-- No historical categories or transactions are reclassified.

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND column_name='parent_id') = 0, 'ALTER TABLE catledger_categories ADD COLUMN parent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER system_key', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND column_name='parent_scope') = 0, 'ALTER TABLE catledger_categories ADD COLUMN parent_scope CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (COALESCE(parent_id, '''')) STORED', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND index_name='uk_catledger_category_parent_ref') = 0, 'ALTER TABLE catledger_categories ADD UNIQUE KEY uk_catledger_category_parent_ref (uid, kind, category_id)', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND index_name='uk_catledger_category_sibling_name') = 0, 'ALTER TABLE catledger_categories ADD UNIQUE KEY uk_catledger_category_sibling_name (uid, kind, parent_scope, active_name_key)', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND index_name='idx_catledger_category_parent') = 0, 'ALTER TABLE catledger_categories ADD KEY idx_catledger_category_parent (uid, kind, parent_id, archived_at, sort_order)', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='catledger_categories' AND constraint_name='fk_catledger_category_parent') = 0, 'ALTER TABLE catledger_categories ADD CONSTRAINT fk_catledger_category_parent FOREIGN KEY (uid, kind, parent_id) REFERENCES catledger_categories (uid, kind, category_id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='catledger_categories' AND constraint_name='ck_catledger_category_not_self') = 0, 'ALTER TABLE catledger_categories ADD CONSTRAINT ck_catledger_category_not_self CHECK (parent_id IS NULL OR parent_id <> category_id)', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;

SET @category_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='catledger_categories' AND index_name='uk_catledger_category_active_name') > 0, 'ALTER TABLE catledger_categories DROP INDEX uk_catledger_category_active_name', 'SELECT 1');
PREPARE category_stmt FROM @category_ddl;
EXECUTE category_stmt;
DEALLOCATE PREPARE category_stmt;
