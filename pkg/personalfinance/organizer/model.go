package organizer

import "github.com/gaohongxiang/catledger/pkg/personalfinance/importing"

// FinanceUpdate 是用户一次多文件财务更新，也是默认核对和入账单位。
type FinanceUpdate struct {
	Uid                    int64        `xorm:"BIGINT UNIQUE(UQE_pf_fin_update_uid_id) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	Status                 UpdateStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	Version                int64        `xorm:"BIGINT NOT NULL"`
	PlanVersion            RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	CurrentActionId        *int64       `xorm:"BIGINT NULL"`
	SourceCount            int64        `xorm:"BIGINT NOT NULL"`
	ValidEvidenceCount     int64        `xorm:"BIGINT NOT NULL"`
	DuplicateEvidenceCount int64        `xorm:"BIGINT NOT NULL"`
	FinalEventCount        int64        `xorm:"BIGINT NOT NULL"`
	PostedEventCount       int64        `xorm:"BIGINT NOT NULL"`
	ReadyEventCount        int64        `xorm:"BIGINT NOT NULL"`
	NeedsActionEventCount  int64        `xorm:"BIGINT NOT NULL"`
	ExcludedEventCount     int64        `xorm:"BIGINT NOT NULL"`
	ErrorCode              string       `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime        int64        `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime        int64        `xorm:"BIGINT INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	UpdateId               int64        `xorm:"BIGINT PK UNIQUE(UQE_pf_fin_update_uid_id) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
}

func (FinanceUpdate) TableName() string { return "pf_finance_update" }

// FinanceUpdateSource 固定一次更新包含的解析批次快照。
type FinanceUpdateSource struct {
	Uid                  int64       `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) UNIQUE(UQE_pf_fin_source_uid_update_order) INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
	UpdateId             int64       `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) UNIQUE(UQE_pf_fin_source_uid_update_order) NOT NULL"`
	SourceOrder          int64       `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_order) NOT NULL"`
	FileId               int64       `xorm:"BIGINT NOT NULL"`
	BatchId              int64       `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
	SourceAccountId      *int64      `xorm:"BIGINT NULL"`
	SourceTypeSnapshot   string      `xorm:"VARCHAR(32) NOT NULL"`
	ParserVersion        RuleVersion `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion RuleVersion `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion   RuleVersion `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime      int64       `xorm:"BIGINT NOT NULL"`
	SourceId             int64       `xorm:"BIGINT PK INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
}

func (FinanceUpdateSource) TableName() string { return "pf_finance_update_source" }

// CategoryAliasMapping 保存用户确认过的来源分类或商户别名到正式账本分类的映射。
// 该表沿用 v006 已存在的 pf_category_alias_mapping，不创建第二套分类规则。
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

func (CategoryAliasMapping) TableName() string { return "pf_category_alias_mapping" }

// EconomicEvent 是可重建的经济语义投影，不参与余额计算。
type EconomicEvent struct {
	Uid                         int64          `xorm:"BIGINT UNIQUE(UQE_pf_event_uid_update_key) INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	UpdateId                    int64          `xorm:"BIGINT UNIQUE(UQE_pf_event_uid_update_key) INDEX(IDX_pf_event_uid_update_status_updated) NOT NULL"`
	EventKey                    string         `xorm:"CHAR(64) UNIQUE(UQE_pf_event_uid_update_key) NOT NULL"`
	EventKeyVersion             RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	Status                      EventStatus    `xorm:"VARCHAR(32) INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	Version                     int64          `xorm:"BIGINT NOT NULL"`
	FlowDirection               FlowDirection  `xorm:"VARCHAR(16) NOT NULL"`
	EconomicNature              EconomicNature `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId             *int64         `xorm:"BIGINT NULL"`
	CounterpartyLedgerAccountId *int64         `xorm:"BIGINT NULL"`
	EventUnixTime               *int64         `xorm:"BIGINT NULL"`
	TimezoneUtcOffset           *int16         `xorm:"SMALLINT NULL"`
	Amount                      *int64         `xorm:"BIGINT NULL"`
	Currency                    string         `xorm:"VARCHAR(3) NOT NULL"`
	CategoryId                  *int64         `xorm:"BIGINT NULL"`
	ManualFieldMask             int64          `xorm:"BIGINT NOT NULL"`
	RuleVersion                 RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	FieldSourcesJson            string         `xorm:"TEXT NOT NULL"`
	ReasonCodesJson             string         `xorm:"TEXT NOT NULL"`
	CreatedUnixTime             int64          `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime             int64          `xorm:"BIGINT INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	EventId                     int64          `xorm:"BIGINT PK INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
}

func (EconomicEvent) TableName() string { return "pf_economic_event" }

// EconomicEventEvidence 把一条原始行唯一归属到一次更新中的最终事件。
type EconomicEventEvidence struct {
	Uid             int64        `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_event) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
	UpdateId        int64        `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) NOT NULL"`
	EventId         int64        `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_event) NOT NULL"`
	RowId           int64        `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
	EvidenceRole    EvidenceRole `xorm:"VARCHAR(32) NOT NULL"`
	FieldMask       int64        `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime int64        `xorm:"BIGINT NOT NULL"`
	EvidenceId      int64        `xorm:"BIGINT PK INDEX(IDX_pf_event_evd_uid_event) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
}

func (EconomicEventEvidence) TableName() string { return "pf_economic_event_evidence" }

// EconomicEventRelation 保存事件间退款、转账、还款和债务关系。
type EconomicEventRelation struct {
	Uid                int64          `xorm:"BIGINT UNIQUE(UQE_pf_event_rel_uid_key) INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	UpdateId           int64          `xorm:"BIGINT NOT NULL"`
	RelationKey        string         `xorm:"CHAR(64) UNIQUE(UQE_pf_event_rel_uid_key) NOT NULL"`
	RelationKeyVersion RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	RelationType       RelationType   `xorm:"VARCHAR(32) NOT NULL"`
	Status             RelationStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	Version            int64          `xorm:"BIGINT NOT NULL"`
	SourceEventId      int64          `xorm:"BIGINT INDEX(IDX_pf_event_rel_uid_source_status) NOT NULL"`
	TargetEventId      int64          `xorm:"BIGINT INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	Amount             *int64         `xorm:"BIGINT NULL"`
	Currency           string         `xorm:"VARCHAR(3) NOT NULL"`
	Manual             bool           `xorm:"BOOLEAN NOT NULL"`
	RuleVersion        RuleVersion    `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson    string         `xorm:"TEXT NOT NULL"`
	CreatedUnixTime    int64          `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime    int64          `xorm:"BIGINT NOT NULL"`
	RelationId         int64          `xorm:"BIGINT PK INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
}

func (EconomicEventRelation) TableName() string { return "pf_economic_event_relation" }

// EconomicEventTransaction 是事件与正式 Transaction 的稳定链接。
type EconomicEventTransaction struct {
	Uid                        int64                `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_event) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
	UpdateId                   int64                `xorm:"BIGINT NOT NULL"`
	EventId                    int64                `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_event) NOT NULL"`
	TransactionId              int64                `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
	Role                       EventTransactionRole `xorm:"VARCHAR(32) UNIQUE(UQE_pf_event_tx_uid_event_tx_role) NOT NULL"`
	RuleVersion                RuleVersion          `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64                `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64                `xorm:"BIGINT NOT NULL"`
	LinkId                     int64                `xorm:"BIGINT PK INDEX(IDX_pf_event_tx_uid_event) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
}

func (EconomicEventTransaction) TableName() string { return "pf_economic_event_transaction" }

// FinanceAction 保存幂等命令、人工决定、纠错和撤销审计。
type FinanceAction struct {
	Uid                   int64        `xorm:"BIGINT UNIQUE(UQE_pf_fin_action_uid_key) INDEX(IDX_pf_fin_action_uid_update_created) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	UpdateId              int64        `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_update_created) NOT NULL"`
	ExpectedUpdateVersion int64        `xorm:"BIGINT NOT NULL"`
	AppliedUpdateVersion  int64        `xorm:"BIGINT NOT NULL"`
	ActionType            ActionType   `xorm:"VARCHAR(32) NOT NULL"`
	IdempotencyKeyDigest  string       `xorm:"CHAR(64) UNIQUE(UQE_pf_fin_action_uid_key) NOT NULL"`
	IdempotencyKeyVersion RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string       `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	Status                ActionStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	ReasonCodesJson       string       `xorm:"TEXT NOT NULL"`
	ErrorCode             string       `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64        `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_update_created) NOT NULL"`
	StartedUnixTime       *int64       `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64       `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64       `xorm:"BIGINT NULL"`
	UpdatedUnixTime       int64        `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	ActionId              int64        `xorm:"BIGINT PK INDEX(IDX_pf_fin_action_uid_update_created) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
}

func (FinanceAction) TableName() string { return "pf_finance_action" }
