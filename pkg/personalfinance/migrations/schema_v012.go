package migrations

// 下列结构只属于 v012 迁移。发布后不得修改；后续变化使用新迁移。
type loanProgressBaselineV012 struct {
	Uid                       int64 `xorm:"BIGINT UNIQUE(UQE_pf_loan_progress_baseline_uid_revision) INDEX(IDX_pf_loan_progress_baseline_uid_contract) NOT NULL"`
	ContractId                int64 `xorm:"BIGINT INDEX(IDX_pf_loan_progress_baseline_uid_contract) NOT NULL"`
	RevisionId                int64 `xorm:"BIGINT UNIQUE(UQE_pf_loan_progress_baseline_uid_revision) NOT NULL"`
	CompletedInstallmentCount int64 `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime           int64 `xorm:"BIGINT NOT NULL"`
	BaselineId                int64 `xorm:"BIGINT PK NOT NULL"`
}

func (loanProgressBaselineV012) TableName() string { return "pf_loan_progress_baseline" }

func schemaBeansV012() []any { return []any{new(loanProgressBaselineV012)} }

func schemaBeansThroughV012() []any {
	beans := make([]any, 0, len(schemaBeansThroughV011())+len(schemaBeansV012()))
	beans = append(beans, schemaBeansThroughV011()...)
	beans = append(beans, schemaBeansV012()...)
	return beans
}
