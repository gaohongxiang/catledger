package installments

// Candidate 是独立于正式贷款合同的待确认分期。
// 未知本金、应还、利息、费用、总期数和当前期次必须为 NULL，禁止用 0 冒充未知。
type Candidate struct {
	Uid                         int64            `xorm:"BIGINT UNIQUE(UQE_pf_inst_cand_uid_key) INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	CandidateKey                string           `xorm:"CHAR(64) UNIQUE(UQE_pf_inst_cand_uid_key) NOT NULL"`
	CandidateKeyVersion         RuleVersion      `xorm:"VARCHAR(32) NOT NULL"`
	Status                      CandidateStatus  `xorm:"VARCHAR(32) INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	Version                     int64            `xorm:"BIGINT NOT NULL"`
	LiabilityAccountId          *int64           `xorm:"BIGINT NULL"`
	TermCount                   *int64           `xorm:"BIGINT NULL"`
	LinkedContractId            *int64           `xorm:"BIGINT NULL"`
	PurchaseRelation            PurchaseRelation `xorm:"VARCHAR(32) NOT NULL"`
	LinkedPurchaseTransactionId *int64           `xorm:"BIGINT NULL"`
	PrincipalAmount             *int64           `xorm:"BIGINT NULL"`
	PaymentAmount               *int64           `xorm:"BIGINT NULL"`
	InterestAmount              *int64           `xorm:"BIGINT NULL"`
	FeeAmount                   *int64           `xorm:"BIGINT NULL"`
	RepaymentMethod             RepaymentMethod  `xorm:"VARCHAR(32) NOT NULL"`
	FirstDueDate                string           `xorm:"CHAR(10) NOT NULL"`
	CurrentPeriod               *int64           `xorm:"BIGINT NULL"`
	CreatedUnixTime             int64            `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime             int64            `xorm:"BIGINT INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
	CandidateId                 int64            `xorm:"BIGINT PK INDEX(IDX_pf_inst_cand_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Candidate) TableName() string {
	return "pf_installment_candidate"
}

// CandidateMember 把来源身份或原始行关联到分期候选。
type CandidateMember struct {
	Uid             int64      `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	CandidateId     int64      `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	MemberKind      MemberKind `xorm:"VARCHAR(32) UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) NOT NULL"`
	MemberRefId     int64      `xorm:"BIGINT UNIQUE(UQE_pf_inst_member_uid_cand_kind_ref) NOT NULL"`
	MemberRole      MemberRole `xorm:"VARCHAR(32) NOT NULL"`
	PeriodNumber    *int64     `xorm:"BIGINT NULL"`
	CreatedUnixTime int64      `xorm:"BIGINT INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
	MemberId        int64      `xorm:"BIGINT PK INDEX(IDX_pf_inst_member_uid_cand_created) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (CandidateMember) TableName() string {
	return "pf_installment_candidate_member"
}
