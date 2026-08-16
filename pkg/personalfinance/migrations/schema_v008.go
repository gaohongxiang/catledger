package migrations

// 下列结构只属于 v008 迁移。发布后不得修改；后续变化使用新迁移。

type importBatchCardHeaderV008 struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_hdr_uid_batch) NOT NULL"`
	BatchId           int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_hdr_uid_batch) NOT NULL"`
	StatementDate     string `xorm:"CHAR(10) NOT NULL"`
	DueDate           string `xorm:"CHAR(10) NOT NULL"`
	CreditLimitAmount *int64 `xorm:"BIGINT NULL"`
	Currency          string `xorm:"VARCHAR(3) NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	HeaderId          int64  `xorm:"BIGINT PK NOT NULL"`
}

func (importBatchCardHeaderV008) TableName() string {
	return "pf_import_batch_card_header"
}

func schemaBeansV008() []any {
	return []any{new(importBatchCardHeaderV008)}
}

func schemaBeansThroughV008() []any {
	beans := make([]any, 0, len(schemaBeansThroughV007())+len(schemaBeansV008()))
	beans = append(beans, schemaBeansThroughV007()...)
	beans = append(beans, schemaBeansV008()...)
	return beans
}
