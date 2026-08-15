package core

import (
	"errors"
	"fmt"
	"regexp"
	"sync"
)

var (
	ErrUserDataHookInvalid      = errors.New("user data hook is invalid")
	ErrUserDataStoreUnavailable = errors.New("user data store is unavailable")
	ErrUserDataHookConflict     = errors.New("user data hook conflict")
)

var userDataTableNamePattern = regexp.MustCompile(`^pf_[a-z0-9_]+$`)

const schemaMigrationTableName = "pf_schema_migration"

// UserDataCount 是数据管理页使用的稳定码与脱敏计数。
type UserDataCount struct {
	Code  string `json:"code"`
	Count int64  `json:"count,string"`
}

// UserDataTable 声明一张带 uid 的用户表及其稳定计数码。
type UserDataTable struct {
	Name string
	Code string
}

// UserDataModule 是与 PF 模型无关的清理/计数钩子。
type UserDataModule struct {
	Name          string
	Tables        []UserDataTable
	DeleteObjects func(c Context, uid int64) error
}

// UserDataStore 在当前 uid 分片执行计数和单一隐私事务删除。
type UserDataStore interface {
	CountUserTable(c Context, uid int64, table string) (int64, error)
	DeleteUserTables(c Context, uid int64, tables []string) error
}

var (
	userDataMu      sync.Mutex
	userDataModules []UserDataModule
	userDataStore   UserDataStore
)

// SetUserDataStore 安装用户数据清理/计数的执行器。
func SetUserDataStore(store UserDataStore) {
	userDataMu.Lock()
	defer userDataMu.Unlock()
	userDataStore = store
}

// RegisterUserDataModule 按模块登记用户表。同名模块或表/计数码冲突时失败。
func RegisterUserDataModule(module UserDataModule) error {
	if err := validateUserDataModule(module); err != nil {
		return err
	}

	userDataMu.Lock()
	defer userDataMu.Unlock()
	for _, existing := range userDataModules {
		if existing.Name == module.Name {
			return fmt.Errorf("%w: module %s", ErrUserDataHookConflict, module.Name)
		}
		for _, existingTable := range existing.Tables {
			for _, table := range module.Tables {
				if existingTable.Name == table.Name || existingTable.Code == table.Code {
					return fmt.Errorf("%w: table %s code %s", ErrUserDataHookConflict, table.Name, table.Code)
				}
			}
		}
	}
	userDataModules = append(userDataModules, module)
	return nil
}

// ResetUserDataHooksForTest 清空钩子注册表，仅测试使用。
func ResetUserDataHooksForTest() {
	userDataMu.Lock()
	defer userDataMu.Unlock()
	userDataModules = nil
	userDataStore = nil
}

// RegisteredUserDataTableNames 返回已登记的用户表名，登记顺序即删除顺序。
func RegisteredUserDataTableNames() []string {
	userDataMu.Lock()
	defer userDataMu.Unlock()
	names := make([]string, 0)
	for _, module := range userDataModules {
		for _, table := range module.Tables {
			names = append(names, table.Name)
		}
	}
	return names
}

// CountUserData 汇总全部已登记用户表的脱敏计数。
func CountUserData(c Context, uid int64) ([]UserDataCount, error) {
	if uid < 1 {
		return nil, ErrUserDataHookInvalid
	}
	userDataMu.Lock()
	store := userDataStore
	modules := append([]UserDataModule(nil), userDataModules...)
	userDataMu.Unlock()
	if store == nil {
		return nil, ErrUserDataStoreUnavailable
	}
	counts := make([]UserDataCount, 0)
	for _, module := range modules {
		for _, table := range module.Tables {
			count, err := store.CountUserTable(c, uid, table.Name)
			if err != nil {
				return nil, err
			}
			counts = append(counts, UserDataCount{Code: table.Code, Count: count})
		}
	}
	return counts, nil
}

// ClearUserData 先幂等删除已登记对象，再在单一隐私事务内按登记顺序删除全部用户表行。
func ClearUserData(c Context, uid int64) error {
	if uid < 1 {
		return ErrUserDataHookInvalid
	}
	userDataMu.Lock()
	store := userDataStore
	modules := append([]UserDataModule(nil), userDataModules...)
	userDataMu.Unlock()
	if store == nil {
		return ErrUserDataStoreUnavailable
	}
	for _, module := range modules {
		if module.DeleteObjects == nil {
			continue
		}
		if err := module.DeleteObjects(c, uid); err != nil {
			return err
		}
	}
	tables := make([]string, 0)
	for _, module := range modules {
		for _, table := range module.Tables {
			tables = append(tables, table.Name)
		}
	}
	return store.DeleteUserTables(c, uid, tables)
}

// UserDataCountOf 读取指定稳定码的计数，缺失时为 0。
func UserDataCountOf(counts []UserDataCount, code string) int64 {
	for _, item := range counts {
		if item.Code == code {
			return item.Count
		}
	}
	return 0
}

func validateUserDataModule(module UserDataModule) error {
	if module.Name == "" || len(module.Tables) == 0 {
		return ErrUserDataHookInvalid
	}
	seenName := make(map[string]struct{}, len(module.Tables))
	seenCode := make(map[string]struct{}, len(module.Tables))
	for _, table := range module.Tables {
		if !userDataTableNamePattern.MatchString(table.Name) || table.Name == schemaMigrationTableName || table.Code == "" {
			return fmt.Errorf("%w: table %s", ErrUserDataHookInvalid, table.Name)
		}
		if _, ok := seenName[table.Name]; ok {
			return fmt.Errorf("%w: duplicate table %s", ErrUserDataHookInvalid, table.Name)
		}
		if _, ok := seenCode[table.Code]; ok {
			return fmt.Errorf("%w: duplicate code %s", ErrUserDataHookInvalid, table.Code)
		}
		seenName[table.Name] = struct{}{}
		seenCode[table.Code] = struct{}{}
	}
	return nil
}

// UserDataTables 用表名同时作为稳定计数码。
func UserDataTables(names ...string) []UserDataTable {
	tables := make([]UserDataTable, 0, len(names))
	for _, name := range names {
		tables = append(tables, UserDataTable{Name: name, Code: name})
	}
	return tables
}
