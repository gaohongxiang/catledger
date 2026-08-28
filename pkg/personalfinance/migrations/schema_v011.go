package migrations

// 下列结构只属于 v011 迁移。发布后不得修改；后续变化使用新迁移。
type installmentContractDraftV011 struct {
	Uid              int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_draft_uid_candidate) NOT NULL"`
	CandidateId      int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_draft_uid_candidate) NOT NULL"`
	Version          int64  `xorm:"BIGINT NOT NULL"`
	ContractSpecJson string `xorm:"TEXT NOT NULL"`
	CreatedUnixTime  int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime  int64  `xorm:"BIGINT NOT NULL"`
	DraftId          int64  `xorm:"BIGINT PK NOT NULL"`
}

func (installmentContractDraftV011) TableName() string { return "pf_installment_contract_draft" }

func schemaBeansV011() []any { return []any{new(installmentContractDraftV011)} }

func schemaBeansThroughV011() []any {
	beans := make([]any, 0, len(schemaBeansThroughV010())+len(schemaBeansV011()))
	beans = append(beans, schemaBeansThroughV010()...)
	beans = append(beans, schemaBeansV011()...)
	return beans
}
