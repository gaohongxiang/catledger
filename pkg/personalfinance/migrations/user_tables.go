package migrations

// UserDataTableNames 返回当前 schema 中全部带 uid 的 PF 用户表，不含迁移账本。
func UserDataTableNames() []string {
	beans := schemaBeansThroughV012()
	names := make([]string, 0, len(beans))
	for _, bean := range beans {
		named, ok := bean.(interface{ TableName() string })
		if !ok {
			continue
		}
		name := named.TableName()
		if name == "" || name == "pf_schema_migration" {
			continue
		}
		names = append(names, name)
	}
	return names
}
