package migrations

// 下列结构只属于 v007 迁移。发布后不得修改；后续变化使用新迁移。

type paymentAccountExclusionV007 struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
	SourceType        string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	Currency          string `xorm:"VARCHAR(3) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	AliasKey          string `xorm:"CHAR(64) UNIQUE(UQE_pf_payacct_excl_uid_type_currency_key) NOT NULL"`
	AliasKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	MaskedDisplayName string `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64  `xorm:"BIGINT INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
	ExclusionId       int64  `xorm:"BIGINT PK INDEX(IDX_pf_payacct_excl_uid_updated) NOT NULL"`
}

func (paymentAccountExclusionV007) TableName() string {
	return "pf_payment_account_exclusion"
}

func schemaBeansV007() []any {
	return []any{new(paymentAccountExclusionV007)}
}

func schemaBeansThroughV007() []any {
	beans := make([]any, 0, len(schemaBeansThroughV006())+len(schemaBeansV007()))
	beans = append(beans, schemaBeansThroughV006()...)
	beans = append(beans, schemaBeansV007()...)
	return beans
}
