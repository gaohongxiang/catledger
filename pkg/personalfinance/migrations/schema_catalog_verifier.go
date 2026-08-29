package migrations

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

func verifyDialectTableSchema(db *datastore.Database, tableName string) error {
	return verifyDialectTableSchemaWithContext(context.Background(), db, tableName)
}

func verifyDialectTableSchemaWithContext(c context.Context, db *datastore.Database, tableName string) error {
	if !isSafeCatalogIdentifier(tableName) {
		return schemaError(tableName, "unsafe table identifier")
	}

	switch db.DatabaseType() {
	case settings.Sqlite3DbType:
		return verifySQLiteTableCatalog(c, db, tableName)
	case settings.MySqlDbType:
		return verifyMySQLTableCatalog(c, db, tableName)
	case settings.PostgresDbType:
		return verifyPostgreSQLTableCatalog(c, db, tableName)
	default:
		return schemaError(tableName, fmt.Sprintf("unsupported database type %s", db.DatabaseType()))
	}
}

func verifySQLiteTableCatalog(c context.Context, db *datastore.Database, tableName string) error {
	quotedTable := quoteSQLiteIdentifier(tableName)
	indexes, err := querySchemaRows(c, db, "PRAGMA index_list("+quotedTable+")")

	if err != nil {
		return fmt.Errorf("read SQLite indexes for %s: %w", tableName, err)
	}

	for _, index := range indexes {
		indexName := schemaRowValue(index, "name")

		if schemaRowInt(index, "partial") != 0 {
			return schemaError(tableName, fmt.Sprintf("index %s is partial", indexName))
		}

		if !isSafeCatalogIdentifier(indexName) && !strings.HasPrefix(indexName, "sqlite_autoindex_") {
			return schemaError(tableName, fmt.Sprintf("index %s has an unsafe name", indexName))
		}

		indexColumns, queryErr := querySchemaRows(c, db, "PRAGMA index_xinfo("+quoteSQLiteIdentifier(indexName)+")")

		if queryErr != nil {
			return fmt.Errorf("read SQLite index %s: %w", indexName, queryErr)
		}

		for _, column := range indexColumns {
			if schemaRowInt(column, "key") == 1 && schemaRowInt(column, "cid") < 0 {
				return schemaError(tableName, fmt.Sprintf("index %s contains an expression", indexName))
			}
		}
	}

	foreignKeys, err := querySchemaRows(c, db, "PRAGMA foreign_key_list("+quotedTable+")")

	if err != nil {
		return fmt.Errorf("read SQLite foreign keys for %s: %w", tableName, err)
	}

	if len(foreignKeys) > 0 {
		return schemaError(tableName, "foreign keys are not allowed")
	}

	columns, err := querySchemaRows(c, db, "PRAGMA table_xinfo("+quotedTable+")")

	if err != nil {
		return fmt.Errorf("read SQLite extended columns for %s: %w", tableName, err)
	}

	for _, column := range columns {
		if schemaRowInt(column, "hidden") != 0 {
			return schemaError(tableName, fmt.Sprintf("column %s is hidden or generated", schemaRowValue(column, "name")))
		}
	}

	triggers, err := querySchemaRows(c, db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", tableName)

	if err != nil {
		return fmt.Errorf("read SQLite triggers for %s: %w", tableName, err)
	}

	if len(triggers) > 0 {
		return schemaError(tableName, fmt.Sprintf("trigger %s is not allowed", schemaRowValue(triggers[0], "name")))
	}

	return nil
}

func verifyMySQLTableCatalog(c context.Context, db *datastore.Database, tableName string) error {
	tables, err := querySchemaRows(c, db, `SELECT ENGINE AS engine
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, tableName)

	if err != nil {
		return fmt.Errorf("read MySQL table engine for %s: %w", tableName, err)
	}

	if len(tables) != 1 || !strings.EqualFold(schemaRowValue(tables[0], "engine"), "InnoDB") {
		return schemaError(tableName, fmt.Sprintf("table engine is %s, expected InnoDB", schemaRowValue(firstSchemaRow(tables), "engine")))
	}

	indexes, err := querySchemaRows(c, db, `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name, SUB_PART AS sub_part
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME<>'PRIMARY'`, tableName)

	if err != nil {
		return fmt.Errorf("read MySQL indexes for %s: %w", tableName, err)
	}

	for _, index := range indexes {
		indexName := schemaRowValue(index, "index_name")

		if schemaRowValue(index, "column_name") == "" {
			return schemaError(tableName, fmt.Sprintf("index %s contains an expression", indexName))
		}

		if schemaRowValue(index, "sub_part") != "" {
			return schemaError(tableName, fmt.Sprintf("index %s contains a prefix column", indexName))
		}
	}

	foreignKeys, err := querySchemaRows(c, db, `SELECT CONSTRAINT_NAME AS constraint_name
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL`, tableName)

	if err != nil {
		return fmt.Errorf("read MySQL foreign keys for %s: %w", tableName, err)
	}

	if len(foreignKeys) > 0 {
		return schemaError(tableName, fmt.Sprintf("foreign key %s is not allowed", schemaRowValue(foreignKeys[0], "constraint_name")))
	}

	generatedColumns, err := querySchemaRows(c, db, `SELECT COLUMN_NAME AS column_name
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND UPPER(EXTRA) LIKE '%GENERATED%'`, tableName)

	if err != nil {
		return fmt.Errorf("read MySQL generated columns for %s: %w", tableName, err)
	}

	if len(generatedColumns) > 0 {
		return schemaError(tableName, fmt.Sprintf("column %s is generated", schemaRowValue(generatedColumns[0], "column_name")))
	}

	triggers, err := querySchemaRows(c, db, `SELECT TRIGGER_NAME AS trigger_name
FROM INFORMATION_SCHEMA.TRIGGERS
WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?`, tableName)

	if err != nil {
		return fmt.Errorf("read MySQL triggers for %s: %w", tableName, err)
	}

	if len(triggers) > 0 {
		return schemaError(tableName, fmt.Sprintf("trigger %s is not allowed", schemaRowValue(triggers[0], "trigger_name")))
	}

	return nil
}

func verifyPostgreSQLTableCatalog(c context.Context, db *datastore.Database, tableName string) error {
	indexes, err := querySchemaRows(c, db, `SELECT index_class.relname AS index_name,
       index_meta.indisvalid::text AS is_valid,
       index_meta.indisready::text AS is_ready,
       (index_meta.indpred IS NOT NULL)::text AS is_partial,
       (index_meta.indexprs IS NOT NULL)::text AS has_expression
FROM pg_catalog.pg_class AS table_class
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
JOIN pg_catalog.pg_index AS index_meta ON index_meta.indrelid=table_class.oid
JOIN pg_catalog.pg_class AS index_class ON index_class.oid=index_meta.indexrelid
WHERE namespace.nspname='public' AND table_class.relname=?`, tableName)

	if err != nil {
		return fmt.Errorf("read PostgreSQL indexes for %s: %w", tableName, err)
	}

	for _, index := range indexes {
		indexName := schemaRowValue(index, "index_name")

		if !schemaRowBool(index, "is_valid") || !schemaRowBool(index, "is_ready") {
			return schemaError(tableName, fmt.Sprintf("index %s is not valid and ready", indexName))
		}

		if schemaRowBool(index, "is_partial") {
			return schemaError(tableName, fmt.Sprintf("index %s is partial", indexName))
		}

		if schemaRowBool(index, "has_expression") {
			return schemaError(tableName, fmt.Sprintf("index %s contains an expression", indexName))
		}
	}

	foreignKeys, err := querySchemaRows(c, db, `SELECT constraint_meta.conname AS constraint_name
FROM pg_catalog.pg_constraint AS constraint_meta
JOIN pg_catalog.pg_class AS table_class ON table_class.oid=constraint_meta.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
WHERE namespace.nspname='public' AND table_class.relname=? AND constraint_meta.contype='f'`, tableName)

	if err != nil {
		return fmt.Errorf("read PostgreSQL foreign keys for %s: %w", tableName, err)
	}

	if len(foreignKeys) > 0 {
		return schemaError(tableName, fmt.Sprintf("foreign key %s is not allowed", schemaRowValue(foreignKeys[0], "constraint_name")))
	}

	generatedColumns, err := querySchemaRows(c, db, `SELECT attribute.attname AS column_name
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS table_class ON table_class.oid=attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
WHERE namespace.nspname='public' AND table_class.relname=?
  AND attribute.attgenerated<>'' AND NOT attribute.attisdropped`, tableName)

	if err != nil {
		return fmt.Errorf("read PostgreSQL generated columns for %s: %w", tableName, err)
	}

	if len(generatedColumns) > 0 {
		return schemaError(tableName, fmt.Sprintf("column %s is generated", schemaRowValue(generatedColumns[0], "column_name")))
	}

	triggers, err := querySchemaRows(c, db, `SELECT trigger_meta.tgname AS trigger_name
FROM pg_catalog.pg_trigger AS trigger_meta
JOIN pg_catalog.pg_class AS table_class ON table_class.oid=trigger_meta.tgrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
WHERE namespace.nspname='public' AND table_class.relname=? AND NOT trigger_meta.tgisinternal`, tableName)

	if err != nil {
		return fmt.Errorf("read PostgreSQL triggers for %s: %w", tableName, err)
	}

	if len(triggers) > 0 {
		return schemaError(tableName, fmt.Sprintf("trigger %s is not allowed", schemaRowValue(triggers[0], "trigger_name")))
	}

	return nil
}

func querySchemaRows(c context.Context, db *datastore.Database, query string, args ...any) ([]map[string]string, error) {
	sess := db.NewSessionWithContext(c)
	defer sess.Close()
	queryArgs := make([]any, 0, len(args)+1)
	queryArgs = append(queryArgs, query)
	queryArgs = append(queryArgs, args...)
	return sess.QueryString(queryArgs...)
}

func quoteSQLiteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func isSafeCatalogIdentifier(value string) bool {
	if value == "" {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '_' {
			return false
		}
	}

	return true
}

func schemaRowValue(row map[string]string, name string) string {
	for key, value := range row {
		if strings.EqualFold(key, name) {
			return value
		}
	}

	return ""
}

func firstSchemaRow(rows []map[string]string) map[string]string {
	if len(rows) == 0 {
		return nil
	}

	return rows[0]
}

func schemaRowInt(row map[string]string, name string) int64 {
	value, _ := strconv.ParseInt(schemaRowValue(row, name), 10, 64)
	return value
}

func schemaRowBool(row map[string]string, name string) bool {
	switch strings.ToLower(schemaRowValue(row, name)) {
	case "1", "t", "true", "yes", "on":
		return true
	default:
		return false
	}
}
