package reconciliation

// Case 保存两个稳定证据成员组成的跨来源人工对账 case。
type Case struct {
	Uid                   int64        `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_uid_key) INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	CaseKey               string       `xorm:"CHAR(64) UNIQUE(UQE_pf_reconciliation_case_uid_key) NOT NULL"`
	CaseKeyVersion        RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	Status                CaseStatus   `xorm:"VARCHAR(32) INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	Version               int64        `xorm:"BIGINT NOT NULL"`
	MemberCount           int64        `xorm:"BIGINT NOT NULL"`
	SuggestedRelationType DecisionType `xorm:"VARCHAR(32) NOT NULL"`
	CandidateScore        int64        `xorm:"BIGINT NOT NULL"`
	CandidateRuleVersion  RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	ExplanationVersion    RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson       string       `xorm:"TEXT NOT NULL"`
	CurrentDecisionId     *int64       `xorm:"BIGINT NULL"`
	CreatedUnixTime       int64        `xorm:"BIGINT NOT NULL"`
	LastEvaluatedUnixTime int64        `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime       int64        `xorm:"BIGINT INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
	CaseId                int64        `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_case_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Case) TableName() string {
	return "pf_reconciliation_case"
}

// CaseMember 保存 case 中不可空、可稳定排序的证据引用。
type CaseMember struct {
	Uid             int64      `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	CaseId          int64      `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) NOT NULL"`
	MemberOrder     int64      `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_order) NOT NULL"`
	MemberKind      MemberKind `xorm:"VARCHAR(32) UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	MemberRefId     int64      `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_case_member_uid_ref) INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
	MemberRole      MemberRole `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime int64      `xorm:"BIGINT NOT NULL"`
	MemberId        int64      `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_case_member_uid_lookup) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (CaseMember) TableName() string {
	return "pf_reconciliation_case_member"
}

// Decision 保存一次追加式、持久幂等的人工对账决定命令。
type Decision struct {
	Uid                   int64          `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_decision_uid_key) INDEX(IDX_pf_reconciliation_decision_uid_case_created) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	CaseId                int64          `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_case_created) NOT NULL"`
	ExpectedCaseVersion   int64          `xorm:"BIGINT NOT NULL"`
	AppliedCaseVersion    int64          `xorm:"BIGINT NOT NULL"`
	DecisionType          DecisionType   `xorm:"VARCHAR(32) NOT NULL"`
	PreviousDecisionId    *int64         `xorm:"BIGINT NULL"`
	IdempotencyKeyDigest  string         `xorm:"CHAR(64) UNIQUE(UQE_pf_reconciliation_decision_uid_key) NOT NULL"`
	IdempotencyKeyVersion RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string         `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	Status                DecisionStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	FieldSelectionJson    string         `xorm:"TEXT NOT NULL"`
	ReasonCodesJson       string         `xorm:"TEXT NOT NULL"`
	ErrorCode             string         `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64          `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_case_created) NOT NULL"`
	StartedUnixTime       *int64         `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64         `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64         `xorm:"BIGINT NULL"`
	UpdatedUnixTime       int64          `xorm:"BIGINT INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
	DecisionId            int64          `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_decision_uid_case_created) INDEX(IDX_pf_reconciliation_decision_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Decision) TableName() string {
	return "pf_reconciliation_decision"
}

// TransactionLink 保存当前或历史决定建立的多来源证据关系。
type TransactionLink struct {
	Uid                        int64                     `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_decision) INDEX(IDX_pf_reconciliation_tx_link_uid_row) INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
	DecisionId                 int64                     `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_decision) NOT NULL"`
	RowId                      int64                     `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_row) NOT NULL"`
	TransactionId              int64                     `xorm:"BIGINT INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
	RelationRole               TransactionRelationRole   `xorm:"VARCHAR(32) NOT NULL"`
	CreationMethod             TransactionCreationMethod `xorm:"VARCHAR(32) NOT NULL"`
	RuleVersion                RuleVersion               `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64                     `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64                     `xorm:"BIGINT NOT NULL"`
	LinkId                     int64                     `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_tx_link_uid_decision) INDEX(IDX_pf_reconciliation_tx_link_uid_row) INDEX(IDX_pf_reconciliation_tx_link_uid_transaction) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (TransactionLink) TableName() string {
	return "pf_reconciliation_transaction_link"
}

// LedgerEffect 保存决定对正式账本产生的可撤销效果。
type LedgerEffect struct {
	Uid                        int64            `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
	DecisionId                 int64            `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) NOT NULL"`
	TransactionId              int64            `xorm:"BIGINT UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
	EffectType                 LedgerEffectType `xorm:"VARCHAR(32) UNIQUE(UQE_pf_reconciliation_effect_uid_decision_tx_type) NOT NULL"`
	TransactionUpdatedUnixTime int64            `xorm:"BIGINT NOT NULL"`
	TransactionDeletedUnixTime *int64           `xorm:"BIGINT NULL"`
	CreatedUnixTime            int64            `xorm:"BIGINT NOT NULL"`
	EffectId                   int64            `xorm:"BIGINT PK INDEX(IDX_pf_reconciliation_effect_uid_transaction) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (LedgerEffect) TableName() string {
	return "pf_reconciliation_ledger_effect"
}
