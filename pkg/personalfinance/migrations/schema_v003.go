package migrations

// 下列结构只属于已发布的 v003 迁移，后续运行模型变化时不得修改。

type reconciliationCaseV003 struct {
	Uid                   int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_uid_key) INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	CaseKey               string `xorm:"CHAR(64) UNIQUE(UQE_pf_reconciliation_case_uid_key) NOT NULL"`
	CaseKeyVersion        string `xorm:"VARCHAR(32) NOT NULL"`
	Status                string `xorm:"VARCHAR(32) INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	Version               int64  `xorm:"BIGINT NOT NULL"`
	MemberCount           int64  `xorm:"BIGINT NOT NULL"`
	SuggestedRelationType string `xorm:"VARCHAR(32) NOT NULL"`
	CandidateScore        int64  `xorm:"BIGINT NOT NULL"`
	CandidateRuleVersion  string `xorm:"VARCHAR(32) NOT NULL"`
	ExplanationVersion    string `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson       string `xorm:"TEXT NOT NULL"`
	CurrentDecisionId     *int64 `xorm:"BIGINT NULL"`
	CreatedUnixTime       int64  `xorm:"BIGINT NOT NULL"`
	LastEvaluatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	CaseId                int64  `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
}

func (reconciliationCaseV003) TableName() string {
	return "pf_reconciliation_case"
}

type reconciliationCaseMemberV003 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	CaseId          int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) NOT NULL"`
	MemberOrder     int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) NOT NULL"`
	MemberKind      string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	MemberRefId     int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	MemberRole      string `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	MemberId        int64  `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
}

func (reconciliationCaseMemberV003) TableName() string {
	return "pf_reconciliation_case_member"
}

type reconciliationDecisionV003 struct {
	Uid                   int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_decision_uid_key) INDEX(IDX_pf_reconciliation_decision_uid_case_created) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	CaseId                int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_case_created) NOT NULL"`
	ExpectedCaseVersion   int64  `xorm:"BIGINT NOT NULL"`
	AppliedCaseVersion    int64  `xorm:"BIGINT NOT NULL"`
	DecisionType          string `xorm:"VARCHAR(32) NOT NULL"`
	PreviousDecisionId    *int64 `xorm:"BIGINT NULL"`
	IdempotencyKeyDigest  string `xorm:"CHAR(64) UNIQUE(UQE_pf_reconciliation_decision_uid_key) NOT NULL"`
	IdempotencyKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  string `xorm:"VARCHAR(32) NOT NULL"`
	Status                string `xorm:"VARCHAR(32) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	FieldSelectionJson    string `xorm:"TEXT NOT NULL"`
	ReasonCodesJson       string `xorm:"TEXT NOT NULL"`
	ErrorCode             string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_case_created) NOT NULL"`
	StartedUnixTime       *int64 `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64 `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64 `xorm:"BIGINT NULL"`
	UpdatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	DecisionId            int64  `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_decision_uid_case_created) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
}

func (reconciliationDecisionV003) TableName() string {
	return "pf_reconciliation_decision"
}

type reconciliationTransactionLinkV003 struct {
	Uid                        int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_decision) INDEX(IDX_pf_reconciliation_tx_link_uid_row) INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
	DecisionId                 int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_decision) NOT NULL"`
	RowId                      int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_row) NOT NULL"`
	TransactionId              int64  `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
	RelationRole               string `xorm:"VARCHAR(32) NOT NULL"`
	CreationMethod             string `xorm:"VARCHAR(32) NOT NULL"`
	RuleVersion                string `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64  `xorm:"BIGINT NOT NULL"`
	LinkId                     int64  `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_tx_link_uid_decision) INDEX(IDX_pf_reconciliation_tx_link_uid_row) INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
}

func (reconciliationTransactionLinkV003) TableName() string {
	return "pf_reconciliation_transaction_link"
}

type reconciliationLedgerEffectV003 struct {
	Uid                        int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
	DecisionId                 int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) NOT NULL"`
	TransactionId              int64  `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
	EffectType                 string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) NOT NULL"`
	TransactionUpdatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	TransactionDeletedUnixTime *int64 `xorm:"BIGINT NULL"`
	CreatedUnixTime            int64  `xorm:"BIGINT NOT NULL"`
	EffectId                   int64  `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
}

func (reconciliationLedgerEffectV003) TableName() string {
	return "pf_reconciliation_ledger_effect"
}

func schemaBeansV003() []any {
	return []any{
		new(reconciliationCaseV003),
		new(reconciliationCaseMemberV003),
		new(reconciliationDecisionV003),
		new(reconciliationTransactionLinkV003),
		new(reconciliationLedgerEffectV003),
	}
}

func schemaBeansThroughV003() []any {
	beans := make([]any, 0, len(schemaBeansThroughV002())+len(schemaBeansV003()))
	beans = append(beans, schemaBeansThroughV002()...)
	beans = append(beans, schemaBeansV003()...)
	return beans
}
