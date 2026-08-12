package migrations

// 下列结构只属于已发布的 v001 迁移，后续运行模型变化时不得修改。

type importFileV001 struct {
	Uid                    int64  `xorm:"BIGINT UNIQUE(UQE_pf_import_file_uid_sha256) INDEX(IDX_pf_import_file_uid_created) INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	ContentState           string `xorm:"VARCHAR(32) INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	OriginalFileName       string `xorm:"VARCHAR(255) NOT NULL"`
	FileSize               int64  `xorm:"BIGINT NOT NULL"`
	FileSha256             string `xorm:"CHAR(64) UNIQUE(UQE_pf_import_file_uid_sha256) NOT NULL"`
	MimeType               string `xorm:"VARCHAR(127) NOT NULL"`
	FileExtension          string `xorm:"VARCHAR(16) NOT NULL"`
	StorageObjectKey       string `xorm:"VARCHAR(512) NOT NULL"`
	CreatedIp              string `xorm:"VARCHAR(39) NOT NULL"`
	CreatedUnixTime        int64  `xorm:"BIGINT INDEX(IDX_pf_import_file_uid_created) NOT NULL"`
	UpdatedUnixTime        int64  `xorm:"BIGINT INDEX(IDX_pf_import_file_uid_content_updated) NOT NULL"`
	ContentDeletedUnixTime *int64 `xorm:"BIGINT NULL"`
	FileId                 int64  `xorm:"BIGINT PK INDEX(IDX_pf_import_file_uid_created) NOT NULL"`
}

func (importFileV001) TableName() string {
	return "pf_import_file"
}

type sourceAccountV001 struct {
	Uid                     int64  `xorm:"BIGINT UNIQUE(UQE_pf_source_account_uid_type_key) INDEX(IDX_pf_source_account_uid_status_updated) INDEX(IDX_pf_source_account_uid_ledger) NOT NULL"`
	SourceType              string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_source_account_uid_type_key) NOT NULL"`
	SourceAccountKey        string `xorm:"CHAR(64) UNIQUE(UQE_pf_source_account_uid_type_key) NOT NULL"`
	SourceAccountKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId         *int64 `xorm:"BIGINT INDEX(IDX_pf_source_account_uid_ledger) NULL"`
	Status                  string `xorm:"VARCHAR(32) INDEX(IDX_pf_source_account_uid_status_updated) NOT NULL"`
	MaskedDisplayName       string `xorm:"VARCHAR(128) NOT NULL"`
	DiscoveryMethod         string `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime         int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime         int64  `xorm:"BIGINT INDEX(IDX_pf_source_account_uid_status_updated) NOT NULL"`
	SourceAccountId         int64  `xorm:"BIGINT PK NOT NULL"`
}

func (sourceAccountV001) TableName() string {
	return "pf_source_account"
}

type importBatchV001 struct {
	Uid                        int64  `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	FileId                     int64  `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) NOT NULL"`
	SourceAccountId            *int64 `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_source_created) NULL"`
	Status                     string `xorm:"VARCHAR(32) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	SourceTypeSnapshot         string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId            *int64 `xorm:"BIGINT NULL"`
	ParserName                 string `xorm:"VARCHAR(64) NOT NULL"`
	ParserVersion              string `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion       string `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion         string `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion          string `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion         string `xorm:"VARCHAR(32) NOT NULL"`
	RawSnapshotVersion         string `xorm:"VARCHAR(32) NOT NULL"`
	ParseOptionsDigest         string `xorm:"CHAR(64) NOT NULL"`
	ReparseReasonCode          string `xorm:"VARCHAR(64) NOT NULL"`
	StatementStartUnixTime     *int64 `xorm:"BIGINT NULL"`
	StatementEndUnixTime       *int64 `xorm:"BIGINT NULL"`
	StatementTimezoneUtcOffset *int16 `xorm:"SMALLINT NULL"`
	TotalRowCount              int64  `xorm:"BIGINT NOT NULL"`
	ValidRowCount              int64  `xorm:"BIGINT NOT NULL"`
	InvalidRowCount            int64  `xorm:"BIGINT NOT NULL"`
	ExactDuplicateRowCount     int64  `xorm:"BIGINT NOT NULL"`
	IdentityConflictRowCount   int64  `xorm:"BIGINT NOT NULL"`
	PendingRowCount            int64  `xorm:"BIGINT NOT NULL"`
	PostedRowCount             int64  `xorm:"BIGINT NOT NULL"`
	ErrorCode                  string `xorm:"VARCHAR(64) NOT NULL"`
	ErrorSummary               string `xorm:"VARCHAR(255) NOT NULL"`
	CreatedUnixTime            int64  `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) NOT NULL"`
	StartedUnixTime            *int64 `xorm:"BIGINT NULL"`
	CompletedUnixTime          *int64 `xorm:"BIGINT NULL"`
	UpdatedUnixTime            int64  `xorm:"BIGINT INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
	BatchId                    int64  `xorm:"BIGINT PK INDEX(IDX_pf_import_batch_uid_file_created) INDEX(IDX_pf_import_batch_uid_source_created) INDEX(IDX_pf_import_batch_uid_status_updated) NOT NULL"`
}

func (importBatchV001) TableName() string {
	return "pf_import_batch"
}

type sourceIdentityV001 struct {
	Uid                int64  `xorm:"BIGINT UNIQUE(UQE_pf_source_identity_uid_key) INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	SourceAccountId    int64  `xorm:"BIGINT INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	IdentityKind       string `xorm:"VARCHAR(32) NOT NULL"`
	SourceIdentityKey  string `xorm:"CHAR(64) UNIQUE(UQE_pf_source_identity_uid_key) NOT NULL"`
	SourceCoreDigest   string `xorm:"CHAR(64) NOT NULL"`
	IdentityKeyVersion string `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion  string `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion string `xorm:"VARCHAR(32) NOT NULL"`
	FirstSeenUnixTime  int64  `xorm:"BIGINT NOT NULL"`
	LastSeenUnixTime   int64  `xorm:"BIGINT INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
	IdentityId         int64  `xorm:"BIGINT PK INDEX(IDX_pf_source_identity_uid_source_seen) NOT NULL"`
}

func (sourceIdentityV001) TableName() string {
	return "pf_source_identity"
}

// 参与复合索引的字段顺序经过冻结，不能只为可读性重新排列。
type rawImportRowV001 struct {
	Uid                         int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) INDEX(IDX_pf_raw_row_uid_identity) NOT NULL"`
	BatchId                     int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	ParseState                  string `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	IdentityState               string `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	ProcessingState             string `xorm:"VARCHAR(32) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	IdentityId                  *int64 `xorm:"BIGINT INDEX(IDX_pf_raw_row_uid_identity) NULL"`
	RowNumber                   int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_uid_batch_number) INDEX(IDX_pf_raw_row_uid_batch_states_number) NOT NULL"`
	SourceLocator               string `xorm:"VARCHAR(255) NOT NULL"`
	SourceTransactionId         string `xorm:"VARCHAR(255) NOT NULL"`
	SourceOrderId               string `xorm:"VARCHAR(255) NOT NULL"`
	SourceMerchantOrderId       string `xorm:"VARCHAR(255) NOT NULL"`
	RawTransactionTime          string `xorm:"VARCHAR(64) NOT NULL"`
	RawAmount                   string `xorm:"VARCHAR(64) NOT NULL"`
	RawDirection                string `xorm:"VARCHAR(32) NOT NULL"`
	RawStatus                   string `xorm:"VARCHAR(128) NOT NULL"`
	RawTransactionType          string `xorm:"VARCHAR(128) NOT NULL"`
	RawCounterparty             string `xorm:"VARCHAR(255) NOT NULL"`
	RawItem                     string `xorm:"VARCHAR(255) NOT NULL"`
	RawPaymentMethod            string `xorm:"VARCHAR(255) NOT NULL"`
	RawNote                     string `xorm:"VARCHAR(1024) NOT NULL"`
	NormalizedUnixTime          *int64 `xorm:"BIGINT NULL"`
	NormalizedTimezoneUtcOffset *int16 `xorm:"SMALLINT NULL"`
	NormalizedAmount            *int64 `xorm:"BIGINT NULL"`
	Currency                    string `xorm:"VARCHAR(3) NOT NULL"`
	NormalizedDirection         string `xorm:"VARCHAR(32) NOT NULL"`
	NormalizedTransactionType   string `xorm:"VARCHAR(32) NOT NULL"`
	EconomicEffect              string `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId             *int64 `xorm:"BIGINT NULL"`
	ObservedSourceIdentityKey   string `xorm:"VARCHAR(64) NOT NULL"`
	ObservedSourceCoreDigest    string `xorm:"VARCHAR(64) NOT NULL"`
	RawFieldsJson               string `xorm:"TEXT NOT NULL"`
	IssuesJson                  string `xorm:"TEXT NOT NULL"`
	PrimaryIssueCode            string `xorm:"VARCHAR(64) NOT NULL"`
	RawSnapshotVersion          string `xorm:"VARCHAR(32) NOT NULL"`
	ParserVersion               string `xorm:"VARCHAR(32) NOT NULL"`
	NormalizationVersion        string `xorm:"VARCHAR(32) NOT NULL"`
	IdentityKeyVersion          string `xorm:"VARCHAR(32) NOT NULL"`
	CoreDigestVersion           string `xorm:"VARCHAR(32) NOT NULL"`
	FingerprintVersion          string `xorm:"VARCHAR(32) NOT NULL"`
	SemanticEligibility         string `xorm:"VARCHAR(32) NOT NULL"`
	Disposition                 string `xorm:"VARCHAR(32) NOT NULL"`
	CreatedUnixTime             int64  `xorm:"BIGINT NOT NULL"`
	RowId                       int64  `xorm:"BIGINT PK INDEX(IDX_pf_raw_row_uid_identity) NOT NULL"`
}

func (rawImportRowV001) TableName() string {
	return "pf_raw_import_row"
}

func schemaBeansV001() []any {
	return []any{
		new(importFileV001),
		new(sourceAccountV001),
		new(importBatchV001),
		new(sourceIdentityV001),
		new(rawImportRowV001),
	}
}
