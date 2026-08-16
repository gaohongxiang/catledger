package importing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

const (
	maximumEvidenceBatchSnapshotBytes   = 16 * 1024 * 1024
	maximumPersistentSourceLocatorBytes = 255
	parseOptionsDigestVersionV1         = "parse-options-v1"
	genericParseOptionsDigestVersionV1  = "generic-parse-options-v1"
)

var (
	// ErrImportSourceAccountNotFound 对当前 uid 隐藏不存在或不属于该用户的来源账户。
	ErrImportSourceAccountNotFound = errors.New("personal finance import source account is not found")
	// ErrImportSourceAccountUnavailable 表示来源账户已禁用或其持久身份契约不可用。
	ErrImportSourceAccountUnavailable = errors.New("personal finance import source account is unavailable")

	errEvidenceImportFileNotFound           = errors.New("evidence import file is not found")
	errEvidenceImportFileContentUnavailable = errors.New("evidence import file content is unavailable")
	errEvidenceSourceAccountNotFound        = errors.New("evidence source account is not found")
	errEvidenceSourceAccountUnavailable     = errors.New("evidence source account is unavailable")
)

// EvidenceDedupRepository 是证据批次服务消费的最小持久层契约。
// PersistEvidenceBatch 必须把来源身份裁决、批次、全部原始行和计数放在同一隐私事务中。
type EvidenceDedupRepository interface {
	FindImportFileById(c core.Context, uid int64, fileId int64) (*ImportFile, error)
	FindSourceAccountById(c core.Context, uid int64, sourceAccountId int64) (*SourceAccount, error)
	PersistEvidenceBatch(c core.Context, persistence *EvidenceBatchPersistence) error
}

// EvidenceBatchPersistence 是服务交给 repository 的单一原子写入单元。
// Rows 中的持久状态由 repository 根据数据库唯一约束的裁决结果回填。
type EvidenceBatchPersistence struct {
	Batch                    *ImportBatch
	CardHeader               *CardHeader
	ExpectedSourceAccountKey string
	DocumentIssues           []*ImportBatchIssue
	Rows                     []EvidenceBatchPersistenceRow
}

// EvidenceBatchPersistenceRow 绑定一条原始行与其版本化身份候选。
// 无效行的 IdentityCandidate 必须为 nil，且 CandidateIdentityId 必须为零。
type EvidenceBatchPersistenceRow struct {
	Row                  *RawImportRow
	Locator              SourceLocator
	IdentityCandidate    *IdentityCandidate
	FingerprintMaterials StrongFingerprintMaterials
	CandidateIdentityId  int64
}

// PersistEvidenceDocumentRequest 描述一份已解析证据的新批次。
// 同一 fileId 可通过显式 ReparseReasonCode 多次调用，每次都产生不可变的新批次。
type PersistEvidenceDocumentRequest struct {
	Uid               int64
	FileId            int64
	SourceAccountId   int64
	Descriptor        ParserDescriptor
	ParseOptions      ResolvedParseOptions
	ReparseReasonCode string
	Document          *EvidenceDocument
}

// DedupService 编排已解析证据的版本化身份计算与原子持久化。
type DedupService struct {
	repository EvidenceDedupRepository
	generateId func() int64
	now        func() time.Time
}

// NewDedupService 创建同来源精确去重服务。
func NewDedupService(repository EvidenceDedupRepository, generateId func() int64) (*DedupService, error) {
	if repository == nil || generateId == nil {
		return nil, ErrImportRequestInvalid
	}

	return &DedupService{
		repository: repository,
		generateId: generateId,
		now:        time.Now,
	}, nil
}

// PersistEvidenceDocument 保存一次显式解析运行。
// 该方法不创建来源账户、不写正式账本，也不执行跨来源候选匹配。
func (s *DedupService) PersistEvidenceDocument(c core.Context, request PersistEvidenceDocumentRequest) (*ImportBatch, error) {
	eligibilities, err := validatePersistEvidenceDocumentRequest(request)

	if err != nil {
		return nil, ErrImportRequestInvalid
	}

	file, err := s.repository.FindImportFileById(c, request.Uid, request.FileId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if file == nil || file.Uid != request.Uid || file.FileId != request.FileId {
		return nil, ErrImportFileNotFound
	}

	if file.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE || !isLowerHexSHA256(file.FileSha256) {
		return nil, ErrImportEvidenceUnavailable
	}

	account, err := s.repository.FindSourceAccountById(c, request.Uid, request.SourceAccountId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if account == nil {
		return nil, ErrImportSourceAccountNotFound
	}

	if err := validateSelectedSourceAccount(request, account); err != nil {
		return nil, err
	}

	batchId := s.generateId()

	if batchId < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	now := s.now().Unix()

	if now < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	persistence, err := s.buildEvidenceBatchPersistence(request, account, eligibilities, batchId, now)

	if err != nil {
		return nil, err
	}

	if err := s.repository.PersistEvidenceBatch(c, persistence); err != nil {
		switch {
		case errors.Is(err, errEvidenceImportFileNotFound):
			return nil, ErrImportFileNotFound
		case errors.Is(err, errEvidenceImportFileContentUnavailable):
			return nil, ErrImportEvidenceUnavailable
		case errors.Is(err, errEvidenceSourceAccountNotFound):
			return nil, ErrImportSourceAccountNotFound
		case errors.Is(err, errEvidenceSourceAccountUnavailable):
			return nil, ErrImportSourceAccountUnavailable
		default:
			return nil, ErrImportPersistenceUnavailable
		}
	}

	return persistence.Batch, nil
}

func validatePersistEvidenceDocumentRequest(request PersistEvidenceDocumentRequest) ([]SemanticEligibility, error) {
	if request.Uid < 1 || request.FileId < 1 || request.SourceAccountId < 1 ||
		!isTechnicalIdentifier(request.ReparseReasonCode, 64) {
		return nil, ErrImportRequestInvalid
	}

	if err := request.ParseOptions.ValidateForDescriptor(request.Descriptor); err != nil {
		return nil, err
	}

	eligibilities, err := ValidateEvidenceDocument(request.Descriptor, request.Document)

	if err != nil {
		return nil, err
	}

	if offset := request.Document.Metadata.StatementTimezoneUtcOffset; offset != nil &&
		*offset != request.ParseOptions.TimezoneUtcOffset {
		return nil, ErrImportRequestInvalid
	}

	for _, row := range request.Document.Rows {
		if row.ParseStatus == PARSE_STATE_VALID &&
			(row.Normalized.Currency != request.ParseOptions.Currency ||
				row.Normalized.TimezoneUtcOffset != request.ParseOptions.TimezoneUtcOffset) {
			return nil, ErrImportRequestInvalid
		}
	}

	return eligibilities, nil
}

func validateSelectedSourceAccount(request PersistEvidenceDocumentRequest, account *SourceAccount) error {
	versions := CurrentCentralRuleVersions()

	if account.Uid != request.Uid || account.SourceAccountId != request.SourceAccountId {
		return ErrImportSourceAccountNotFound
	}

	if account.Status != SOURCE_ACCOUNT_STATUS_ACTIVE ||
		account.SourceType != request.Descriptor.SourceType ||
		account.SourceAccountKeyVersion != versions.SourceAccountKeyVersion ||
		!isLowerHexSHA256(account.SourceAccountKey) ||
		(account.LedgerAccountId != nil && *account.LedgerAccountId < 1) {
		return ErrImportSourceAccountUnavailable
	}

	candidate := request.Document.Metadata.SourceAccount

	if candidate.Kind == SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER {
		candidateKey, err := ComputeSourceAccountKey(request.Descriptor.SourceType, candidate)

		if err != nil || candidateKey != account.SourceAccountKey {
			return ErrImportSourceAccountUnavailable
		}
	}

	return nil
}

func (s *DedupService) buildEvidenceBatchPersistence(request PersistEvidenceDocumentRequest, account *SourceAccount, eligibilities []SemanticEligibility, batchId int64, now int64) (*EvidenceBatchPersistence, error) {
	versions := CurrentCentralRuleVersions()
	sourceAccountId := account.SourceAccountId
	completedUnixTime := now
	startedUnixTime := now
	batch := &ImportBatch{
		Uid:                        request.Uid,
		FileId:                     request.FileId,
		SourceAccountId:            &sourceAccountId,
		Status:                     IMPORT_BATCH_STATUS_READY,
		SourceTypeSnapshot:         request.Descriptor.SourceType,
		LedgerAccountId:            cloneInt64Pointer(account.LedgerAccountId),
		ParserName:                 request.Descriptor.Name,
		ParserVersion:              request.Descriptor.ParserVersion,
		NormalizationVersion:       request.Descriptor.NormalizationVersion,
		IdentityKeyVersion:         versions.IdentityKeyVersion,
		CoreDigestVersion:          versions.CoreDigestVersion,
		FingerprintVersion:         versions.FingerprintVersion,
		RawSnapshotVersion:         versions.RawSnapshotVersion,
		ParseOptionsDigest:         computeParseOptionsDigest(request.ParseOptions),
		ReparseReasonCode:          request.ReparseReasonCode,
		StatementStartUnixTime:     cloneInt64Pointer(request.Document.Metadata.StatementStartUnixTime),
		StatementEndUnixTime:       cloneInt64Pointer(request.Document.Metadata.StatementEndUnixTime),
		StatementTimezoneUtcOffset: cloneInt16Pointer(request.Document.Metadata.StatementTimezoneUtcOffset),
		CreatedUnixTime:            now,
		StartedUnixTime:            &startedUnixTime,
		CompletedUnixTime:          &completedUnixTime,
		UpdatedUnixTime:            now,
		BatchId:                    batchId,
	}
	rows := make([]EvidenceBatchPersistenceRow, len(request.Document.Rows))
	documentIssues := make([]*ImportBatchIssue, len(request.Document.Issues))
	totalSnapshotBytes := 0
	var cardHeader *CardHeader
	if hasCardHeaderMetadata(request.Document.Metadata) {
		headerId := s.generateId()
		if headerId < 1 {
			return nil, ErrImportIdentifierUnavailable
		}
		cardHeader = cardHeaderFromMetadata(request.Uid, batchId, headerId, now, request.Document.Metadata, request.ParseOptions.Currency)
		if cardHeader == nil || !isValidCardHeader(cardHeader, batch) {
			return nil, ErrImportRequestInvalid
		}
	}

	for index, issue := range request.Document.Issues {
		issueId := s.generateId()

		if issueId < 1 {
			return nil, ErrImportIdentifierUnavailable
		}

		documentIssues[index] = &ImportBatchIssue{
			Uid:             request.Uid,
			BatchId:         batchId,
			IssueOrder:      int64(index + 1),
			Code:            issue.Code,
			Severity:        issue.Severity,
			Field:           issue.Field,
			CreatedUnixTime: now,
			IssueId:         issueId,
		}
	}

	for index, evidenceRow := range request.Document.Rows {
		rowId := s.generateId()

		if rowId < 1 {
			return nil, ErrImportIdentifierUnavailable
		}

		row, snapshotBytes, err := buildPersistentEvidenceRow(request, account, evidenceRow, eligibilities[index], versions, batchId, rowId, now)

		if err != nil {
			return nil, ErrImportRequestInvalid
		}

		if snapshotBytes > maximumEvidenceBatchSnapshotBytes-totalSnapshotBytes {
			return nil, ErrImportRequestInvalid
		}

		totalSnapshotBytes += snapshotBytes
		rows[index].Row = row
		rows[index].Locator = evidenceRow.Locator

		candidate, err := BuildIdentityCandidate(IdentityBuildInput{
			ParseState:           evidenceRow.ParseStatus,
			SourceType:           request.Descriptor.SourceType,
			SourceAccountKey:     account.SourceAccountKey,
			BatchId:              batchId,
			RowNumber:            evidenceRow.RowNumber,
			Identifiers:          evidenceRow.Identifiers,
			Normalized:           evidenceRow.Normalized,
			FingerprintMaterials: evidenceRow.FingerprintMaterials,
		})

		if err != nil {
			return nil, ErrImportRequestInvalid
		}

		if candidate != nil {
			candidateIdentityId := s.generateId()

			if candidateIdentityId < 1 {
				return nil, ErrImportIdentifierUnavailable
			}

			row.ObservedSourceIdentityKey = candidate.SourceIdentityKey
			row.ObservedSourceCoreDigest = candidate.SourceCoreDigest
			rows[index].IdentityCandidate = candidate
			rows[index].FingerprintMaterials = evidenceRow.FingerprintMaterials
			rows[index].CandidateIdentityId = candidateIdentityId
		}
	}

	return &EvidenceBatchPersistence{
		Batch:                    batch,
		CardHeader:               cardHeader,
		ExpectedSourceAccountKey: account.SourceAccountKey,
		DocumentIssues:           documentIssues,
		Rows:                     rows,
	}, nil
}

func buildPersistentEvidenceRow(request PersistEvidenceDocumentRequest, account *SourceAccount, evidenceRow EvidenceRow, eligibility SemanticEligibility, versions CentralRuleVersions, batchId int64, rowId int64, now int64) (*RawImportRow, int, error) {
	locator, err := EncodeSourceLocator(evidenceRow.Locator)

	if err != nil {
		return nil, 0, err
	}

	if len(locator) > maximumPersistentSourceLocatorBytes {
		return nil, 0, ErrImportRequestInvalid
	}

	rawFieldsJson, err := MarshalRawFields(evidenceRow.RawFields)

	if err != nil {
		return nil, 0, err
	}

	issuesJson, err := MarshalEvidenceIssues(evidenceRow.Issues)

	if err != nil {
		return nil, 0, err
	}

	row := &RawImportRow{
		Uid:                   request.Uid,
		BatchId:               batchId,
		ParseState:            evidenceRow.ParseStatus,
		RowNumber:             evidenceRow.RowNumber,
		SourceLocator:         locator,
		SourceTransactionId:   evidenceRow.Identifiers.TransactionId,
		SourceOrderId:         evidenceRow.Identifiers.OrderId,
		SourceMerchantOrderId: evidenceRow.Identifiers.MerchantOrderId,
		RawTransactionTime:    evidenceRow.Raw.TransactionTime,
		RawAmount:             evidenceRow.Raw.Amount,
		RawDirection:          evidenceRow.Raw.Direction,
		RawStatus:             evidenceRow.Raw.Status,
		RawTransactionType:    evidenceRow.Raw.TransactionType,
		RawCounterparty:       evidenceRow.Raw.Counterparty,
		RawItem:               evidenceRow.Raw.Item,
		RawPaymentMethod:      evidenceRow.Raw.PaymentMethod,
		RawNote:               evidenceRow.Raw.Note,
		RawFieldsJson:         rawFieldsJson,
		IssuesJson:            issuesJson,
		PrimaryIssueCode:      SelectPrimaryIssue(evidenceRow.Issues),
		RawSnapshotVersion:    versions.RawSnapshotVersion,
		ParserVersion:         request.Descriptor.ParserVersion,
		NormalizationVersion:  request.Descriptor.NormalizationVersion,
		IdentityKeyVersion:    versions.IdentityKeyVersion,
		CoreDigestVersion:     versions.CoreDigestVersion,
		FingerprintVersion:    versions.FingerprintVersion,
		SemanticEligibility:   eligibility,
		CreatedUnixTime:       now,
		RowId:                 rowId,
	}

	if evidenceRow.ParseStatus == PARSE_STATE_VALID {
		row.NormalizedUnixTime = cloneInt64Pointer(evidenceRow.Normalized.UnixTime)
		offset := evidenceRow.Normalized.TimezoneUtcOffset
		row.NormalizedTimezoneUtcOffset = &offset
		row.NormalizedAmount = cloneInt64Pointer(evidenceRow.Normalized.Amount)
		row.Currency = evidenceRow.Normalized.Currency
		row.NormalizedDirection = evidenceRow.Normalized.Direction
		row.NormalizedTransactionType = evidenceRow.Normalized.TransactionType
		row.EconomicEffect = evidenceRow.Normalized.EconomicEffect
		row.LedgerAccountId = cloneInt64Pointer(account.LedgerAccountId)
	}

	return row, persistentEvidenceSnapshotBytes(row), nil
}

// persistentEvidenceSnapshotBytes 计算一条原始证据实际写入字符串列的字节数。
// 批次上限覆盖定位、来源标识、固定原始投影和 JSON，不能只统计 JSON 而留下旁路。
func persistentEvidenceSnapshotBytes(row *RawImportRow) int {
	if row == nil {
		return 0
	}

	return len(row.SourceLocator) +
		len(row.SourceTransactionId) +
		len(row.SourceOrderId) +
		len(row.SourceMerchantOrderId) +
		len(row.RawTransactionTime) +
		len(row.RawAmount) +
		len(row.RawDirection) +
		len(row.RawStatus) +
		len(row.RawTransactionType) +
		len(row.RawCounterparty) +
		len(row.RawItem) +
		len(row.RawPaymentMethod) +
		len(row.RawNote) +
		len(row.RawFieldsJson) +
		len(row.IssuesJson)
}

func computeParseOptionsDigest(options ResolvedParseOptions) string {
	if options.GenericCSVMapping != nil {
		mapping, err := NormalizeGenericCSVMapping(*options.GenericCSVMapping)
		if err != nil {
			return ""
		}
		values := []string{
			genericParseOptionsDigestVersionV1, options.Currency, strconv.FormatInt(int64(options.TimezoneUtcOffset), 10),
			string(mapping.Encoding), string(mapping.Delimiter), strconv.Itoa(mapping.HeaderRow), string(mapping.TimeFormat),
			string(mapping.AmountMode), string(mapping.SignedPositiveDirection),
			strconv.Itoa(mapping.TimeColumn), strconv.Itoa(mapping.AmountColumn), strconv.Itoa(mapping.DirectionColumn),
			strconv.Itoa(mapping.IncomeColumn), strconv.Itoa(mapping.ExpenseColumn), strconv.Itoa(mapping.CurrencyColumn),
			strconv.Itoa(mapping.TransactionIdColumn), strconv.Itoa(mapping.OrderIdColumn), strconv.Itoa(mapping.MerchantOrderIdColumn),
			strconv.Itoa(mapping.CounterpartyColumn), strconv.Itoa(mapping.ItemColumn), strconv.Itoa(mapping.PaymentMethodColumn),
			strconv.Itoa(mapping.StatusColumn), strconv.Itoa(mapping.TransactionTypeColumn), strconv.Itoa(mapping.NoteColumn),
			strconv.Itoa(len(mapping.IncomeValues)),
		}
		values = append(values, mapping.IncomeValues...)
		values = append(values, strconv.Itoa(len(mapping.ExpenseValues)))
		values = append(values, mapping.ExpenseValues...)
		digest := sha256.Sum256(encodeLengthPrefixed(values...))
		return hex.EncodeToString(digest[:])
	}
	digest := sha256.Sum256(encodeLengthPrefixed(
		parseOptionsDigestVersionV1,
		options.Currency,
		strconv.FormatInt(int64(options.TimezoneUtcOffset), 10),
	))
	return hex.EncodeToString(digest[:])
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}

func cloneInt16Pointer(value *int16) *int16 {
	if value == nil {
		return nil
	}

	cloned := *value
	return &cloned
}
