package migrations

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"xorm.io/xorm/schemas"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

type schemaVerificationMode uint8

const (
	schemaCompatibleSubset schemaVerificationMode = iota
	schemaExact
)

func verifyMigrationTable(db *datastore.Database) error {
	return verifyMigrationTableWithContext(context.Background(), db)
}

func verifyMigrationTableWithContext(c context.Context, db *datastore.Database) error {
	expected, err := db.TableInfo(new(SchemaMigration))

	if err != nil {
		return fmt.Errorf("describe personal finance migration table: %w", err)
	}

	actualTables, err := readSchemaTablesWithContext(c, db)

	if err != nil {
		return fmt.Errorf("read database schema for migration table: %w", err)
	}

	actual := findTable(actualTables, expected.Name)

	if actual == nil {
		return schemaError(expected.Name, "table is missing")
	}

	if err = verifyTable(db.DatabaseType(), expected, actual, schemaExact); err != nil {
		return err
	}

	return verifyDialectTableSchemaWithContext(c, db, expected.Name)
}

func validateSchemaV001Preflight(db *datastore.Database) error {
	return validateSchemaV001PreflightWithContext(context.Background(), db)
}

func validateSchemaV001PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifySchemaV001TablesWithContext(c, db, schemaCompatibleSubset)
}

func verifySchemaV001(db *datastore.Database) error {
	return verifySchemaV001WithContext(context.Background(), db)
}

func verifySchemaV001WithContext(c context.Context, db *datastore.Database) error {
	return verifySchemaV001TablesWithContext(c, db, schemaExact)
}

func verifySchemaV001TablesWithContext(c context.Context, db *datastore.Database, mode schemaVerificationMode) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansV001(), mode)
}

func validateSchemaV002PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV002(), schemaCompatibleSubset)
}

func verifySchemaV002WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV002(), schemaExact)
}

func verifySchemaV002(db *datastore.Database) error {
	return verifySchemaV002WithContext(context.Background(), db)
}

func validateSchemaV003Preflight(db *datastore.Database) error {
	return validateSchemaV003PreflightWithContext(context.Background(), db)
}

func validateSchemaV003PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceMigrationPreflightWithContext(c, db, schemaBeansThroughV002(), schemaBeansV003())
}

func verifySchemaV003WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV003(), schemaExact)
}

func verifySchemaV003(db *datastore.Database) error {
	return verifySchemaV003WithContext(context.Background(), db)
}

func validateSchemaV004Preflight(db *datastore.Database) error {
	return validateSchemaV004PreflightWithContext(context.Background(), db)
}

func validateSchemaV004PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceMigrationPreflightWithContext(c, db, schemaBeansThroughV003(), schemaBeansV004())
}

func verifySchemaV004WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV004(), schemaExact)
}

func verifySchemaV004(db *datastore.Database) error {
	return verifySchemaV004WithContext(context.Background(), db)
}

// syncFrozenSchemaBeanWithIndexes 补足 Sync2 在两个复合索引共享前缀时可能漏建的索引。
// v003 起每张新增表仍作为一个可重入迁移步骤执行，重试只创建确实缺失的冻结索引。
func syncFrozenSchemaBeanWithIndexes(c context.Context, db *datastore.Database, bean any) error {
	if err := db.SyncStructsWithStoreEngineContext(c, "InnoDB", bean); err != nil {
		return err
	}

	expected, err := db.TableInfo(bean)

	if err != nil {
		return fmt.Errorf("describe personal finance schema after sync: %w", err)
	}

	actualTables, err := readSchemaTablesWithContext(c, db)

	if err != nil {
		return fmt.Errorf("read personal finance schema after sync: %w", err)
	}

	actual := findTable(actualTables, expected.Name)

	if actual == nil {
		return schemaError(expected.Name, "table is missing after sync")
	}

	expectedIndexes := physicalIndexes(expected)
	actualIndexes := physicalIndexes(actual)
	missingIndexNames := make([]string, 0, len(expectedIndexes))
	actualIndexNames := make([]string, 0, len(actualIndexes))

	for indexName := range actualIndexes {
		actualIndexNames = append(actualIndexNames, indexName)
	}

	sort.Strings(actualIndexNames)

	for indexName := range expectedIndexes {
		if actualIndexes[indexName] == nil {
			missingIndexNames = append(missingIndexNames, indexName)
		}
	}

	sort.Strings(missingIndexNames)

	for _, indexName := range missingIndexNames {
		index := expectedIndexes[indexName]
		quotedIndexName, quoteErr := quoteSchemaIdentifier(db.DatabaseType(), indexName)

		if quoteErr != nil {
			return schemaError(expected.Name, quoteErr.Error())
		}

		quotedTableName, quoteErr := quoteSchemaIdentifier(db.DatabaseType(), expected.Name)

		if quoteErr != nil {
			return schemaError(expected.Name, quoteErr.Error())
		}

		quotedColumns := make([]string, len(index.Cols))

		for columnIndex, columnName := range index.Cols {
			quotedColumns[columnIndex], quoteErr = quoteSchemaIdentifier(db.DatabaseType(), columnName)

			if quoteErr != nil {
				return schemaError(expected.Name, quoteErr.Error())
			}
		}

		indexModifier := ""

		if index.Type == schemas.UniqueType {
			indexModifier = "UNIQUE "
		} else if index.Type != schemas.IndexType {
			return schemaError(expected.Name, fmt.Sprintf("index %s has unsupported type", indexName))
		}

		statement := fmt.Sprintf("CREATE %sINDEX %s ON %s (%s)", indexModifier, quotedIndexName, quotedTableName, strings.Join(quotedColumns, ", "))
		sess := db.NewSessionWithContext(c)
		_, execErr := sess.Exec(statement)
		sess.Close()

		if execErr != nil {
			return fmt.Errorf("create personal finance index %s (catalog indexes %v): %w", indexName, actualIndexNames, execErr)
		}
	}

	return nil
}

func quoteSchemaIdentifier(databaseType string, value string) (string, error) {
	if !isSafeCatalogIdentifier(value) {
		return "", fmt.Errorf("unsafe schema identifier %s", value)
	}

	if databaseType == settings.MySqlDbType {
		return "`" + value + "`", nil
	}

	return `"` + value + `"`, nil
}

// verifyPersonalFinanceMigrationPreflightWithContext 要求已发布基线仍然精确，
// 并只允许本次新增表完全不存在，或列、主键完整兼容且至多缺少预期索引。
func verifyPersonalFinanceMigrationPreflightWithContext(c context.Context, db *datastore.Database, existingBeans []any, newBeans []any) error {
	existingTables, err := describeTables(db, existingBeans)

	if err != nil {
		return err
	}

	newTables, err := describeTables(db, newBeans)

	if err != nil {
		return err
	}

	allowed := make(map[string]struct{}, len(existingTables)+len(newTables)+1)
	allowed[strings.ToLower((SchemaMigration{}).TableName())] = struct{}{}

	for tableName := range existingTables {
		allowed[tableName] = struct{}{}
	}

	for tableName := range newTables {
		if _, exists := allowed[tableName]; exists {
			return schemaError(tableName, "duplicate expected table across migration versions")
		}

		allowed[tableName] = struct{}{}
	}

	actualTables, err := readSchemaTablesWithContext(c, db)

	if err != nil {
		return fmt.Errorf("read database schema for personal finance migration preflight: %w", err)
	}

	for _, actual := range actualTables {
		actualName := normalizeIdentifier(actual.Name)

		if strings.HasPrefix(actualName, "pf_") {
			if _, exists := allowed[actualName]; !exists {
				return schemaError(actual.Name, "unknown personal finance table")
			}
		}
	}

	for tableName, expected := range existingTables {
		actual := findTable(actualTables, tableName)

		if actual == nil {
			return schemaError(tableName, "table is missing")
		}

		if err = verifyTable(db.DatabaseType(), expected, actual, schemaExact); err != nil {
			return err
		}

		if err = verifyDialectTableSchemaWithContext(c, db, expected.Name); err != nil {
			return err
		}
	}

	for tableName, expected := range newTables {
		actual := findTable(actualTables, tableName)

		if actual == nil {
			continue
		}

		if err = verifyTable(db.DatabaseType(), expected, actual, schemaCompatibleSubset); err != nil {
			return err
		}

		if err = verifyDialectTableSchemaWithContext(c, db, expected.Name); err != nil {
			return err
		}
	}

	return nil
}

func verifyPersonalFinanceTablesWithContext(c context.Context, db *datastore.Database, beans []any, mode schemaVerificationMode) error {
	expectedTables, err := describeTables(db, beans)

	if err != nil {
		return err
	}

	actualTables, err := readSchemaTablesWithContext(c, db)

	if err != nil {
		return fmt.Errorf("read database schema for personal finance tables: %w", err)
	}

	allowed := make(map[string]struct{}, len(expectedTables)+1)
	allowed[strings.ToLower((SchemaMigration{}).TableName())] = struct{}{}

	for tableName := range expectedTables {
		allowed[tableName] = struct{}{}
	}

	for _, actual := range actualTables {
		actualName := normalizeIdentifier(actual.Name)

		if strings.HasPrefix(actualName, "pf_") {
			if _, exists := allowed[actualName]; !exists {
				return schemaError(actual.Name, "unknown personal finance table")
			}
		}
	}

	for tableName, expected := range expectedTables {
		actual := findTable(actualTables, tableName)

		if actual == nil {
			if mode == schemaExact {
				return schemaError(tableName, "table is missing")
			}

			continue
		}

		if err = verifyTable(db.DatabaseType(), expected, actual, mode); err != nil {
			return err
		}

		if err = verifyDialectTableSchemaWithContext(c, db, expected.Name); err != nil {
			return err
		}
	}

	return nil
}

func describeTables(db *datastore.Database, beans []any) (map[string]*schemas.Table, error) {
	tables := make(map[string]*schemas.Table, len(beans))

	for _, bean := range beans {
		table, err := db.TableInfo(bean)

		if err != nil {
			return nil, fmt.Errorf("describe personal finance schema: %w", err)
		}

		tableName := normalizeIdentifier(table.Name)

		if tableName == "" {
			return nil, schemaError("", "expected table has no name")
		}

		if _, exists := tables[tableName]; exists {
			return nil, schemaError(table.Name, "duplicate expected table")
		}

		tables[tableName] = table
	}

	return tables, nil
}

func findTable(tables []*schemas.Table, name string) *schemas.Table {
	wanted := normalizeIdentifier(name)

	for _, table := range tables {
		if normalizeIdentifier(table.Name) == wanted {
			return table
		}
	}

	return nil
}

func readSchemaTables(db *datastore.Database) ([]*schemas.Table, error) {
	return readSchemaTablesWithContext(context.Background(), db)
}

func readSchemaTablesWithContext(c context.Context, db *datastore.Database) ([]*schemas.Table, error) {
	tables, err := db.SchemaTablesWithContext(c)

	if err != nil || db.DatabaseType() != settings.Sqlite3DbType {
		return tables, err
	}

	for index, table := range tables {
		if !strings.HasPrefix(normalizeIdentifier(table.Name), "pf_") {
			continue
		}

		hydrated, hydrateErr := readSQLiteTableWithContext(c, db, table)

		if hydrateErr != nil {
			return nil, hydrateErr
		}

		tables[index] = hydrated
	}

	return tables, nil
}

func readSQLiteTableWithContext(c context.Context, db *datastore.Database, metadata *schemas.Table) (*schemas.Table, error) {
	tableName := strings.ReplaceAll(metadata.Name, "\"", "\"\"")
	sess := db.NewSessionWithContext(c)

	rows, err := sess.QueryString(`PRAGMA table_info("` + tableName + `")`)

	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("read SQLite table %s: %w", metadata.Name, err)
	}

	createRows, err := sess.QueryString(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, metadata.Name)
	sess.Close()

	if err != nil {
		return nil, fmt.Errorf("read SQLite table definition %s: %w", metadata.Name, err)
	}

	hasAutoIncrement := len(createRows) == 1 && strings.Contains(strings.ToUpper(createRows[0]["sql"]), "AUTOINCREMENT")
	table := schemas.NewTable(metadata.Name, nil)
	table.Indexes, err = readSQLiteIndexesWithContext(c, db, metadata.Name)

	if err != nil {
		return nil, err
	}

	for _, row := range rows {
		columnType, length := splitSQLiteType(row["type"])
		notNull := row["notnull"] == "1"
		primaryKey := row["pk"] != "0" && row["pk"] != ""
		column := schemas.NewColumn(row["name"], "", schemas.SQLType{Name: columnType}, length, 0, !notNull)
		column.IsPrimaryKey = primaryKey
		column.IsAutoIncrement = primaryKey && hasAutoIncrement
		column.Default = row["dflt_value"]
		column.DefaultIsEmpty = row["dflt_value"] == ""
		table.AddColumn(column)
	}

	return table, nil
}

func readSQLiteIndexesWithContext(c context.Context, db *datastore.Database, tableName string) (map[string]*schemas.Index, error) {
	indexRows, err := querySchemaRows(c, db, "PRAGMA index_list("+quoteSQLiteIdentifier(tableName)+")")

	if err != nil {
		return nil, fmt.Errorf("read SQLite indexes for %s: %w", tableName, err)
	}

	indexes := make(map[string]*schemas.Index)

	for _, row := range indexRows {
		indexName := schemaRowValue(row, "name")

		if strings.HasPrefix(indexName, "sqlite_autoindex_") {
			continue
		}
		if schemaRowInt(row, "partial") == 1 {
			return nil, schemaError(tableName, fmt.Sprintf("index %s is partial", indexName))
		}

		if !isSafeCatalogIdentifier(indexName) {
			return nil, schemaError(tableName, fmt.Sprintf("index %s has an unsafe name", indexName))
		}

		indexType := schemas.IndexType

		if schemaRowInt(row, "unique") == 1 {
			indexType = schemas.UniqueType
		}

		columnRows, queryErr := querySchemaRows(c, db, "PRAGMA index_xinfo("+quoteSQLiteIdentifier(indexName)+")")

		if queryErr != nil {
			return nil, fmt.Errorf("read SQLite index %s: %w", indexName, queryErr)
		}

		type indexedColumn struct {
			sequence int64
			name     string
		}

		columns := make([]indexedColumn, 0, len(columnRows))

		for _, columnRow := range columnRows {
			if schemaRowInt(columnRow, "key") != 1 {
				continue
			}

			columnName := schemaRowValue(columnRow, "name")

			if columnName == "" || schemaRowInt(columnRow, "cid") < 0 {
				return nil, schemaError(tableName, fmt.Sprintf("index %s contains an expression", indexName))
			}

			columns = append(columns, indexedColumn{sequence: schemaRowInt(columnRow, "seqno"), name: columnName})
		}

		sort.Slice(columns, func(left int, right int) bool {
			return columns[left].sequence < columns[right].sequence
		})

		index := schemas.NewIndex(indexName, indexType)

		for _, column := range columns {
			index.AddColumn(column.name)
		}

		indexes[indexName] = index
	}

	return indexes, nil
}

func splitSQLiteType(value string) (string, int64) {
	typeName := strings.ToUpper(strings.TrimSpace(value))
	openParenthesis := strings.IndexByte(typeName, '(')

	if openParenthesis < 0 || !strings.HasSuffix(typeName, ")") {
		return typeName, 0
	}

	length, err := strconv.ParseInt(strings.TrimSpace(typeName[openParenthesis+1:len(typeName)-1]), 10, 64)

	if err != nil {
		return typeName, 0
	}

	return strings.TrimSpace(typeName[:openParenthesis]), length
}

func verifyTable(databaseType string, expected *schemas.Table, actual *schemas.Table, mode schemaVerificationMode) error {
	expectedColumns := make(map[string]*schemas.Column, len(expected.Columns()))

	for _, column := range expected.Columns() {
		expectedColumns[normalizeIdentifier(column.Name)] = column
	}

	actualColumns := make(map[string]*schemas.Column, len(actual.Columns()))

	for _, column := range actual.Columns() {
		columnName := normalizeIdentifier(column.Name)
		expectedColumn := expectedColumns[columnName]

		if expectedColumn == nil {
			return schemaError(expected.Name, fmt.Sprintf("unknown column %s", column.Name))
		}

		if err := verifyColumn(databaseType, expected.Name, expectedColumn, column); err != nil {
			return err
		}

		actualColumns[columnName] = column
	}

	// Sync2 不能跨三库安全修复缺失主键或给历史行补无默认值的非空列。
	// 因此兼容预检只允许整张表缺失，或完整列集仅缺预期索引。
	for columnName := range expectedColumns {
		if actualColumns[columnName] == nil {
			return schemaError(expected.Name, fmt.Sprintf("column %s is missing", columnName))
		}
	}

	if err := verifyPrimaryKeys(expected, actual); err != nil {
		return err
	}

	return verifyIndexes(expected, actual, mode)
}

func verifyColumn(databaseType string, tableName string, expected *schemas.Column, actual *schemas.Column) error {
	expectedType := normalizedSQLType(databaseType, expected)
	actualType := normalizedSQLType(databaseType, actual)

	if expectedType != actualType {
		return schemaError(tableName, fmt.Sprintf("column %s type is %s, expected %s", actual.Name, actualType, expectedType))
	}

	if shouldCompareLength(databaseType, expectedType) && expected.Length != actual.Length {
		return schemaError(tableName, fmt.Sprintf("column %s length is %d, expected %d", actual.Name, actual.Length, expected.Length))
	}

	if expected.Nullable != actual.Nullable {
		return schemaError(tableName, fmt.Sprintf("column %s nullable is %t, expected %t", actual.Name, actual.Nullable, expected.Nullable))
	}

	if expected.IsPrimaryKey != actual.IsPrimaryKey {
		return schemaError(tableName, fmt.Sprintf("column %s primary-key flag is %t, expected %t", actual.Name, actual.IsPrimaryKey, expected.IsPrimaryKey))
	}

	if expected.IsAutoIncrement != actual.IsAutoIncrement {
		return schemaError(tableName, fmt.Sprintf("column %s auto-increment flag is %t, expected %t", actual.Name, actual.IsAutoIncrement, expected.IsAutoIncrement))
	}

	if expected.DefaultIsEmpty != actual.DefaultIsEmpty {
		return schemaError(tableName, fmt.Sprintf("column %s default presence differs", actual.Name))
	}

	if !expected.DefaultIsEmpty && strings.TrimSpace(expected.Default) != strings.TrimSpace(actual.Default) {
		return schemaError(tableName, fmt.Sprintf("column %s default differs", actual.Name))
	}

	return nil
}

func verifyPrimaryKeys(expected *schemas.Table, actual *schemas.Table) error {
	expectedKeys := normalizedIdentifiers(expected.PrimaryKeys)
	actualKeys := normalizedIdentifiers(actual.PrimaryKeys)

	if !equalStrings(expectedKeys, actualKeys) {
		return schemaError(expected.Name, fmt.Sprintf("primary key is %v, expected %v", actualKeys, expectedKeys))
	}

	return nil
}

func verifyIndexes(expected *schemas.Table, actual *schemas.Table, mode schemaVerificationMode) error {
	expectedIndexes := physicalIndexes(expected)
	actualIndexes := physicalIndexes(actual)

	for indexName, actualIndex := range actualIndexes {
		expectedIndex := expectedIndexes[indexName]

		if expectedIndex == nil {
			return schemaError(expected.Name, fmt.Sprintf("unknown index %s", indexName))
		}

		if expectedIndex.Type != actualIndex.Type {
			return schemaError(expected.Name, fmt.Sprintf("index %s uniqueness differs", indexName))
		}

		expectedColumns := normalizedIdentifiers(expectedIndex.Cols)
		actualColumns := normalizedIdentifiers(actualIndex.Cols)

		if !equalStrings(expectedColumns, actualColumns) {
			return schemaError(expected.Name, fmt.Sprintf("index %s columns are %v, expected %v", indexName, actualColumns, expectedColumns))
		}
	}

	if mode == schemaExact {
		for indexName := range expectedIndexes {
			if actualIndexes[indexName] == nil {
				return schemaError(expected.Name, fmt.Sprintf("index %s is missing", indexName))
			}
		}
	}

	return nil
}

func physicalIndexes(table *schemas.Table) map[string]*schemas.Index {
	indexes := make(map[string]*schemas.Index, len(table.Indexes))

	for _, index := range table.Indexes {
		physicalName := normalizeIdentifier(index.XName(table.Name))
		indexes[physicalName] = index
	}

	return indexes
}

func normalizedSQLType(databaseType string, column *schemas.Column) string {
	typeName := strings.ToUpper(strings.TrimSpace(column.SQLType.Name))

	if baseType, _, found := strings.Cut(typeName, "("); found {
		typeName = strings.TrimSpace(baseType)
	}

	switch databaseType {
	case settings.Sqlite3DbType:
		if column.SQLType.IsNumeric() || column.SQLType.IsBool() || strings.Contains(typeName, "INT") || typeName == "BOOL" || typeName == "BOOLEAN" {
			return "INTEGER"
		}

		if column.SQLType.IsText() || strings.Contains(typeName, "CHAR") || strings.Contains(typeName, "CLOB") || strings.Contains(typeName, "TEXT") {
			return "TEXT"
		}
	case settings.MySqlDbType:
		if typeName == "BOOL" || typeName == "BOOLEAN" || (typeName == "TINYINT" && column.Length == 1) {
			return "BOOLEAN"
		}
	case settings.PostgresDbType:
		switch typeName {
		case "INT8":
			return "BIGINT"
		case "INT2":
			return "SMALLINT"
		case "BOOL":
			return "BOOLEAN"
		case "CHARACTER VARYING":
			return "VARCHAR"
		case "CHARACTER":
			return "CHAR"
		}
	}

	return typeName
}

func shouldCompareLength(databaseType string, normalizedType string) bool {
	if databaseType == settings.Sqlite3DbType {
		return false
	}

	return normalizedType == "CHAR" || normalizedType == "VARCHAR"
}

func normalizedIdentifiers(values []string) []string {
	normalized := make([]string, len(values))

	for index, value := range values {
		normalized[index] = normalizeIdentifier(value)
	}

	return normalized
}

func normalizeIdentifier(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "`\"[]"))
}

func equalStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}

	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}

	return true
}

func schemaError(tableName string, detail string) error {
	if tableName == "" {
		return fmt.Errorf("%w: %s", ErrMigrationSchemaInvalid, detail)
	}

	return fmt.Errorf("%w: table %s: %s", ErrMigrationSchemaInvalid, tableName, detail)
}
