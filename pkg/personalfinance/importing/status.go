package importing

// SourceType 表示外部账单来源。
type SourceType string

const (
	SOURCE_TYPE_ALIPAY SourceType = "alipay"
	SOURCE_TYPE_WECHAT SourceType = "wechat"
	SOURCE_TYPE_BANK   SourceType = "bank"
)

// EvidenceFormat 精确区分来源与导出格式，避免不同解析器争抢同一文件。
type EvidenceFormat string

const (
	EVIDENCE_FORMAT_ALIPAY_APP_CSV   EvidenceFormat = "alipay_app_csv"
	EVIDENCE_FORMAT_ALIPAY_WEB_CSV   EvidenceFormat = "alipay_web_csv"
	EVIDENCE_FORMAT_WECHAT_CSV       EvidenceFormat = "wechat_csv"
	EVIDENCE_FORMAT_WECHAT_XLSX      EvidenceFormat = "wechat_xlsx"
	EVIDENCE_FORMAT_BANK_GENERIC_CSV EvidenceFormat = "bank_generic_csv"
	EVIDENCE_FORMAT_CEB_CREDIT_PDF   EvidenceFormat = "ceb_credit_pdf"
)

// RuleVersion 是会影响持久证据或身份结果的显式规则版本。
type RuleVersion string

const (
	SOURCE_ACCOUNT_KEY_VERSION_V1    RuleVersion = "source-account-key-v1"
	IDENTITY_KEY_VERSION_V1          RuleVersion = "identity-key-v1"
	IDENTITY_KEY_VERSION_V2          RuleVersion = "identity-key-v2"
	CORE_DIGEST_VERSION_V1           RuleVersion = "core-digest-v1"
	FINGERPRINT_VERSION_V1           RuleVersion = "fingerprint-v1"
	RAW_SNAPSHOT_VERSION_V1          RuleVersion = "raw-snapshot-v1"
	IDEMPOTENCY_KEY_VERSION_V1       RuleVersion = "idempotency-key-v1"
	POSTING_REQUEST_VERSION_V1       RuleVersion = "posting-request-v1"
	POSTING_LINK_VERSION_V1          RuleVersion = "posting-link-v1"
	PAYMENT_ACCOUNT_ALIAS_VERSION_V1 RuleVersion = "payment-account-alias-v1"
	SOURCE_FUNDS_RULE_VERSION_V1     RuleVersion = "source-funds-v1"
)

// CentralRuleVersions 是 parser 不得覆盖的中心规则版本集合。
type CentralRuleVersions struct {
	SourceAccountKeyVersion RuleVersion
	IdentityKeyVersion      RuleVersion
	CoreDigestVersion       RuleVersion
	FingerprintVersion      RuleVersion
	RawSnapshotVersion      RuleVersion
}

// CurrentCentralRuleVersions 返回当前中心规则版本。
func CurrentCentralRuleVersions() CentralRuleVersions {
	return CentralRuleVersions{
		SourceAccountKeyVersion: SOURCE_ACCOUNT_KEY_VERSION_V1,
		IdentityKeyVersion:      IDENTITY_KEY_VERSION_V2,
		CoreDigestVersion:       CORE_DIGEST_VERSION_V1,
		FingerprintVersion:      FINGERPRINT_VERSION_V1,
		RawSnapshotVersion:      RAW_SNAPSHOT_VERSION_V1,
	}
}

// ProbeConfidence 是解析器对格式的确定程度。
type ProbeConfidence uint8

const (
	PROBE_CONFIDENCE_NONE     ProbeConfidence = 0
	PROBE_CONFIDENCE_POSSIBLE ProbeConfidence = 50
	PROBE_CONFIDENCE_EXACT    ProbeConfidence = 100
)

// Matched 返回该置信度是否足以进入候选解析器集合。
func (c ProbeConfidence) Matched() bool {
	return c >= PROBE_CONFIDENCE_POSSIBLE
}

// SourceAccountEvidenceKind 表示账单中来源账户证据的强度。
type SourceAccountEvidenceKind string

const (
	SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER   SourceAccountEvidenceKind = "stable_identifier"
	SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY SourceAccountEvidenceKind = "masked_display_only"
	SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY        SourceAccountEvidenceKind = "display_only"
	SOURCE_ACCOUNT_EVIDENCE_MISSING             SourceAccountEvidenceKind = "missing"
)

// SourceAccountDiscoveryMethod 说明来源账户候选来自哪里。
type SourceAccountDiscoveryMethod string

const (
	SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT  SourceAccountDiscoveryMethod = "alipay_preamble_account"
	SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME SourceAccountDiscoveryMethod = "wechat_preamble_nickname"
	SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED            SourceAccountDiscoveryMethod = "user_selected"
	SOURCE_ACCOUNT_DISCOVERY_FILE_SCOPE               SourceAccountDiscoveryMethod = "file_scope"
	SOURCE_ACCOUNT_DISCOVERY_MISSING                  SourceAccountDiscoveryMethod = "missing"
)

// GenericCSVEncoding 是通用银行 CSV 显式支持的字符编码。
type GenericCSVEncoding string

const (
	GENERIC_CSV_ENCODING_UTF8    GenericCSVEncoding = "utf8"
	GENERIC_CSV_ENCODING_GB18030 GenericCSVEncoding = "gb18030"
	GENERIC_CSV_ENCODING_GBK     GenericCSVEncoding = "gbk"
)

// GenericCSVDelimiter 是通用银行 CSV 显式支持的分隔符。
type GenericCSVDelimiter string

const (
	GENERIC_CSV_DELIMITER_COMMA GenericCSVDelimiter = "comma"
	GENERIC_CSV_DELIMITER_TAB   GenericCSVDelimiter = "tab"
)

// GenericCSVAmountMode 描述金额和方向来自哪些列。
type GenericCSVAmountMode string

const (
	GENERIC_CSV_AMOUNT_MODE_SIGNED           GenericCSVAmountMode = "signed"
	GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION GenericCSVAmountMode = "amount_direction"
	GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE   GenericCSVAmountMode = "income_expense"
)

// GenericCSVTimeFormat 是受限时间格式枚举；值同时是固定 Go layout，但不接受枚举外 layout。
type GenericCSVTimeFormat string

const (
	GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS       GenericCSVTimeFormat = "2006-01-02 15:04:05"
	GENERIC_CSV_TIME_FORMAT_DATE_TIME_MINUTES       GenericCSVTimeFormat = "2006-01-02 15:04"
	GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_SECONDS GenericCSVTimeFormat = "2006/01/02 15:04:05"
	GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_MINUTES GenericCSVTimeFormat = "2006/01/02 15:04"
	GENERIC_CSV_TIME_FORMAT_DATE                    GenericCSVTimeFormat = "2006-01-02"
	GENERIC_CSV_TIME_FORMAT_SLASH_DATE              GenericCSVTimeFormat = "2006/01/02"
)

// LocatorKind 表示证据行的物理定位方式。
type LocatorKind string

const (
	LOCATOR_KIND_CSV  LocatorKind = "csv"
	LOCATOR_KIND_XLSX LocatorKind = "xlsx"
	LOCATOR_KIND_PDF  LocatorKind = "pdf"
)

// ImportFileContentState 表示原文件内容在对象存储中的状态。
type ImportFileContentState string

const (
	IMPORT_FILE_CONTENT_STATE_PENDING   ImportFileContentState = "pending"
	IMPORT_FILE_CONTENT_STATE_AVAILABLE ImportFileContentState = "available"
	IMPORT_FILE_CONTENT_STATE_MISSING   ImportFileContentState = "missing"
	IMPORT_FILE_CONTENT_STATE_FAILED    ImportFileContentState = "failed"
	IMPORT_FILE_CONTENT_STATE_DELETED   ImportFileContentState = "deleted"
)

// SourceAccountStatus 表示来源账户档案是否可用于新批次。
type SourceAccountStatus string

const (
	SOURCE_ACCOUNT_STATUS_ACTIVE   SourceAccountStatus = "active"
	SOURCE_ACCOUNT_STATUS_DISABLED SourceAccountStatus = "disabled"
)

// ImportBatchStatus 表示一次解析批次的生命周期状态。
type ImportBatchStatus string

const (
	IMPORT_BATCH_STATUS_RECEIVING               ImportBatchStatus = "receiving"
	IMPORT_BATCH_STATUS_PARSING                 ImportBatchStatus = "parsing"
	IMPORT_BATCH_STATUS_AWAITING_SOURCE_ACCOUNT ImportBatchStatus = "awaiting_source_account"
	IMPORT_BATCH_STATUS_READY                   ImportBatchStatus = "ready"
	IMPORT_BATCH_STATUS_POSTING                 ImportBatchStatus = "posting"
	IMPORT_BATCH_STATUS_PARTIALLY_POSTED        ImportBatchStatus = "partially_posted"
	IMPORT_BATCH_STATUS_COMPLETED               ImportBatchStatus = "completed"
	IMPORT_BATCH_STATUS_FAILED                  ImportBatchStatus = "failed"
	IMPORT_BATCH_STATUS_DISCARDED               ImportBatchStatus = "discarded"
)

// IdentityKind 表示来源身份材料的强度与组成。
type IdentityKind string

const (
	IDENTITY_KIND_SOURCE_TRANSACTION_ID IdentityKind = "source_transaction_id"
	IDENTITY_KIND_ORDER_COMBINATION     IdentityKind = "order_combination"
	IDENTITY_KIND_PHYSICAL_RECORD       IdentityKind = "physical_record"
	IDENTITY_KIND_STRONG_FINGERPRINT    IdentityKind = "strong_fingerprint"
	IDENTITY_KIND_BATCH_LOCAL           IdentityKind = "batch_local"
)

// ParseState 表示原始行是否可被可靠解析。
type ParseState string

const (
	PARSE_STATE_VALID   ParseState = "valid"
	PARSE_STATE_INVALID ParseState = "invalid"
)

// IdentityState 表示原始行与持久来源身份的关系。
type IdentityState string

const (
	IDENTITY_STATE_NOT_EVALUATED     IdentityState = "not_evaluated"
	IDENTITY_STATE_NEW               IdentityState = "new"
	IDENTITY_STATE_EXACT_DUPLICATE   IdentityState = "exact_duplicate"
	IDENTITY_STATE_IDENTITY_CONFLICT IdentityState = "identity_conflict"
	IDENTITY_STATE_BATCH_LOCAL       IdentityState = "batch_local"
)

// SemanticEligibility 是中心规则根据 parser 的来源中性语义推导出的入账资格。
type SemanticEligibility string

const (
	SEMANTIC_ELIGIBILITY_POSTABLE        SemanticEligibility = "postable"
	SEMANTIC_ELIGIBILITY_REVIEW_REQUIRED SemanticEligibility = "review_required"
	SEMANTIC_ELIGIBILITY_NON_POSTABLE    SemanticEligibility = "non_postable"
)

// ImportDisposition 表示一行证据是否允许进入确认入账流程。
type ImportDisposition string

const (
	IMPORT_DISPOSITION_POSTABLE        ImportDisposition = "postable"
	IMPORT_DISPOSITION_REVIEW_REQUIRED ImportDisposition = "review_required"
	IMPORT_DISPOSITION_NON_POSTABLE    ImportDisposition = "non_postable"
)

// ProcessingState 表示原始行在正式账本侧的处理结果。
type ProcessingState string

const (
	PROCESSING_STATE_PENDING ProcessingState = "pending"
	PROCESSING_STATE_LINKED  ProcessingState = "linked"
	PROCESSING_STATE_IGNORED ProcessingState = "ignored"
	PROCESSING_STATE_FAILED  ProcessingState = "failed"
)

// ImportPostingStatus 表示一次持久幂等入账命令的状态。
type ImportPostingStatus string

const (
	IMPORT_POSTING_STATUS_READY     ImportPostingStatus = "ready"
	IMPORT_POSTING_STATUS_POSTING   ImportPostingStatus = "posting"
	IMPORT_POSTING_STATUS_COMPLETED ImportPostingStatus = "completed"
	IMPORT_POSTING_STATUS_FAILED    ImportPostingStatus = "failed"
)

// RawRowTransactionRelationRole 表示证据链接对应逻辑交易的哪一侧。
type RawRowTransactionRelationRole string

const (
	RAW_ROW_TRANSACTION_RELATION_PRIMARY              RawRowTransactionRelationRole = "primary"
	RAW_ROW_TRANSACTION_RELATION_TRANSFER_COUNTERPART RawRowTransactionRelationRole = "transfer_counterpart"
)

// RawRowTransactionCreationMethod 表示正式交易或证据链接的来源。
type RawRowTransactionCreationMethod string

const (
	RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED       RawRowTransactionCreationMethod = "posting_created"
	RAW_ROW_TRANSACTION_CREATION_EXACT_IDENTITY_REUSED RawRowTransactionCreationMethod = "exact_identity_reused"
	RAW_ROW_TRANSACTION_CREATION_AUTO_POSTED           RawRowTransactionCreationMethod = "auto_posted"
)

// EconomicEffect 是来源状态映射后的稳定经济语义。
type EconomicEffect string

const (
	ECONOMIC_EFFECT_NORMAL  EconomicEffect = "normal"
	ECONOMIC_EFFECT_REFUND  EconomicEffect = "refund"
	ECONOMIC_EFFECT_CLOSED  EconomicEffect = "closed"
	ECONOMIC_EFFECT_FAILED  EconomicEffect = "failed"
	ECONOMIC_EFFECT_UNKNOWN EconomicEffect = "unknown"
)

// NormalizedDirection 是与来源展示文本解耦的标准化资金方向。
type NormalizedDirection string

const (
	NORMALIZED_DIRECTION_INCOME  NormalizedDirection = "income"
	NORMALIZED_DIRECTION_EXPENSE NormalizedDirection = "expense"
	NORMALIZED_DIRECTION_NEUTRAL NormalizedDirection = "neutral"
	NORMALIZED_DIRECTION_UNKNOWN NormalizedDirection = "unknown"
)

// SourceTransactionType 是来源中性化后的交易类别，不等同正式账本类型。
type SourceTransactionType string

const (
	SOURCE_TRANSACTION_TYPE_PAYMENT    SourceTransactionType = "payment"
	SOURCE_TRANSACTION_TYPE_TRANSFER   SourceTransactionType = "transfer"
	SOURCE_TRANSACTION_TYPE_TOP_UP     SourceTransactionType = "top_up"
	SOURCE_TRANSACTION_TYPE_WITHDRAWAL SourceTransactionType = "withdrawal"
	SOURCE_TRANSACTION_TYPE_FEE        SourceTransactionType = "fee"
	SOURCE_TRANSACTION_TYPE_OTHER      SourceTransactionType = "other"
	SOURCE_TRANSACTION_TYPE_UNKNOWN    SourceTransactionType = "unknown"
)

// IssueCode 是不携带原始值的稳定问题码。
type IssueCode string

const (
	ISSUE_CODE_NONE                         IssueCode = ""
	ISSUE_CODE_FILE_FORMAT_INVALID          IssueCode = "file_format_invalid"
	ISSUE_CODE_FILE_ENCODING_INVALID        IssueCode = "file_encoding_invalid"
	ISSUE_CODE_FILE_STRUCTURE_INVALID       IssueCode = "file_structure_invalid"
	ISSUE_CODE_ROW_FIELD_MISSING            IssueCode = "row_field_missing"
	ISSUE_CODE_ROW_TIME_INVALID             IssueCode = "row_time_invalid"
	ISSUE_CODE_ROW_AMOUNT_INVALID           IssueCode = "row_amount_invalid"
	ISSUE_CODE_ROW_CURRENCY_INVALID         IssueCode = "row_currency_invalid"
	ISSUE_CODE_ROW_DIRECTION_UNKNOWN        IssueCode = "row_direction_unknown"
	ISSUE_CODE_ROW_STATUS_UNKNOWN           IssueCode = "row_status_unknown"
	ISSUE_CODE_ROW_TRANSACTION_TYPE_UNKNOWN IssueCode = "row_transaction_type_unknown"
	ISSUE_CODE_ROW_IDENTIFIER_INVALID       IssueCode = "row_identifier_invalid"
	ISSUE_CODE_ROW_UNSUPPORTED              IssueCode = "row_unsupported"
)

// IssueSeverity 表示问题对证据可用性的影响。
type IssueSeverity string

const (
	ISSUE_SEVERITY_INFO    IssueSeverity = "info"
	ISSUE_SEVERITY_WARNING IssueSeverity = "warning"
	ISSUE_SEVERITY_ERROR   IssueSeverity = "error"
)
