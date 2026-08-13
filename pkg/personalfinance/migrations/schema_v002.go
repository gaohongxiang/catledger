package migrations

// 下列结构只属于已发布的 v002 迁移，后续运行模型变化时不得修改。

type importPostingV002 struct {
	Uid                     int64  `xorm:"BIGINT UNIQUE(UQE_pf_import_posting_uid_key) INDEX(IDX_pf_import_posting_uid_batch_created) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	BatchId                 int64  `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_batch_created) NOT NULL"`
	IdempotencyKeyDigest    string `xorm:"CHAR(64) UNIQUE(UQE_pf_import_posting_uid_key) NOT NULL"`
	IdempotencyKeyVersion   string `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest           string `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion    string `xorm:"VARCHAR(32) NOT NULL"`
	Status                  string `xorm:"VARCHAR(32) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	SelectedRowCount        int64  `xorm:"BIGINT NOT NULL"`
	CreatedTransactionCount int64  `xorm:"BIGINT NOT NULL"`
	ReusedTransactionCount  int64  `xorm:"BIGINT NOT NULL"`
	ErrorCode               string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime         int64  `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_batch_created) NOT NULL"`
	StartedUnixTime         *int64 `xorm:"BIGINT NULL"`
	CompletedUnixTime       *int64 `xorm:"BIGINT NULL"`
	FailedUnixTime          *int64 `xorm:"BIGINT NULL"`
	UpdatedUnixTime         int64  `xorm:"BIGINT INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
	PostingId               int64  `xorm:"BIGINT PK INDEX(IDX_pf_import_posting_uid_batch_created) INDEX(IDX_pf_import_posting_uid_status_updated) NOT NULL"`
}

func (importPostingV002) TableName() string {
	return "pf_import_posting"
}

type rawRowTransactionLinkV002 struct {
	Uid                        int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) INDEX(IDX_pf_raw_row_tx_link_uid_transaction) INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
	RowId                      int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) NOT NULL"`
	TransactionId              int64  `xorm:"BIGINT UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) INDEX(IDX_pf_raw_row_tx_link_uid_transaction) NOT NULL"`
	RelationRole               string `xorm:"VARCHAR(32) UNIQUE(UQE_pf_raw_row_tx_link_uid_relation) NOT NULL"`
	CreationMethod             string `xorm:"VARCHAR(32) NOT NULL"`
	PostingId                  int64  `xorm:"BIGINT INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
	RuleVersion                string `xorm:"VARCHAR(32) NOT NULL"`
	TransactionUpdatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64  `xorm:"BIGINT NOT NULL"`
	LinkId                     int64  `xorm:"BIGINT PK INDEX(IDX_pf_raw_row_tx_link_uid_transaction) INDEX(IDX_pf_raw_row_tx_link_uid_posting) NOT NULL"`
}

func (rawRowTransactionLinkV002) TableName() string {
	return "pf_raw_row_transaction_link"
}

type importBatchIssueV002 struct {
	Uid             int64  `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	BatchId         int64  `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	IssueOrder      int64  `xorm:"BIGINT UNIQUE(UQE_pf_import_batch_issue_uid_order) NOT NULL"`
	Code            string `xorm:"VARCHAR(64) NOT NULL"`
	Severity        string `xorm:"VARCHAR(32) NOT NULL"`
	Field           string `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	IssueId         int64  `xorm:"BIGINT PK NOT NULL"`
}

func (importBatchIssueV002) TableName() string {
	return "pf_import_batch_issue"
}

func schemaBeansV002() []any {
	return []any{
		new(importPostingV002),
		new(rawRowTransactionLinkV002),
		new(importBatchIssueV002),
	}
}

func schemaBeansThroughV002() []any {
	beans := make([]any, 0, len(schemaBeansV001())+len(schemaBeansV002()))
	beans = append(beans, schemaBeansV001()...)
	beans = append(beans, schemaBeansV002()...)
	return beans
}
