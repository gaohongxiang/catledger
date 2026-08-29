package datastore

import (
	"fmt"
	"regexp"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/settings"
)

var userDataTableNamePattern = regexp.MustCompile(`^pf_[a-z0-9_]+$`)

// UserDataStore 用当前 uid 分片执行用户表计数和单一隐私事务删除。
type UserDataStore struct {
	store *DataStore
}

// NewUserDataStore 创建用户数据清理/计数执行器。
func NewUserDataStore(store *DataStore) (*UserDataStore, error) {
	if store == nil || store.Count() < 1 {
		return nil, fmt.Errorf("user data store requires a user data database")
	}
	return &UserDataStore{store: store}, nil
}

func (s *UserDataStore) CountUserTable(c core.Context, uid int64, table string) (int64, error) {
	database, quoted, err := s.prepare(uid, table)
	if err != nil {
		return 0, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	row := struct {
		Count int64 `xorm:"count"`
	}{}
	has, err := sess.SQL("SELECT COUNT(*) AS count FROM "+quoted+" WHERE uid=?", uid).Get(&row)
	if err != nil {
		return 0, fmt.Errorf("count user data table: %w", err)
	}
	if !has {
		return 0, nil
	}
	return row.Count, nil
}

func (s *UserDataStore) DeleteUserTables(c core.Context, uid int64, tables []string) error {
	if s == nil || s.store == nil || uid < 1 {
		return fmt.Errorf("invalid user data delete")
	}
	if len(tables) == 0 {
		return nil
	}
	quotedTables := make([]string, 0, len(tables))
	var database *Database
	for _, table := range tables {
		db, quoted, err := s.prepare(uid, table)
		if err != nil {
			return err
		}
		database = db
		quotedTables = append(quotedTables, quoted)
	}
	return database.DoPrivacyTransaction(c, func(sess *xorm.Session) error {
		for _, quoted := range quotedTables {
			if _, err := sess.Exec("DELETE FROM "+quoted+" WHERE uid=?", uid); err != nil {
				return fmt.Errorf("delete user data table: %w", err)
			}
		}
		return nil
	})
}

func (s *UserDataStore) prepare(uid int64, table string) (*Database, string, error) {
	if s == nil || s.store == nil || uid < 1 || !userDataTableNamePattern.MatchString(table) || table == "pf_schema_migration" {
		return nil, "", fmt.Errorf("invalid user data table %s", table)
	}
	database := s.store.Choose(uid)
	if database == nil {
		return nil, "", fmt.Errorf("user data database is unavailable")
	}
	return database, quoteUserDataTable(database.DatabaseType(), table), nil
}

func quoteUserDataTable(databaseType string, table string) string {
	if databaseType == settings.MySqlDbType {
		return "`" + table + "`"
	}
	return `"` + table + `"`
}
