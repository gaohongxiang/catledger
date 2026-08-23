package organizer

// ReviewIssueType 表示用户仍需完成的业务决定。
type ReviewIssueType string

const (
	REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING   ReviewIssueType = "account_mapping"
	REVIEW_ISSUE_TYPE_SHARED_FIELDS     ReviewIssueType = "shared_fields"
	REVIEW_ISSUE_TYPE_SAME_EVENT        ReviewIssueType = "same_event"
	REVIEW_ISSUE_TYPE_REFUND_RELATION   ReviewIssueType = "refund_relation"
	REVIEW_ISSUE_TYPE_TRANSFER_ACCOUNTS ReviewIssueType = "transfer_accounts"
	REVIEW_ISSUE_TYPE_IDENTITY_CONFLICT ReviewIssueType = "identity_conflict"
	REVIEW_ISSUE_TYPE_FIELD_CONFLICT    ReviewIssueType = "field_conflict"
)

// ReviewIssueStatus 表示稳定评审问题的生命周期。
type ReviewIssueStatus string

const (
	REVIEW_ISSUE_STATUS_OPEN       ReviewIssueStatus = "open"
	REVIEW_ISSUE_STATUS_RESOLVED   ReviewIssueStatus = "resolved"
	REVIEW_ISSUE_STATUS_SUPERSEDED ReviewIssueStatus = "superseded"
)

// ReviewIssueMemberRole 表示对象在评审问题中的角色。
type ReviewIssueMemberRole string

const (
	REVIEW_ISSUE_MEMBER_ROLE_SUBJECT    ReviewIssueMemberRole = "subject"
	REVIEW_ISSUE_MEMBER_ROLE_CANDIDATE  ReviewIssueMemberRole = "candidate"
	REVIEW_ISSUE_MEMBER_ROLE_SUPPORTING ReviewIssueMemberRole = "supporting"
)

// ReviewObjectType 使用显式对象类型避免可空多态列，并保留后续扩展能力。
type ReviewObjectType string

const (
	REVIEW_OBJECT_TYPE_EVENT          ReviewObjectType = "event"
	REVIEW_OBJECT_TYPE_EVIDENCE       ReviewObjectType = "evidence"
	REVIEW_OBJECT_TYPE_RELATION       ReviewObjectType = "relation"
	REVIEW_OBJECT_TYPE_TRANSACTION    ReviewObjectType = "transaction"
	REVIEW_OBJECT_TYPE_SOURCE_ACCOUNT ReviewObjectType = "source_account"
)

const (
	PLAN_VERSION_V2                    RuleVersion = "organizer-plan-v2"
	REVIEW_ISSUE_KEY_VERSION_V1        RuleVersion = "review-issue-key-v1"
	REVIEW_ISSUE_MEMBER_KEY_VERSION_V1 RuleVersion = "review-issue-member-key-v1"
	REVIEW_ISSUE_RULE_VERSION_V1       RuleVersion = "review-issue-v1"
)

// ReviewIssue 是稳定、可分页、可审计的用户决定，不直接影响余额。
type ReviewIssue struct {
	Uid               int64             `xorm:"BIGINT UNIQUE(UQE_pf_rev_issue_uid_update_key) INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	UpdateId          int64             `xorm:"BIGINT UNIQUE(UQE_pf_rev_issue_uid_update_key) INDEX(IDX_pf_rev_issue_uid_update_filter) NOT NULL"`
	Status            ReviewIssueStatus `xorm:"VARCHAR(16) INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	IssueType         ReviewIssueType   `xorm:"VARCHAR(32) INDEX(IDX_pf_rev_issue_uid_update_filter) NOT NULL"`
	IssueKey          string            `xorm:"CHAR(64) UNIQUE(UQE_pf_rev_issue_uid_update_key) NOT NULL"`
	IssueKeyVersion   RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	Version           int64             `xorm:"BIGINT NOT NULL"`
	Blocking          bool              `xorm:"BOOLEAN NOT NULL"`
	PrimaryReasonCode string            `xorm:"VARCHAR(64) NOT NULL"`
	MemberCount       int64             `xorm:"BIGINT NOT NULL"`
	CandidateCount    int64             `xorm:"BIGINT NOT NULL"`
	ResolvedActionId  *int64            `xorm:"BIGINT NULL"`
	RuleVersion       RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson   string            `xorm:"TEXT NOT NULL"`
	CreatedUnixTime   int64             `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64             `xorm:"BIGINT INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
	IssueId           int64             `xorm:"BIGINT PK INDEX(IDX_pf_rev_issue_uid_update_filter) INDEX(IDX_pf_rev_issue_uid_status_updated) NOT NULL"`
}

func (ReviewIssue) TableName() string { return "pf_review_issue" }

// ReviewIssueMember 保存事件或候选对象的带版本引用。
type ReviewIssueMember struct {
	Uid              int64                 `xorm:"BIGINT UNIQUE(UQE_pf_rev_member_uid_issue_key) INDEX(IDX_pf_rev_member_uid_issue_order) INDEX(IDX_pf_rev_member_uid_object) INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
	UpdateId         int64                 `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
	IssueId          int64                 `xorm:"BIGINT UNIQUE(UQE_pf_rev_member_uid_issue_key) INDEX(IDX_pf_rev_member_uid_issue_order) NOT NULL"`
	MemberKey        string                `xorm:"CHAR(64) UNIQUE(UQE_pf_rev_member_uid_issue_key) NOT NULL"`
	MemberKeyVersion RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	Role             ReviewIssueMemberRole `xorm:"VARCHAR(16) NOT NULL"`
	ObjectType       ReviewObjectType      `xorm:"VARCHAR(24) INDEX(IDX_pf_rev_member_uid_object) NOT NULL"`
	ObjectId         int64                 `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_object) NOT NULL"`
	ObjectVersion    int64                 `xorm:"BIGINT NOT NULL"`
	SortOrder        int64                 `xorm:"BIGINT INDEX(IDX_pf_rev_member_uid_issue_order) NOT NULL"`
	Score            int64                 `xorm:"BIGINT NOT NULL"`
	ReasonCodesJson  string                `xorm:"TEXT NOT NULL"`
	CreatedUnixTime  int64                 `xorm:"BIGINT NOT NULL"`
	MemberId         int64                 `xorm:"BIGINT PK INDEX(IDX_pf_rev_member_uid_issue_order) INDEX(IDX_pf_rev_member_uid_object) INDEX(IDX_pf_rev_member_uid_update) NOT NULL"`
}

func (ReviewIssueMember) TableName() string { return "pf_review_issue_member" }

func isReviewIssueType(value ReviewIssueType) bool {
	switch value {
	case REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING, REVIEW_ISSUE_TYPE_SHARED_FIELDS, REVIEW_ISSUE_TYPE_SAME_EVENT,
		REVIEW_ISSUE_TYPE_REFUND_RELATION, REVIEW_ISSUE_TYPE_TRANSFER_ACCOUNTS, REVIEW_ISSUE_TYPE_IDENTITY_CONFLICT,
		REVIEW_ISSUE_TYPE_FIELD_CONFLICT:
		return true
	default:
		return false
	}
}

func isReviewIssueStatus(value ReviewIssueStatus) bool {
	return value == REVIEW_ISSUE_STATUS_OPEN || value == REVIEW_ISSUE_STATUS_RESOLVED || value == REVIEW_ISSUE_STATUS_SUPERSEDED
}

func isReviewIssueMemberRole(value ReviewIssueMemberRole) bool {
	return value == REVIEW_ISSUE_MEMBER_ROLE_SUBJECT || value == REVIEW_ISSUE_MEMBER_ROLE_CANDIDATE || value == REVIEW_ISSUE_MEMBER_ROLE_SUPPORTING
}

func isReviewObjectType(value ReviewObjectType) bool {
	switch value {
	case REVIEW_OBJECT_TYPE_EVENT, REVIEW_OBJECT_TYPE_EVIDENCE, REVIEW_OBJECT_TYPE_RELATION,
		REVIEW_OBJECT_TYPE_TRANSACTION, REVIEW_OBJECT_TYPE_SOURCE_ACCOUNT:
		return true
	default:
		return false
	}
}
