package datastore

import (
	"context"
	"fmt"
	"strings"

	"xorm.io/xorm"
	"xorm.io/xorm/schemas"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

// Database represents a database instance
type Database struct {
	databaseType string
	engineGroup  *xorm.EngineGroup
}

// DatabaseType returns the configured database driver type.
func (db *Database) DatabaseType() string {
	return db.databaseType
}

// Ping verifies that the database can be reached.
func (db *Database) Ping() error {
	return db.engineGroup.Ping()
}

// Close closes all connections owned by this database.
func (db *Database) Close() error {
	return db.engineGroup.Close()
}

// SyncStructs updates structs in this database instance only.
func (db *Database) SyncStructs(beans ...any) error {
	return db.SyncStructsWithContext(context.Background(), beans...)
}

// SyncStructsWithContext updates structs in this database instance and propagates cancellation.
func (db *Database) SyncStructsWithContext(c context.Context, beans ...any) error {
	sess := db.NewSessionWithContext(c)
	defer sess.Close()
	return sess.Sync2(beans...)
}

// SyncStructsWithStoreEngine updates structs and forces the MySQL table engine for newly created tables.
func (db *Database) SyncStructsWithStoreEngine(storeEngine string, beans ...any) error {
	return db.SyncStructsWithStoreEngineContext(context.Background(), storeEngine, beans...)
}

// SyncStructsWithStoreEngineContext updates structs with cancellation support and forces the
// MySQL table engine for newly created tables.
func (db *Database) SyncStructsWithStoreEngineContext(c context.Context, storeEngine string, beans ...any) error {
	sess := db.NewSessionWithContext(c)
	defer sess.Close()

	if db.databaseType == settings.MySqlDbType {
		sess.StoreEngine(storeEngine)
	}

	return sess.Sync2(beans...)
}

// TableInfo returns the schema described by a model without querying data.
func (db *Database) TableInfo(bean any) (*schemas.Table, error) {
	return db.engineGroup.TableInfo(bean)
}

// SchemaTables returns database metadata for schema verification.
func (db *Database) SchemaTables() ([]*schemas.Table, error) {
	return db.SchemaTablesWithContext(context.Background())
}

// SchemaTablesWithContext returns database metadata and propagates cancellation to every catalog query.
func (db *Database) SchemaTablesWithContext(c context.Context) ([]*schemas.Table, error) {
	if c == nil {
		c = context.Background()
	}

	engine := db.engineGroup.Master()
	dialect := engine.Dialect()
	queryer := engine.DB()
	tables, err := dialect.GetTables(queryer, c)

	if err != nil {
		return nil, err
	}

	for _, table := range tables {
		columnSequence, columns, columnsErr := dialect.GetColumns(queryer, c, table.Name)

		if columnsErr != nil {
			return nil, columnsErr
		}

		for _, columnName := range columnSequence {
			table.AddColumn(columns[columnName])
		}

		indexes, indexesErr := dialect.GetIndexes(queryer, c, table.Name)

		if indexesErr != nil {
			return nil, indexesErr
		}

		table.Indexes = indexes

		for _, index := range indexes {
			for _, indexedColumn := range index.Cols {
				columnName := strings.Trim(strings.Split(strings.TrimSpace(indexedColumn), " ")[0], `"`)
				column := table.GetColumn(columnName)

				if column == nil {
					return nil, fmt.Errorf("unknown column %s in index %s of table %s", columnName, index.Name, table.Name)
				}

				column.Indexes[index.Name] = index.Type
			}
		}
	}

	return tables, nil
}

// NewSession starts a new session with the specified context
func (db *Database) NewSession(c core.Context) *xorm.Session {
	return db.engineGroup.Context(NewXOrmContextAdapter(c))
}

// NewSessionWithContext starts a session with a standard cancellable context.
// It is intended for infrastructure operations that do not have an ezBookkeeping request context.
func (db *Database) NewSessionWithContext(c context.Context) *xorm.Session {
	if c == nil {
		c = context.Background()
	}

	sess := db.engineGroup.NewSession()
	sess.Context(c)
	return sess
}

// NewPrivacySession starts a session that never logs SQL arguments.
func (db *Database) NewPrivacySession(c core.Context) *xorm.Session {
	return db.engineGroup.Context(NewPrivacyXOrmContextAdapter(c))
}

// DoTransaction runs a new database transaction
func (db *Database) DoTransaction(c core.Context, fn func(sess *xorm.Session) error) (err error) {
	return db.doTransaction(c, false, fn)
}

// DoPrivacyTransaction runs a transaction with SQL argument logging disabled.
func (db *Database) DoPrivacyTransaction(c core.Context, fn func(sess *xorm.Session) error) (err error) {
	return db.doTransaction(c, true, fn)
}

func (db *Database) doTransaction(c core.Context, privacy bool, fn func(sess *xorm.Session) error) (err error) {
	sess := db.engineGroup.NewSession()

	if privacy {
		sess.Context(NewPrivacyXOrmContextAdapter(c))
	} else if c != nil {
		sess.Context(NewXOrmContextAdapter(c))
	}

	defer sess.Close()

	if err = sess.Begin(); err != nil {
		return err
	}

	if err = fn(sess); err != nil {
		_ = sess.Rollback()
		return err
	}

	if err = sess.Commit(); err != nil {
		return err
	}

	return nil
}

// SetSavePoint sets a save point in the current transaction for Postgres
func (db *Database) SetSavePoint(sess *xorm.Session, savePointName string) error {
	if db.databaseType == settings.PostgresDbType {
		_, err := sess.Exec("SAVEPOINT " + savePointName)
		return err
	}

	return nil
}

// RollbackToSavePoint rolls back to the specified save point in the current transaction for Postgres
func (db *Database) RollbackToSavePoint(sess *xorm.Session, savePointName string) error {
	if db.databaseType == settings.PostgresDbType {
		_, err := sess.Exec("ROLLBACK TO SAVEPOINT " + savePointName)
		return err
	}

	return nil
}
