package migrations

// 下列结构只属于 v006 迁移。发布后不得修改；后续变化使用新迁移。

type billflowTaskV006 struct {
	Uid                 int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	Status              string `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	ConfirmPolicy       string `xorm:"VARCHAR(32) NOT NULL"`
	Version             int64  `xorm:"BIGINT NOT NULL"`
	CurrentActionId     *int64 `xorm:"BIGINT NULL"`
	CreatedAccountCount int64  `xorm:"BIGINT NOT NULL"`
	ReusedMappingCount  int64  `xorm:"BIGINT NOT NULL"`
	AutoPostedCount     int64  `xorm:"BIGINT NOT NULL"`
	TodoOpenCount       int64  `xorm:"BIGINT NOT NULL"`
	ErrorCode           string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime     int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime     int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	TaskId              int64  `xorm:"BIGINT PK INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
}

func (billflowTaskV006) TableName() string {
	return "pf_billflow_task"
}

type billflowTaskMemberV006 struct {
	Uid             int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) UNIQUE(UQE_pf_billflow_member_uid_batch) INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	TaskId          int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	MemberOrder     int64 `xorm:"BIGINT INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	FileId          int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) NOT NULL"`
	BatchId         int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_batch) NOT NULL"`
	CreatedUnixTime int64 `xorm:"BIGINT NOT NULL"`
	MemberId        int64 `xorm:"BIGINT PK INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
}

func (billflowTaskMemberV006) TableName() string {
	return "pf_billflow_task_member"
}

type billflowActionV006 struct {
	Uid                   int64  `xorm:"BIGINT UNIQUE(UQE_pf_billflow_action_uid_key) INDEX(IDX_pf_billflow_action_uid_task_created) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	TaskId                int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_task_created) NOT NULL"`
	ExpectedTaskVersion   int64  `xorm:"BIGINT NOT NULL"`
	AppliedTaskVersion    int64  `xorm:"BIGINT NOT NULL"`
	ActionType            string `xorm:"VARCHAR(32) NOT NULL"`
	PreviousActionId      *int64 `xorm:"BIGINT NULL"`
	IdempotencyKeyDigest  string `xorm:"CHAR(64) UNIQUE(UQE_pf_billflow_action_uid_key) NOT NULL"`
	IdempotencyKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  string `xorm:"VARCHAR(32) NOT NULL"`
	Status                string `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	ReasonCodesJson       string `xorm:"TEXT NOT NULL"`
	ErrorCode             string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_task_created) NOT NULL"`
	UpdatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	StartedUnixTime       *int64 `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64 `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64 `xorm:"BIGINT NULL"`
	ActionId              int64  `xorm:"BIGINT PK INDEX(IDX_pf_billflow_action_uid_task_created) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
}

func (billflowActionV006) TableName() string {
	return "pf_billflow_action"
}

type billflowTodoV006 struct {
	Uid              int64  `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	TaskId           int64  `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	TodoKind         string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	Status           string `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	SubjectKind      string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	SubjectId        int64  `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	ReasonCodesJson  string `xorm:"TEXT NOT NULL"`
	Version          int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime  int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime  int64  `xorm:"BIGINT INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	ResolvedUnixTime *int64 `xorm:"BIGINT NULL"`
	TodoId           int64  `xorm:"BIGINT PK INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
}

func (billflowTodoV006) TableName() string {
	return "pf_billflow_todo"
}

type categoryAliasMappingV006 struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	SourceType        string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	AliasKey          string `xorm:"CHAR(64) UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	AliasKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerCategoryId  int64  `xorm:"BIGINT NOT NULL"`
	MaskedDisplayName string `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	MappingId         int64  `xorm:"BIGINT PK NOT NULL"`
}

func (categoryAliasMappingV006) TableName() string {
	return "pf_category_alias_mapping"
}

type installmentCandidateV006 struct {
	Uid                         int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_cand_uid_key) INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	CandidateKey                string `xorm:"CHAR(64) UNIQUE(UQE_pf_inst_cand_uid_key) NOT NULL"`
	CandidateKeyVersion         string `xorm:"VARCHAR(32) NOT NULL"`
	Status                      string `xorm:"VARCHAR(32) INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	Version                     int64  `xorm:"BIGINT NOT NULL"`
	LiabilityAccountId          *int64 `xorm:"BIGINT NULL"`
	TermCount                   *int64 `xorm:"BIGINT NULL"`
	LinkedContractId            *int64 `xorm:"BIGINT NULL"`
	PurchaseRelation            string `xorm:"VARCHAR(32) NOT NULL"`
	LinkedPurchaseTransactionId *int64 `xorm:"BIGINT NULL"`
	PrincipalAmount             *int64 `xorm:"BIGINT NULL"`
	PaymentAmount               *int64 `xorm:"BIGINT NULL"`
	InterestAmount              *int64 `xorm:"BIGINT NULL"`
	FeeAmount                   *int64 `xorm:"BIGINT NULL"`
	RepaymentMethod             string `xorm:"VARCHAR(32) NOT NULL"`
	FirstDueDate                string `xorm:"CHAR(10) NOT NULL"`
	CurrentPeriod               *int64 `xorm:"BIGINT NULL"`
	CreatedUnixTime             int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime             int64  `xorm:"BIGINT INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	CandidateId                 int64  `xorm:"BIGINT PK INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
}

func (installmentCandidateV006) TableName() string {
	return "pf_installment_candidate"
}

type installmentCandidateMemberV006 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	CandidateId     int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	MemberKind      string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) NOT NULL"`
	MemberRefId     int64  `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) NOT NULL"`
	MemberRole      string `xorm:"VARCHAR(32) NOT NULL"`
	PeriodNumber    *int64 `xorm:"BIGINT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	MemberId        int64  `xorm:"BIGINT PK INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
}

func (installmentCandidateMemberV006) TableName() string {
	return "pf_installment_candidate_member"
}

type accountBalanceReviewV006 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_bal_review_uid_account) NOT NULL"`
	LedgerAccountId int64  `xorm:"BIGINT UNIQUE(UQE_pf_bal_review_uid_account) NOT NULL"`
	Status          string `xorm:"VARCHAR(32) NOT NULL"`
	AsOfDate        string `xorm:"CHAR(10) NOT NULL"`
	Version         int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	ReviewId        int64  `xorm:"BIGINT PK NOT NULL"`
}

func (accountBalanceReviewV006) TableName() string {
	return "pf_account_balance_review"
}

type cardCycleRuleV006 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	LedgerAccountId int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	RuleNumber      int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_rule_uid_account_number) NOT NULL"`
	StatementDay    int64  `xorm:"BIGINT NOT NULL"`
	DueDay          int64  `xorm:"BIGINT NOT NULL"`
	EffectiveFrom   string `xorm:"CHAR(10) NOT NULL"`
	Status          string `xorm:"VARCHAR(32) INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	RuleId          int64  `xorm:"BIGINT PK INDEX(IDX_pf_card_rule_uid_account_status) NOT NULL"`
}

func (cardCycleRuleV006) TableName() string {
	return "pf_card_cycle_rule"
}

type cardStatementCoverageV006 struct {
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

func (cardStatementCoverageV006) TableName() string {
	return "pf_card_statement_coverage"
}

type monthReportRevisionV006 struct {
	Uid             int64  `xorm:"BIGINT INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	YearMonth       string `xorm:"CHAR(7) INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	TaskId          int64  `xorm:"BIGINT NOT NULL"`
	ReasonCode      string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
	RevisionId      int64  `xorm:"BIGINT PK INDEX(IDX_pf_month_rev_uid_month_created) NOT NULL"`
}

func (monthReportRevisionV006) TableName() string {
	return "pf_month_report_revision"
}

func schemaBeansV006() []any {
	return []any{
		new(billflowTaskV006),
		new(billflowTaskMemberV006),
		new(billflowActionV006),
		new(billflowTodoV006),
		new(categoryAliasMappingV006),
		new(installmentCandidateV006),
		new(installmentCandidateMemberV006),
		new(accountBalanceReviewV006),
		new(cardCycleRuleV006),
		new(cardStatementCoverageV006),
		new(monthReportRevisionV006),
	}
}

func schemaBeansThroughV006() []any {
	beans := make([]any, 0, len(schemaBeansThroughV005())+len(schemaBeansV006()))
	beans = append(beans, schemaBeansThroughV005()...)
	beans = append(beans, schemaBeansV006()...)
	return beans
}
