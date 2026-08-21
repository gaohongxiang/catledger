package migrations

// 下列结构只属于 v009 迁移。发布后不得修改；后续变化使用新迁移。

type financeUpdateV009 struct {
	Uid                    int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_update_uid_id) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	Status                 string `xorm:"VARCHAR(32) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	Version                int64  `xorm:"BIGINT NOT NULL"`
	PlanVersion            string `xorm:"VARCHAR(32) NOT NULL"`
	CurrentActionId        *int64 `xorm:"BIGINT NULL"`
	SourceCount            int64  `xorm:"BIGINT NOT NULL"`
	ValidEvidenceCount     int64  `xorm:"BIGINT NOT NULL"`
	DuplicateEvidenceCount int64  `xorm:"BIGINT NOT NULL"`
	FinalEventCount        int64  `xorm:"BIGINT NOT NULL"`
	PostedEventCount       int64  `xorm:"BIGINT NOT NULL"`
	ReadyEventCount        int64  `xorm:"BIGINT NOT NULL"`
	NeedsActionEventCount  int64  `xorm:"BIGINT NOT NULL"`
	ExcludedEventCount     int64  `xorm:"BIGINT NOT NULL"`
	ErrorCode              string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime        int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime        int64  `xorm:"BIGINT INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
	UpdateId               int64  `xorm:"BIGINT PK UNIQUE(UQE_pf_fin_update_uid_id) INDEX(IDX_pf_fin_update_uid_status_updated) NOT NULL"`
}

func (financeUpdateV009) TableName() string { return "pf_finance_update" }

type financeUpdateSourceV009 struct {
	Uid                  int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) UNIQUE(UQE_pf_fin_source_uid_update_order) INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
	UpdateId             int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) UNIQUE(UQE_pf_fin_source_uid_update_order) NOT NULL"`
	SourceOrder          int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_order) NOT NULL"`
	FileId               int64  `xorm:"BIGINT NOT NULL"`
	BatchId              int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_source_uid_update_batch) INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
	SourceAccountId      *int64 `xorm:"BIGINT NULL"`
	SourceTypeSnapshot   string `xorm:"VARCHAR(32) NOT NULL"`
	ParserVersion        string `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion string `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime      int64  `xorm:"BIGINT NOT NULL"`
	SourceId             int64  `xorm:"BIGINT PK INDEX(IDX_pf_fin_source_uid_batch) NOT NULL"`
}

func (financeUpdateSourceV009) TableName() string { return "pf_finance_update_source" }

type economicEventV009 struct {
	Uid                         int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_uid_update_key) INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	UpdateId                    int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_uid_update_key) INDEX(IDX_pf_event_uid_update_status_updated) NOT NULL"`
	EventKey                    string `xorm:"CHAR(64) UNIQUE(UQE_pf_event_uid_update_key) NOT NULL"`
	EventKeyVersion             string `xorm:"VARCHAR(32) NOT NULL"`
	Status                      string `xorm:"VARCHAR(32) INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	Version                     int64  `xorm:"BIGINT NOT NULL"`
	FlowDirection               string `xorm:"VARCHAR(16) NOT NULL"`
	EconomicNature              string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId             *int64 `xorm:"BIGINT NULL"`
	CounterpartyLedgerAccountId *int64 `xorm:"BIGINT NULL"`
	EventUnixTime               *int64 `xorm:"BIGINT NULL"`
	TimezoneUtcOffset           *int16 `xorm:"SMALLINT NULL"`
	Amount                      *int64 `xorm:"BIGINT NULL"`
	Currency                    string `xorm:"VARCHAR(3) NOT NULL"`
	CategoryId                  *int64 `xorm:"BIGINT NULL"`
	ManualFieldMask             int64  `xorm:"BIGINT NOT NULL"`
	RuleVersion                 string `xorm:"VARCHAR(32) NOT NULL"`
	FieldSourcesJson            string `xorm:"TEXT NOT NULL"`
	ReasonCodesJson             string `xorm:"TEXT NOT NULL"`
	CreatedUnixTime             int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime             int64  `xorm:"BIGINT INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
	EventId                     int64  `xorm:"BIGINT PK INDEX(IDX_pf_event_uid_update_status_updated) INDEX(IDX_pf_event_uid_status_updated) NOT NULL"`
}

func (economicEventV009) TableName() string { return "pf_economic_event" }

type economicEventEvidenceV009 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_event) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
	UpdateId        int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) NOT NULL"`
	EventId         int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_event) NOT NULL"`
	RowId           int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_evd_uid_update_row) UNIQUE(UQE_pf_event_evd_uid_event_row) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
	EvidenceRole    string `xorm:"VARCHAR(32) NOT NULL"`
	FieldMask       int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	EvidenceId      int64  `xorm:"BIGINT PK INDEX(IDX_pf_event_evd_uid_event) INDEX(IDX_pf_event_evd_uid_row) NOT NULL"`
}

func (economicEventEvidenceV009) TableName() string { return "pf_economic_event_evidence" }

type economicEventRelationV009 struct {
	Uid                int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_rel_uid_key) INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	UpdateId           int64  `xorm:"BIGINT NOT NULL"`
	RelationKey        string `xorm:"CHAR(64) UNIQUE(UQE_pf_event_rel_uid_key) NOT NULL"`
	RelationKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	RelationType       string `xorm:"VARCHAR(32) NOT NULL"`
	Status             string `xorm:"VARCHAR(32) INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	Version            int64  `xorm:"BIGINT NOT NULL"`
	SourceEventId      int64  `xorm:"BIGINT INDEX(IDX_pf_event_rel_uid_source_status) NOT NULL"`
	TargetEventId      int64  `xorm:"BIGINT INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
	Amount             *int64 `xorm:"BIGINT NULL"`
	Currency           string `xorm:"VARCHAR(3) NOT NULL"`
	Manual             bool   `xorm:"BOOLEAN NOT NULL"`
	RuleVersion        string `xorm:"VARCHAR(32) NOT NULL"`
	ReasonCodesJson    string `xorm:"TEXT NOT NULL"`
	CreatedUnixTime    int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime    int64  `xorm:"BIGINT NOT NULL"`
	RelationId         int64  `xorm:"BIGINT PK INDEX(IDX_pf_event_rel_uid_source_status) INDEX(IDX_pf_event_rel_uid_target_status) NOT NULL"`
}

func (economicEventRelationV009) TableName() string { return "pf_economic_event_relation" }

type economicEventTransactionV009 struct {
	Uid                        int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_event) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
	UpdateId                   int64  `xorm:"BIGINT NOT NULL"`
	EventId                    int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_event) NOT NULL"`
	TransactionId              int64  `xorm:"BIGINT UNIQUE(UQE_pf_event_tx_uid_event_tx_role) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
	Role                       string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_event_tx_uid_event_tx_role) NOT NULL"`
	RuleVersion                string `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64  `xorm:"BIGINT NOT NULL"`
	LinkId                     int64  `xorm:"BIGINT PK INDEX(IDX_pf_event_tx_uid_event) INDEX(IDX_pf_event_tx_uid_transaction) NOT NULL"`
}

func (economicEventTransactionV009) TableName() string { return "pf_economic_event_transaction" }

type financeActionV009 struct {
	Uid                   int64  `xorm:"BIGINT UNIQUE(UQE_pf_fin_action_uid_key) INDEX(IDX_pf_fin_action_uid_update_created) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	UpdateId              int64  `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_update_created) NOT NULL"`
	ExpectedUpdateVersion int64  `xorm:"BIGINT NOT NULL"`
	AppliedUpdateVersion  int64  `xorm:"BIGINT NOT NULL"`
	ActionType            string `xorm:"VARCHAR(32) NOT NULL"`
	IdempotencyKeyDigest  string `xorm:"CHAR(64) UNIQUE(UQE_pf_fin_action_uid_key) NOT NULL"`
	IdempotencyKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest         string `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion  string `xorm:"VARCHAR(32) NOT NULL"`
	Status                string `xorm:"VARCHAR(32) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	ReasonCodesJson       string `xorm:"TEXT NOT NULL"`
	ErrorCode             string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_update_created) NOT NULL"`
	StartedUnixTime       *int64 `xorm:"BIGINT NULL"`
	CompletedUnixTime     *int64 `xorm:"BIGINT NULL"`
	FailedUnixTime        *int64 `xorm:"BIGINT NULL"`
	UpdatedUnixTime       int64  `xorm:"BIGINT INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
	ActionId              int64  `xorm:"BIGINT PK INDEX(IDX_pf_fin_action_uid_update_created) INDEX(IDX_pf_fin_action_uid_status_updated) NOT NULL"`
}

func (financeActionV009) TableName() string { return "pf_finance_action" }

func schemaBeansV009() []any {
	return []any{
		new(financeUpdateV009),
		new(financeUpdateSourceV009),
		new(economicEventV009),
		new(economicEventEvidenceV009),
		new(economicEventRelationV009),
		new(economicEventTransactionV009),
		new(financeActionV009),
	}
}

func schemaBeansThroughV009() []any {
	beans := make([]any, 0, len(schemaBeansThroughV008())+len(schemaBeansV009()))
	beans = append(beans, schemaBeansThroughV008()...)
	beans = append(beans, schemaBeansV009()...)
	return beans
}
