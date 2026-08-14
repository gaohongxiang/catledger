package migrations

// 下列结构只属于 v005 迁移。发布后不得修改；后续变化使用新迁移。
type paymentAccountMappingV005 struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	SourceType        string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	Currency          string `xorm:"VARCHAR(3) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	AliasKey          string `xorm:"CHAR(64) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	AliasKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId   int64  `xorm:"BIGINT INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	MaskedDisplayName string `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64  `xorm:"BIGINT INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	MappingId         int64  `xorm:"BIGINT PK INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
}

func (paymentAccountMappingV005) TableName() string {
	return "pf_payment_account_mapping"
}

func schemaBeansV005() []any {
	return []any{new(paymentAccountMappingV005)}
}

func schemaBeansThroughV005() []any {
	beans := make([]any, 0, len(schemaBeansThroughV004())+len(schemaBeansV005()))
	beans = append(beans, schemaBeansThroughV004()...)
	beans = append(beans, schemaBeansV005()...)
	return beans
}
