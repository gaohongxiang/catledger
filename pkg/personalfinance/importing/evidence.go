package importing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	minimumTimezoneUtcOffset = int16(-720)
	maximumTimezoneUtcOffset = int16(840)
)

// ImportEvidenceParser 将来源文件纯转换为完整证据文档。
type ImportEvidenceParser interface {
	Descriptor() ParserDescriptor
	Probe(ctx context.Context, file EvidenceFile) ProbeResult
	Parse(ctx context.Context, file EvidenceFile, opts ResolvedParseOptions) (*EvidenceDocument, error)
}

// ImportEvidenceParseOptionsResolver 在解析前根据不可变文件内容补全可安全推断的解析选项。
// 解析服务会把返回的完整选项同时用于解析和持久摘要。
type ImportEvidenceParseOptionsResolver interface {
	ResolveParseOptions(ctx context.Context, file EvidenceFile, opts ResolvedParseOptions) (ResolvedParseOptions, error)
}

// EvidenceFile 是解析器收到的不可变原始上传内容。
type EvidenceFile struct {
	OriginalFileName string
	Content          []byte
}

// ParserDescriptor 固定一套解析与规则版本。
type ParserDescriptor struct {
	Name                  string
	SourceType            SourceType
	Format                EvidenceFormat
	ParserVersion         RuleVersion
	NormalizationVersion  RuleVersion
	ExplicitSelectionOnly bool
}

// Validate 防止两个来源解析器声明冲突的格式或空版本。
func (d ParserDescriptor) Validate() error {
	if !isTechnicalIdentifier(d.Name, 64) ||
		!isTechnicalIdentifier(string(d.ParserVersion), 32) ||
		!isTechnicalIdentifier(string(d.NormalizationVersion), 32) {
		return fmt.Errorf("parser descriptor requires a name and versions")
	}

	switch d.Format {
	case EVIDENCE_FORMAT_ALIPAY_APP_CSV, EVIDENCE_FORMAT_ALIPAY_WEB_CSV:
		if d.SourceType != SOURCE_TYPE_ALIPAY || d.ExplicitSelectionOnly {
			return fmt.Errorf("Alipay evidence format requires Alipay source type")
		}
	case EVIDENCE_FORMAT_WECHAT_CSV, EVIDENCE_FORMAT_WECHAT_XLSX:
		if d.SourceType != SOURCE_TYPE_WECHAT || d.ExplicitSelectionOnly {
			return fmt.Errorf("WeChat evidence format requires WeChat source type")
		}
	case EVIDENCE_FORMAT_BANK_GENERIC_CSV, EVIDENCE_FORMAT_BANK_GENERIC_XLS, EVIDENCE_FORMAT_BANK_GENERIC_XLSX:
		if d.SourceType != SOURCE_TYPE_BANK {
			return fmt.Errorf("generic bank table evidence format requires bank source type")
		}
	case EVIDENCE_FORMAT_CEB_CREDIT_PDF:
		if d.SourceType != SOURCE_TYPE_BANK || !d.ExplicitSelectionOnly {
			return fmt.Errorf("Everbright credit PDF evidence format requires explicit bank selection")
		}
	default:
		return fmt.Errorf("invalid evidence format")
	}

	return nil
}

// ProbeResult 描述解析器对文件格式的匹配结果。
type ProbeResult struct {
	Confidence ProbeConfidence
	SourceType SourceType
	Format     EvidenceFormat
	IssueCode  IssueCode
}

// Validate 绑定 parser descriptor 与探测结果，防止来源/格式和问题码越权。
func (r ProbeResult) Validate(descriptor ParserDescriptor) error {
	if err := descriptor.Validate(); err != nil {
		return err
	}

	if r.Confidence != PROBE_CONFIDENCE_NONE && r.Confidence != PROBE_CONFIDENCE_POSSIBLE && r.Confidence != PROBE_CONFIDENCE_EXACT {
		return fmt.Errorf("invalid probe confidence")
	}

	if r.Confidence == PROBE_CONFIDENCE_NONE {
		if r.SourceType != "" || r.Format != "" {
			return fmt.Errorf("unmatched probe cannot claim a source or format")
		}
	} else if r.SourceType != descriptor.SourceType || r.Format != descriptor.Format {
		return fmt.Errorf("probe result does not match parser descriptor")
	}

	if r.IssueCode != ISSUE_CODE_NONE {
		if !isValidFileIssueCode(r.IssueCode) || validateIssueCodesForSource(descriptor.SourceType, []EvidenceIssue{{Code: r.IssueCode}}) != nil {
			return fmt.Errorf("probe issue code does not belong to parser source")
		}
	}

	return nil
}

// ResolvedParseOptions 是调用解析器前已经解析并校验的必填选项。
// Currency 使用大写 ISO 4217 三字母代码；UTC offset 单位为分钟。
type ResolvedParseOptions struct {
	Currency           string
	TimezoneUtcOffset  int16
	GenericBankMapping *GenericBankMapping
}

// GenericBankMapping 是通用银行 CSV/XLS/XLSX 共用的规范化列映射，可由解析器推断或用户显式提供。
// 列和工作表索引从 0 开始；CSV 的 SheetIndex 固定为 -1，未使用列固定为 -1。
type GenericBankMapping struct {
	Encoding                GenericCSVEncoding
	Delimiter               GenericCSVDelimiter
	SheetIndex              int
	HeaderRow               int
	DataStartRow            int
	DataEndRow              int
	TimeFormat              GenericCSVTimeFormat
	AmountMode              GenericCSVAmountMode
	SignedPositiveDirection NormalizedDirection
	TimeColumn              int
	AmountColumn            int
	DirectionColumn         int
	IncomeColumn            int
	ExpenseColumn           int
	CurrencyColumn          int
	TransactionIdColumn     int
	OrderIdColumn           int
	MerchantOrderIdColumn   int
	CounterpartyColumn      int
	ItemColumn              int
	PaymentMethodColumn     int
	StatusColumn            int
	TransactionTypeColumn   int
	NoteColumn              int
	PaymentMethodPrefix     string
	IncomeValues            []string
	ExpenseValues           []string
}

// Validate 验证影响标准化和身份结果的解析选项。
func (o ResolvedParseOptions) Validate() error {
	if len(o.Currency) != 3 {
		return fmt.Errorf("currency must contain three uppercase letters")
	}

	for _, char := range o.Currency {
		if char < 'A' || char > 'Z' {
			return fmt.Errorf("currency must contain three uppercase letters")
		}
	}

	if o.TimezoneUtcOffset < minimumTimezoneUtcOffset || o.TimezoneUtcOffset > maximumTimezoneUtcOffset {
		return fmt.Errorf("timezone UTC offset is out of range")
	}

	if o.GenericBankMapping != nil {
		if _, err := NormalizeGenericBankMapping(*o.GenericBankMapping); err != nil {
			return err
		}
	}

	return nil
}

// ValidateForDescriptor 绑定通用映射与对应 parser，避免其他来源请求改变既有解析语义。
func (o ResolvedParseOptions) ValidateForDescriptor(descriptor ParserDescriptor) error {
	if err := descriptor.Validate(); err != nil {
		return err
	}
	if err := o.Validate(); err != nil {
		return err
	}
	if isGenericBankEvidenceFormat(descriptor.Format) {
		if o.GenericBankMapping == nil {
			return fmt.Errorf("generic bank mapping is required")
		}
		if descriptor.Format == EVIDENCE_FORMAT_BANK_GENERIC_CSV && o.GenericBankMapping.SheetIndex != -1 {
			return fmt.Errorf("generic bank CSV must not select a worksheet")
		}
		if descriptor.Format != EVIDENCE_FORMAT_BANK_GENERIC_CSV && o.GenericBankMapping.SheetIndex < 0 {
			return fmt.Errorf("generic bank spreadsheet requires a worksheet")
		}
		return nil
	}
	if o.GenericBankMapping != nil {
		return fmt.Errorf("generic bank mapping is only valid for generic bank parsers")
	}
	return nil
}

func isGenericBankEvidenceFormat(format EvidenceFormat) bool {
	switch format {
	case EVIDENCE_FORMAT_BANK_GENERIC_CSV, EVIDENCE_FORMAT_BANK_GENERIC_XLS, EVIDENCE_FORMAT_BANK_GENERIC_XLSX:
		return true
	default:
		return false
	}
}

// EvidenceDocument 包含文档元数据、每一逻辑行和文档级问题。
type EvidenceDocument struct {
	Metadata DocumentMetadata
	Rows     []EvidenceRow
	Issues   []EvidenceIssue
}

// DocumentMetadata 保存文件声明的来源账户与账期信息。
type DocumentMetadata struct {
	SourceType                 SourceType
	SourceAccount              SourceAccountCandidate
	StatementStartUnixTime     *int64
	StatementEndUnixTime       *int64
	StatementDateUnixTime      *int64
	DueUnixTime                *int64
	CreditLimitAmount          *int64
	StatementTimezoneUtcOffset *int16
}

// SourceAccountCandidate 是只在内存中使用的来源账户候选。
// Identifier 只有 Kind=stable_identifier 时才允许进入规范化哈希流程。
type SourceAccountCandidate struct {
	Kind            SourceAccountEvidenceKind
	Identifier      string
	DisplayName     string
	DiscoveryMethod SourceAccountDiscoveryMethod
}

// Validate 强制来源账户候选的判别字段一致，避免把掩码或微信昵称当成稳定身份。
func (c SourceAccountCandidate) Validate(sourceType SourceType) error {
	if !isValidSourceType(sourceType) {
		return fmt.Errorf("invalid source type")
	}

	if !utf8.ValidString(c.Identifier) || !utf8.ValidString(c.DisplayName) || utf8.RuneCountInString(c.DisplayName) > 128 {
		return fmt.Errorf("source account display name is too long")
	}

	switch c.Kind {
	case SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER:
		// 稳定标识只用于中心哈希；展示名必须由中心脱敏生成，避免 parser
		// 把完整账号复制到会持久化的展示字段。
		if c.DisplayName != "" {
			return fmt.Errorf("stable source account evidence cannot provide a display name")
		}

		if _, err := NormalizeSourceAccountIdentifier(sourceType, c.Identifier); err != nil {
			return err
		}

		if c.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED {
			return nil
		}

		if sourceType == SOURCE_TYPE_ALIPAY && c.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT {
			return nil
		}

		return fmt.Errorf("stable source account identifier has an invalid discovery method")
	case SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY:
		if c.Identifier != "" || strings.TrimSpace(c.DisplayName) == "" ||
			!looksMasked(c.DisplayName) || sourceType != SOURCE_TYPE_ALIPAY ||
			c.DiscoveryMethod != SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT {
			return fmt.Errorf("invalid masked source account evidence")
		}
	case SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY:
		if c.Identifier != "" || strings.TrimSpace(c.DisplayName) == "" ||
			sourceType != SOURCE_TYPE_WECHAT || c.DiscoveryMethod != SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME {
			return fmt.Errorf("invalid display-only source account evidence")
		}
	case SOURCE_ACCOUNT_EVIDENCE_MISSING:
		if c.Identifier != "" || c.DisplayName != "" || c.DiscoveryMethod != SOURCE_ACCOUNT_DISCOVERY_MISSING {
			return fmt.Errorf("invalid missing source account evidence")
		}
	default:
		return fmt.Errorf("invalid source account evidence kind")
	}

	return nil
}

func isTechnicalIdentifier(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength || strings.TrimSpace(value) != value {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' && char != '_' && char != '.' {
			return false
		}
	}

	return true
}

// SourceLocator 描述原始证据的物理位置。CSV/XLSX/PDF 行号从 1 开始，SheetIndex 从 0 开始，PDF 页码从 1 开始。
type SourceLocator struct {
	Kind        LocatorKind
	CSVStartRow int64
	CSVEndRow   int64
	SheetIndex  int
	SheetName   string
	XLSXRow     int64
	PDFPage     int
	PDFLine     int64
}

// EvidenceRow 是一条可追溯到物理位置的原始证据。
// RowNumber 是批次内从 1 开始、跨 sheet 全局递增的逻辑序号。
type EvidenceRow struct {
	RowNumber            int64
	Locator              SourceLocator
	RawFields            []RawField
	Raw                  CanonicalRawEvidence
	Identifiers          SourceIdentifiers
	Normalized           NormalizedEvidence
	FingerprintMaterials StrongFingerprintMaterials
	ParseStatus          ParseState
	Issues               []EvidenceIssue
}

// CanonicalRawEvidence 是所有来源都必须填写的通用原始字段投影。
// Value 保留解码后、trim 前文本；缺失字段使用空字符串。
type CanonicalRawEvidence struct {
	TransactionTime string
	Amount          string
	Direction       string
	Status          string
	TransactionType string
	Counterparty    string
	Item            string
	PaymentMethod   string
	Note            string
}

// RawField 按来源原始顺序保存解码后、trim 前的列名和值，允许重复列名。
type RawField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SourceIdentifiers 保存来源提供的稳定编号候选。
type SourceIdentifiers struct {
	TransactionId   string
	OrderId         string
	MerchantOrderId string
}

// NormalizedEvidence 是解析器生成、尚未写入正式账本的中性草稿。
// UnixTime 精确到秒；Amount 是非负的最小货币单位，退款只由 EconomicEffect 表达。
type NormalizedEvidence struct {
	UnixTime          *int64
	TimezoneUtcOffset int16
	Amount            *int64
	Currency          string
	Direction         NormalizedDirection
	TransactionType   SourceTransactionType
	EconomicEffect    EconomicEffect
	Counterparty      string
	Item              string
	PaymentMethod     string
	Note              string
}

// StrongFingerprintMaterials 是中心身份构造器可选择使用的强指纹材料。
type StrongFingerprintMaterials struct {
	Counterparty  string
	Item          string
	PaymentMethod string
}

// EvidenceIssue 只保存稳定码和字段位置，不携带原始敏感值。
type EvidenceIssue struct {
	Code     IssueCode     `json:"code"`
	Field    string        `json:"field,omitempty"`
	Severity IssueSeverity `json:"severity"`
}

// EvidenceParseError 表示文件级不可读错误，不包含原始字段值。
type EvidenceParseError struct {
	Code IssueCode
}

// Error 返回稳定、可安全记录的问题码。
func (e *EvidenceParseError) Error() string {
	if e == nil {
		return string(ISSUE_CODE_FILE_FORMAT_INVALID)
	}

	return string(e.Code)
}

// NormalizeEvidenceParseError 把任意 parser 错误收敛为可安全记录的稳定文件级问题码。
// 调用方不得直接记录原始 err.Error()。
func NormalizeEvidenceParseError(descriptor ParserDescriptor, err error) IssueCode {
	if err == nil {
		return ISSUE_CODE_NONE
	}

	if descriptor.Validate() != nil {
		return ISSUE_CODE_FILE_FORMAT_INVALID
	}

	parseError := new(EvidenceParseError)
	ok := errors.As(err, &parseError)

	if !ok || parseError == nil || !isValidFileIssueCode(parseError.Code) ||
		validateIssueCodesForSource(descriptor.SourceType, []EvidenceIssue{{Code: parseError.Code}}) != nil {
		return ISSUE_CODE_FILE_FORMAT_INVALID
	}

	return parseError.Code
}
