package cardcycle

// CycleRule 保存某张信用卡的常规账单日规则 revision；旧行不改写。
type CycleRule struct {
	Uid             int64      `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	LedgerAccountId int64      `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	RuleNumber      int64      `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) NOT NULL"`
	StatementDay    int64      `xorm:"BIGINT NOT NULL"`
	DueDay          int64      `xorm:"BIGINT NOT NULL"`
	EffectiveFrom   string     `xorm:"CHAR(10) NOT NULL"`
	Status          RuleStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	CreatedUnixTime int64      `xorm:"BIGINT NOT NULL"`
	RuleId          int64      `xorm:"BIGINT PK INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (CycleRule) TableName() string {
	return "pf_card_cycle_rule"
}

// StatementCoverage 保存一份信用卡账单的实际覆盖区间。
type StatementCoverage struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_cov_uid_batch) INDEX(IDX_pf_card_cov_uid_account_period) NOT NULL"`
	LedgerAccountId int64  `xorm:"BIGINT INDEX(IDX_pf_card_cov_uid_account_period) NOT NULL"`
	BatchId         int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_cov_uid_batch) NOT NULL"`
	PeriodStart     string `xorm:"CHAR(10) NOT NULL"`
	PeriodEnd       string `xorm:"CHAR(10) INDEX(IDX_pf_card_cov_uid_account_period) NOT NULL"`
	StatementDate   string `xorm:"CHAR(10) NOT NULL"`
	DueDate         string `xorm:"CHAR(10) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	CoverageId      int64  `xorm:"BIGINT PK INDEX(IDX_pf_card_cov_uid_account_period) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (StatementCoverage) TableName() string {
	return "pf_card_statement_coverage"
}

// MonthReportRevision 记录迟到账单引起的历史自然月修订，不是硬月结锁。
type MonthReportRevision struct {
	Uid             int64  `xorm:"BIGINT INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	YearMonth       string `xorm:"CHAR(7) INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	TaskId          int64  `xorm:"BIGINT NOT NULL"`
	ReasonCode      string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	RevisionId      int64  `xorm:"BIGINT PK INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (MonthReportRevision) TableName() string {
	return "pf_month_report_revision"
}

// BalanceReview 把正式账户的余额核对状态保存在 PF 域，不修改核心账户表。
type BalanceReview struct {
	Uid             int64               `xorm:"BIGINT UNIQUE(UQE_pf_bal_review_uid_account) NOT NULL"`
	LedgerAccountId int64               `xorm:"BIGINT UNIQUE(UQE_pf_bal_review_uid_account) NOT NULL"`
	Status          BalanceReviewStatus `xorm:"VARCHAR(32) NOT NULL"`
	AsOfDate        string              `xorm:"CHAR(10) NOT NULL"`
	Version         int64               `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime int64               `xorm:"BIGINT NOT NULL"`
	ReviewId        int64               `xorm:"BIGINT PK NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (BalanceReview) TableName() string {
	return "pf_account_balance_review"
}
