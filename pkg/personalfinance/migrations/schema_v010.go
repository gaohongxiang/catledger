package migrations

// 下列结构只属于 v010 迁移。发布后不得修改；后续变化使用新迁移。
type reviewIssueV010 struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_rev_issue_uid_update_key) INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	UpdateId          int64  `xorm:"BIGINT UNIQUE(UQE_pf_rev_issue_uid_update_key) INDEX(IDX_pf_rev_issue_uid_update_filter) NOT NULL"`
	Status            string `xorm:"VARCHAR(16) INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	IssueType         string `xorm:"VARCHAR(32) INDEX(IDX_pf_rev_issue_uid_update_filter) NOT NULL"`
	IssueKey          string `xorm:"CHAR(64) UNIQUE(UQE_pf_rev_issue_uid_update_key) NOT NULL"`
	IssueKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	Version           int64  `xorm:"BIGINT NOT NULL"`
	Blocking          bool   `xorm:"BOOLEAN NOT NULL"`
	PrimaryReasonCode string `xorm:"VARCHAR(64) NOT NULL"`
	MemberCount       int64  `xorm:"BIGINT NOT NULL"`
	CandidateCount    int64  `xorm:"BIGINT NOT NULL"`
	ResolvedActionId  *int64 `xorm:"BIGINT NULL"`
	RuleVersion       string `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson   string `xorm:"TEXT NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64  `xorm:"BIGINT INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	IssueId           int64  `xorm:"BIGINT PK INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
}

func (reviewIssueV010) TableName() string { return "pf_review_issue" }

type reviewIssueMemberV010 struct {
	Uid              int64  `xorm:"BIGINT UNIQUE(UQE_pf_rev_member_uid_issue_key) INDEX(IDX_pf_rev_member_uid_issue_order) INDEX(IDX_pf_rev_member_uid_object) INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
	UpdateId         int64  `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
	IssueId          int64  `xorm:"BIGINT UNIQUE(UQE_pf_rev_member_uid_issue_key) INDEX(IDX_pf_rev_member_uid_issue_order) NOT NULL"`
	MemberKey        string `xorm:"CHAR(64) UNIQUE(UQE_pf_rev_member_uid_issue_key) NOT NULL"`
	MemberKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	Role             string `xorm:"VARCHAR(16) NOT NULL"`
	ObjectType       string `xorm:"VARCHAR(24) INDEX(IDX_pf_rev_member_uid_object) NOT NULL"`
	ObjectId         int64  `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_object) NOT NULL"`
	ObjectVersion    int64  `xorm:"BIGINT NOT NULL"`
	SortOrder        int64  `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_issue_order) NOT NULL"`
	Score            int64  `xorm:"BIGINT NOT NULL"`
	ReasonCodesJson  string `xorm:"TEXT NOT NULL"`
	CreatedUnixTime  int64  `xorm:"BIGINT NOT NULL"`
	MemberId         int64  `xorm:"BIGINT PK INDEX(IDX_pf_rev_member_uid_issue_order) INDEX(IDX_pf_rev_member_uid_object) INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
}

func (reviewIssueMemberV010) TableName() string { return "pf_review_issue_member" }

func schemaBeansV010() []any {
	return []any{new(reviewIssueV010), new(reviewIssueMemberV010)}
}

func schemaBeansThroughV010() []any {
	beans := make([]any, 0, len(schemaBeansThroughV009())+len(schemaBeansV010()))
	beans = append(beans, schemaBeansThroughV009()...)
	beans = append(beans, schemaBeansV010()...)
	return beans
}
