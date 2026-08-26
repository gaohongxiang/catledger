package legacydata

import "github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"

// 以下结构只描述历史 billflow 表，供迁移校验和用户数据清理使用，不是运行时业务模型。
type Task struct {
	Uid                 int64         `xorm:"BIGINT INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	Status              TaskStatus    `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	ConfirmPolicy       ConfirmPolicy `xorm:"VARCHAR(32) NOT NULL"`
	Version             int64         `xorm:"BIGINT NOT NULL"`
	CurrentActionId     *int64        `xorm:"BIGINT NULL"`
	CreatedAccountCount int64         `xorm:"BIGINT NOT NULL"`
	ReusedMappingCount  int64         `xorm:"BIGINT NOT NULL"`
	AutoPostedCount     int64         `xorm:"BIGINT NOT NULL"`
	TodoOpenCount       int64         `xorm:"BIGINT NOT NULL"`
	ErrorCode           string        `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime     int64         `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime     int64         `xorm:"BIGINT INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
	TaskId              int64         `xorm:"BIGINT PK INDEX(IDX_pf_billflow_task_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Task) TableName() string {
	return "pf_billflow_task"
}

// TaskMember 把一份已解析文件及其当前批次绑定到整理任务。
type TaskMember struct {
	Uid             int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) UNIQUE(UQE_pf_billflow_member_uid_batch) INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	TaskId          int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	MemberOrder     int64 `xorm:"BIGINT INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
	FileId          int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_task_file) NOT NULL"`
	BatchId         int64 `xorm:"BIGINT UNIQUE(UQE_pf_billflow_member_uid_batch) NOT NULL"`
	CreatedUnixTime int64 `xorm:"BIGINT NOT NULL"`
	MemberId        int64 `xorm:"BIGINT PK INDEX(IDX_pf_billflow_member_uid_task_order) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (TaskMember) TableName() string {
	return "pf_billflow_task_member"
}

// Action 保存追加式持久幂等整理命令。
type Action struct {
	Uid                   int64        `xorm:"BIGINT UNIQUE(UQE_pf_billflow_action_uid_key) INDEX(IDX_pf_billflow_action_uid_task_created) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	TaskId                int64        `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_task_created) NOT NULL"`
	ExpectedTaskVersion   int64        `xorm:"BIGINT NOT NULL"`
	AppliedTaskVersion    int64        `xorm:"BIGINT NOT NULL"`
	ActionType            ActionType   `xorm:"VARCHAR(32) NOT NULL"`
	PreviousActionId      *int64       `xorm:"BIGINT NULL"`
	IdempotencyKeyDigest  string       `xorm:"CHAR(64) UNIQUE(UQE_pf_billflow_action_uid_key) NOT NULL"`
	IdempotencyKeyVersion RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string       `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	Status                ActionStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	ReasonCodesJson       string       `xorm:"TEXT NOT NULL"`
	ErrorCode             string       `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64        `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_task_created) NOT NULL"`
	UpdatedUnixTime       int64        `xorm:"BIGINT INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
	StartedUnixTime       *int64       `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64       `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64       `xorm:"BIGINT NULL"`
	ActionId              int64        `xorm:"BIGINT PK INDEX(IDX_pf_billflow_action_uid_task_created) INDEX(IDX_pf_billflow_action_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Action) TableName() string {
	return "pf_billflow_action"
}

// Todo 保存整理任务中一条例外待办。
type Todo struct {
	Uid              int64       `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	TaskId           int64       `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	TodoKind         TodoKind    `xorm:"VARCHAR(32) UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	Status           TodoStatus  `xorm:"VARCHAR(32) INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	SubjectKind      SubjectKind `xorm:"VARCHAR(32) UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	SubjectId        int64       `xorm:"BIGINT UNIQUE(UQE_pf_billflow_todo_uid_task_kind_subject) NOT NULL"`
	ReasonCodesJson  string      `xorm:"TEXT NOT NULL"`
	Version          int64       `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime  int64       `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime  int64       `xorm:"BIGINT INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
	ResolvedUnixTime *int64      `xorm:"BIGINT NULL"`
	TodoId           int64       `xorm:"BIGINT PK INDEX(IDX_pf_billflow_todo_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Todo) TableName() string {
	return "pf_billflow_todo"
}

// CategoryAliasMapping 把允许映射的来源分类名别名持久化为正式账本分类。
type CategoryAliasMapping struct {
	Uid               int64                `xorm:"BIGINT UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	SourceType        importing.SourceType `xorm:"VARCHAR(32) UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	AliasKey          string               `xorm:"CHAR(64) UNIQUE(UQE_pf_cat_alias_uid_type_key) NOT NULL"`
	AliasKeyVersion   RuleVersion          `xorm:"VARCHAR(32) NOT NULL"`
	LedgerCategoryId  int64                `xorm:"BIGINT NOT NULL"`
	MaskedDisplayName string               `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64                `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64                `xorm:"BIGINT NOT NULL"`
	MappingId         int64                `xorm:"BIGINT PK NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (CategoryAliasMapping) TableName() string {
	return "pf_category_alias_mapping"
}
