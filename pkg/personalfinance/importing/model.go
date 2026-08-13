package importing

// ImportFile 表示用户上传的一份唯一文件内容。
type ImportFile struct {
	Uid                    int64                  `xorm:"BIGINT UNIQUE(UQE_pf_import_file_uid_sha256) INDEX(IDX_pf_import_file_uid_created) INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	ContentState           ImportFileContentState `xorm:"VARCHAR(32) INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	OriginalFileName       string                 `xorm:"VARCHAR(255) NOT NULL"`
	FileSize               int64                  `xorm:"BIGINT NOT NULL"`
	FileSha256             string                 `xorm:"CHAR(64) UNIQUE(UQE_pf_import_file_uid_sha256) NOT NULL"`
	MimeType               string                 `xorm:"VARCHAR(127) NOT NULL"`
	FileExtension          string                 `xorm:"VARCHAR(16) NOT NULL"`
	StorageObjectKey       string                 `xorm:"VARCHAR(512) NOT NULL"`
	CreatedIp              string                 `xorm:"VARCHAR(39) NOT NULL"`
	CreatedUnixTime        int64                  `xorm:"BIGINT INDEX(IDX_pf_import_file_uid_created) NOT NULL"`
	UpdatedUnixTime        int64                  `xorm:"BIGINT INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	ContentDeletedUnixTime *int64                 `xorm:"BIGINT NULL"`
	FileId                 int64                  `xorm:"BIGINT PK INDEX(IDX_pf_import_file_uid_created) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (ImportFile) TableName() string {
	return "pf_import_file"
}

// SourceAccount 表示账单来源账户档案，不是正式账本账户。
type SourceAccount struct {
	Uid                     int64                        `xorm:"BIGINT UNIQUE(UQE_pf_source_account_uid_type_key) INDEX(IDX_pf_source_account_uid_status_updated) INDEX(IDX_pf_source_account_uid_ledger) NOT NULL"`
	SourceType              SourceType                   `xorm:"VARCHAR(32) UNIQUE(UQE_pf_source_account_uid_type_key) NOT NULL"`
	SourceAccountKey        string                       `xorm:"CHAR(64) UNIQUE(UQE_pf_source_account_uid_type_key) NOT NULL"`
	SourceAccountKeyVersion RuleVersion                  `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId         *int64                       `xorm:"BIGINT INDEX(IDX_pf_source_account_uid_ledger) NULL"`
	Status                  SourceAccountStatus          `xorm:"VARCHAR(32) INDEX(IDX_pf_source_account_uid_status_updated) NOT NULL"`
	MaskedDisplayName       string                       `xorm:"VARCHAR(128) NOT NULL"`
	DiscoveryMethod         SourceAccountDiscoveryMethod `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime         int64                        `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime         int64                        `xorm:"BIGINT INDEX(IDX_pf_source_account_uid_status_updated) NOT NULL"`
	SourceAccountId         int64                        `xorm:"BIGINT PK NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (SourceAccount) TableName() string {
	return "pf_source_account"
}

// ImportBatch 表示同一文件的一次不可变解析运行。
type ImportBatch struct {
	Uid                        int64             `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	FileId                     int64             `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) NOT NULL"`
	SourceAccountId            *int64            `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_source_created) NULL"`
	Status                     ImportBatchStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	SourceTypeSnapshot         SourceType        `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId            *int64            `xorm:"BIGINT NULL"`
	ParserName                 string            `xorm:"VARCHAR(64) NOT NULL"`
	ParserVersion              RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion       RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion         RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion          RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion         RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	RawSnapshotVersion         RuleVersion       `xorm:"VARCHAR(32) NOT NULL"`
	ParseOptionsDigest         string            `xorm:"CHAR(64) NOT NULL"`
	ReparseReasonCode          string            `xorm:"VARCHAR(64) NOT NULL"`
	StatementStartUnixTime     *int64            `xorm:"BIGINT NULL"`
	StatementEndUnixTime       *int64            `xorm:"BIGINT NULL"`
	StatementTimezoneUtcOffset *int16            `xorm:"SMALLINT NULL"`
	TotalRowCount              int64             `xorm:"BIGINT NOT NULL"`
	ValidRowCount              int64             `xorm:"BIGINT NOT NULL"`
	InvalidRowCount            int64             `xorm:"BIGINT NOT NULL"`
	ExactDuplicateRowCount     int64             `xorm:"BIGINT NOT NULL"`
	IdentityConflictRowCount   int64             `xorm:"BIGINT NOT NULL"`
	PendingRowCount            int64             `xorm:"BIGINT NOT NULL"`
	PostedRowCount             int64             `xorm:"BIGINT NOT NULL"`
	ErrorCode                  string            `xorm:"VARCHAR(64) NOT NULL"`
	ErrorSummary               string            `xorm:"VARCHAR(255) NOT NULL"`
	CreatedUnixTime            int64             `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) NOT NULL"`
	StartedUnixTime            *int64            `xorm:"BIGINT NULL"`
	CompletedUnixTime          *int64            `xorm:"BIGINT NULL"`
	UpdatedUnixTime            int64             `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	BatchId                    int64             `xorm:"BIGINT PK INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (ImportBatch) TableName() string {
	return "pf_import_batch"
}

// SourceIdentity 表示同一来源账户中的稳定交易身份。
type SourceIdentity struct {
	Uid                int64        `xorm:"BIGINT UNIQUE(UQE_pf_source_identity_uid_key) INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	SourceAccountId    int64        `xorm:"BIGINT INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	IdentityKind       IdentityKind `xorm:"VARCHAR(32) NOT NULL"`
	SourceIdentityKey  string       `xorm:"CHAR(64) UNIQUE(UQE_pf_source_identity_uid_key) NOT NULL"`
	SourceCoreDigest   string       `xorm:"CHAR(64) NOT NULL"`
	IdentityKeyVersion RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion  RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	FirstSeenUnixTime  int64        `xorm:"BIGINT NOT NULL"`
	LastSeenUnixTime   int64        `xorm:"BIGINT INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	IdentityId         int64        `xorm:"BIGINT PK INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (SourceIdentity) TableName() string {
	return "pf_source_identity"
}

// RawImportRow 保存一次解析看到的每一条原始证据。
// 参与复合索引的字段顺序经过冻结，不能只为可读性重新排列。
type RawImportRow struct {
	Uid                         int64                 `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) INDEX(IDX_pf_raw_row_uid_identity) NOT NULL"`
	BatchId                     int64                 `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	ParseState                  ParseState            `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	IdentityState               IdentityState         `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	ProcessingState             ProcessingState       `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	IdentityId                  *int64                `xorm:"BIGINT INDEX(IDX_pf_raw_row_uid_identity) NULL"`
	RowNumber                   int64                 `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	SourceLocator               string                `xorm:"VARCHAR(255) NOT NULL"`
	SourceTransactionId         string                `xorm:"VARCHAR(255) NOT NULL"`
	SourceOrderId               string                `xorm:"VARCHAR(255) NOT NULL"`
	SourceMerchantOrderId       string                `xorm:"VARCHAR(255) NOT NULL"`
	RawTransactionTime          string                `xorm:"VARCHAR(64) NOT NULL"`
	RawAmount                   string                `xorm:"VARCHAR(64) NOT NULL"`
	RawDirection                string                `xorm:"VARCHAR(32) NOT NULL"`
	RawStatus                   string                `xorm:"VARCHAR(128) NOT NULL"`
	RawTransactionType          string                `xorm:"VARCHAR(128) NOT NULL"`
	RawCounterparty             string                `xorm:"VARCHAR(255) NOT NULL"`
	RawItem                     string                `xorm:"VARCHAR(255) NOT NULL"`
	RawPaymentMethod            string                `xorm:"VARCHAR(255) NOT NULL"`
	RawNote                     string                `xorm:"VARCHAR(1024) NOT NULL"`
	NormalizedUnixTime          *int64                `xorm:"BIGINT NULL"`
	NormalizedTimezoneUtcOffset *int16                `xorm:"SMALLINT NULL"`
	NormalizedAmount            *int64                `xorm:"BIGINT NULL"`
	Currency                    string                `xorm:"VARCHAR(3) NOT NULL"`
	NormalizedDirection         NormalizedDirection   `xorm:"VARCHAR(32) NOT NULL"`
	NormalizedTransactionType   SourceTransactionType `xorm:"VARCHAR(32) NOT NULL"`
	EconomicEffect              EconomicEffect        `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId             *int64                `xorm:"BIGINT NULL"`
	ObservedSourceIdentityKey   string                `xorm:"VARCHAR(64) NOT NULL"`
	ObservedSourceCoreDigest    string                `xorm:"VARCHAR(64) NOT NULL"`
	RawFieldsJson               string                `xorm:"TEXT NOT NULL"`
	IssuesJson                  string                `xorm:"TEXT NOT NULL"`
	PrimaryIssueCode            IssueCode             `xorm:"VARCHAR(64) NOT NULL"`
	RawSnapshotVersion          RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	ParserVersion               RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion        RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion          RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion           RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion          RuleVersion           `xorm:"VARCHAR(32) NOT NULL"`
	SemanticEligibility         SemanticEligibility   `xorm:"VARCHAR(32) NOT NULL"`
	Disposition                 ImportDisposition     `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime             int64                 `xorm:"BIGINT NOT NULL"`
	RowId                       int64                 `xorm:"BIGINT PK INDEX(IDX_pf_raw_row_uid_identity) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (RawImportRow) TableName() string {
	return "pf_raw_import_row"
}

// ImportPosting 保存一次持久幂等的确认入账命令与结果。
type ImportPosting struct {
	Uid                     int64               `xorm:"BIGINT UNIQUE(UQE_pf_import_posting_uid_key) INDEX(IDX_pf_import_posting_uid_batch_created) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	BatchId                 int64               `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_batch_created) NOT NULL"`
	IdempotencyKeyDigest    string              `xorm:"CHAR(64) UNIQUE(UQE_pf_import_posting_uid_key) NOT NULL"`
	IdempotencyKeyVersion   RuleVersion         `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest           string              `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion    RuleVersion         `xorm:"VARCHAR(32) NOT NULL"`
	Status                  ImportPostingStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	SelectedRowCount        int64               `xorm:"BIGINT NOT NULL"`
	CreatedTransactionCount int64               `xorm:"BIGINT NOT NULL"`
	ReusedTransactionCount  int64               `xorm:"BIGINT NOT NULL"`
	ErrorCode               string              `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime         int64               `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_batch_created) NOT NULL"`
	StartedUnixTime         *int64              `xorm:"BIGINT NULL"`
	CompletedUnixTime       *int64              `xorm:"BIGINT NULL"`
	FailedUnixTime          *int64              `xorm:"BIGINT NULL"`
	UpdatedUnixTime         int64               `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	PostingId               int64               `xorm:"BIGINT PK INDEX(IDX_pf_import_posting_uid_batch_created) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (ImportPosting) TableName() string {
	return "pf_import_posting"
}

// RawRowTransactionLink 建立不可删除原始证据与正式账本交易的关系。
type RawRowTransactionLink struct {
	Uid                        int64                           `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) INDEX(IDX_pf_raw_row_tx_link_uid_transaction) INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
	RowId                      int64                           `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) NOT NULL"`
	TransactionId              int64                           `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) INDEX(IDX_pf_raw_row_tx_link_uid_transaction) NOT NULL"`
	RelationRole               RawRowTransactionRelationRole   `xorm:"VARCHAR(32) UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) NOT NULL"`
	CreationMethod             RawRowTransactionCreationMethod `xorm:"VARCHAR(32) NOT NULL"`
	PostingId                  int64                           `xorm:"BIGINT INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
	RuleVersion                RuleVersion                     `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64                           `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64                           `xorm:"BIGINT NOT NULL"`
	LinkId                     int64                           `xorm:"BIGINT PK INDEX(IDX_pf_raw_row_tx_link_uid_transaction) INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (RawRowTransactionLink) TableName() string {
	return "pf_raw_row_transaction_link"
}

// ImportBatchIssue 保存不属于单一原始行的文档级问题。
type ImportBatchIssue struct {
	Uid             int64         `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	BatchId         int64         `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	IssueOrder      int64         `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	Code            IssueCode     `xorm:"VARCHAR(64) NOT NULL"`
	Severity        IssueSeverity `xorm:"VARCHAR(32) NOT NULL"`
	Field           string        `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime int64         `xorm:"BIGINT NOT NULL"`
	IssueId         int64         `xorm:"BIGINT PK NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (ImportBatchIssue) TableName() string {
	return "pf_import_batch_issue"
}
