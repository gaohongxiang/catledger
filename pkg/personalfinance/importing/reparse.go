package importing

import (
	"context"
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

var (
	// ErrImportFormatInvalid 表示没有唯一、可信的解析器或解析器报告了安全格式错误。
	ErrImportFormatInvalid = errors.New("personal finance import format is invalid")
)

// ImportAvailableFileReader 只读取已经完成持久化且摘要一致的原文件。
type ImportAvailableFileReader interface {
	ReadAvailable(c core.Context, objectKey string, expectedSHA256 string, expectedSize int64) ([]byte, error)
}

// ReparseImportRepository 是解析编排所需的只读文件元数据契约。
type ReparseImportRepository interface {
	FindImportFileById(c core.Context, uid int64, fileId int64) (*ImportFile, error)
	FindPostedImportBatchByFileId(c core.Context, uid int64, fileId int64) (*ImportBatch, error)
}

// EvidenceDocumentPersister 是解析编排所需的最小去重持久化契约。
type EvidenceDocumentPersister interface {
	PersistEvidenceDocument(c core.Context, request PersistEvidenceDocumentRequest) (*ImportBatch, error)
}

// ReparseSourceAccounts 是解析编排所需的最小来源账户契约。
type ReparseSourceAccounts interface {
	FindSourceAccount(c core.Context, uid int64, sourceAccountId int64) (*SourceAccount, error)
	ResolveStableSourceAccount(c core.Context, uid int64, sourceType SourceType, candidate SourceAccountCandidate) (*SourceAccount, error)
	ResolveDisplaySourceAccount(c core.Context, uid int64, sourceType SourceType, candidate SourceAccountCandidate) (*SourceAccount, error)
	EnsureFileSourceAccount(c core.Context, uid int64, sourceType SourceType, format EvidenceFormat, fileSHA256 string) (*SourceAccount, error)
	EnsureCebCreditSourceAccount(c core.Context, uid int64) (*SourceAccount, error)
}

// ReparseImportFileRequest 描述一次显式、可追踪的重新解析。
type ReparseImportFileRequest struct {
	Uid               int64
	FileId            int64
	SourceAccountId   int64
	ParserName        string
	ParseOptions      ResolvedParseOptions
	ReparseReasonCode string
}

// SourceAccountDiscovery 是不包含完整来源标识的安全选择提示。
type SourceAccountDiscovery struct {
	SourceType      SourceType
	EvidenceKind    SourceAccountEvidenceKind
	DisplayName     string
	DiscoveryMethod SourceAccountDiscoveryMethod
}

// ReparseImportFileResult 返回成功批次，或需要用户选择来源账户的安全提示。
type ReparseImportFileResult struct {
	Batch         *ImportBatch
	SourceAccount *SourceAccount
	Discovery     *SourceAccountDiscovery
	Descriptor    ParserDescriptor
	AlreadyPosted bool
}

// ImportFormatError 只携带可安全返回的稳定问题码。
type ImportFormatError struct {
	Code IssueCode
}

func (e *ImportFormatError) Error() string {
	return ErrImportFormatInvalid.Error()
}

func (e *ImportFormatError) Unwrap() error {
	return ErrImportFormatInvalid
}

// ReparseService 负责原文件读取、唯一 parser 选择、来源档案归属和证据持久化。
type ReparseService struct {
	repository     ReparseImportRepository
	storage        ImportAvailableFileReader
	parsers        []ImportEvidenceParser
	sourceAccounts ReparseSourceAccounts
	persister      EvidenceDocumentPersister
}

// NewReparseService 创建解析编排服务，并在组合根阶段校验 parser 声明没有冲突。
func NewReparseService(repository ReparseImportRepository, storage ImportAvailableFileReader, parsers []ImportEvidenceParser, sourceAccounts ReparseSourceAccounts, persister EvidenceDocumentPersister) (*ReparseService, error) {
	if repository == nil || storage == nil || sourceAccounts == nil || persister == nil || len(parsers) < 1 {
		return nil, ErrImportRequestInvalid
	}

	validated := make([]ImportEvidenceParser, len(parsers))
	parserNames := make(map[string]struct{}, len(parsers))
	formats := make(map[EvidenceFormat]struct{}, len(parsers))

	for index, parser := range parsers {
		if parser == nil {
			return nil, ErrImportRequestInvalid
		}

		descriptor := parser.Descriptor()
		if descriptor.Validate() != nil {
			return nil, ErrImportRequestInvalid
		}

		if _, exists := parserNames[descriptor.Name]; exists {
			return nil, ErrImportRequestInvalid
		}

		if _, exists := formats[descriptor.Format]; exists {
			return nil, ErrImportRequestInvalid
		}

		parserNames[descriptor.Name] = struct{}{}
		formats[descriptor.Format] = struct{}{}
		validated[index] = parser
	}

	return &ReparseService{
		repository:     repository,
		storage:        storage,
		parsers:        validated,
		sourceAccounts: sourceAccounts,
		persister:      persister,
	}, nil
}

// ReparseImportFile 只在来源账户归属明确时写批次。支付宝/微信有展示名时同一份沿用、没有则新建；看不出或同名冲突才询问。
func (s *ReparseService) ReparseImportFile(c core.Context, request ReparseImportFileRequest) (*ReparseImportFileResult, error) {
	if request.Uid < 1 || request.FileId < 1 || request.SourceAccountId < 0 ||
		(request.ParserName != "" && !isTechnicalIdentifier(request.ParserName, 64)) ||
		!isTechnicalIdentifier(request.ReparseReasonCode, 64) || request.ParseOptions.Validate() != nil {
		return nil, ErrImportRequestInvalid
	}

	unlock := lockImportFileMutation(request.Uid, request.FileId)
	defer unlock()

	postedBatch, err := s.repository.FindPostedImportBatchByFileId(c, request.Uid, request.FileId)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}
	if postedBatch != nil {
		return &ReparseImportFileResult{
			Batch:         postedBatch,
			Descriptor:    s.descriptorForBatch(postedBatch),
			AlreadyPosted: true,
		}, nil
	}

	file, err := s.repository.FindImportFileById(c, request.Uid, request.FileId)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if file == nil {
		return nil, ErrImportFileNotFound
	}

	if file.ContentState != IMPORT_FILE_CONTENT_STATE_AVAILABLE || !isLowerHexSHA256(file.FileSha256) || file.FileSize < 1 {
		return nil, ErrImportEvidenceUnavailable
	}

	content, err := s.storage.ReadAvailable(c, file.StorageObjectKey, file.FileSha256, file.FileSize)
	if err != nil {
		return nil, ErrImportStorageUnavailable
	}

	evidenceFile := EvidenceFile{OriginalFileName: file.OriginalFileName, Content: content}
	parser, descriptor, err := s.selectParser(c, evidenceFile, request.ParserName)
	if err != nil {
		return nil, err
	}

	parseContext := context.Context(c)
	if parseContext == nil {
		parseContext = context.Background()
	}
	if resolver, ok := parser.(ImportEvidenceParseOptionsResolver); ok {
		request.ParseOptions, err = resolver.ResolveParseOptions(parseContext, evidenceFile, request.ParseOptions)
		if err != nil {
			if parseContext.Err() != nil {
				return nil, parseContext.Err()
			}
			return nil, &ImportFormatError{Code: NormalizeEvidenceParseError(descriptor, err)}
		}
	}
	if err := request.ParseOptions.ValidateForDescriptor(descriptor); err != nil {
		return nil, ErrImportRequestInvalid
	}

	document, err := parser.Parse(parseContext, evidenceFile, request.ParseOptions)
	if err != nil {
		if parseContext.Err() != nil {
			return nil, parseContext.Err()
		}

		return nil, &ImportFormatError{Code: NormalizeEvidenceParseError(descriptor, err)}
	}

	if _, err = ValidateEvidenceDocument(descriptor, document); err != nil {
		return nil, &ImportFormatError{Code: ISSUE_CODE_FILE_STRUCTURE_INVALID}
	}

	account, discovery, err := s.resolveSourceAccount(c, request, descriptor, document.Metadata.SourceAccount, file.FileSha256)
	if err != nil {
		return nil, err
	}

	result := &ReparseImportFileResult{
		SourceAccount: account,
		Discovery:     discovery,
		Descriptor:    descriptor,
	}

	if account == nil {
		return result, nil
	}

	batch, err := s.persister.PersistEvidenceDocument(c, PersistEvidenceDocumentRequest{
		Uid:               request.Uid,
		FileId:            request.FileId,
		SourceAccountId:   account.SourceAccountId,
		Descriptor:        descriptor,
		ParseOptions:      request.ParseOptions,
		ReparseReasonCode: request.ReparseReasonCode,
		Document:          document,
	})
	if err != nil {
		return nil, err
	}
	if batch == nil {
		return nil, ErrImportEvidenceUnavailable
	}

	result.Batch = batch
	return result, nil
}

func (s *ReparseService) descriptorForBatch(batch *ImportBatch) ParserDescriptor {
	if batch == nil {
		return ParserDescriptor{}
	}
	for _, parser := range s.parsers {
		descriptor := parser.Descriptor()
		if descriptor.Name == batch.ParserName {
			return descriptor
		}
	}
	return ParserDescriptor{
		Name:                 batch.ParserName,
		SourceType:           batch.SourceTypeSnapshot,
		ParserVersion:        batch.ParserVersion,
		NormalizationVersion: batch.NormalizationVersion,
	}
}

func (s *ReparseService) selectParser(c core.Context, file EvidenceFile, parserName string) (ImportEvidenceParser, ParserDescriptor, error) {
	probeContext := context.Context(c)
	if probeContext == nil {
		probeContext = context.Background()
	}

	var selected ImportEvidenceParser
	var selectedDescriptor ParserDescriptor
	bestConfidence := PROBE_CONFIDENCE_NONE
	bestCount := 0

	for _, parser := range s.parsers {
		if err := probeContext.Err(); err != nil {
			return nil, ParserDescriptor{}, err
		}

		descriptor := parser.Descriptor()
		if parserName == "" && descriptor.ExplicitSelectionOnly {
			continue
		}
		if parserName != "" && descriptor.Name != parserName {
			continue
		}
		probe := parser.Probe(probeContext, file)
		if probe.Validate(descriptor) != nil {
			return nil, ParserDescriptor{}, &ImportFormatError{Code: ISSUE_CODE_FILE_FORMAT_INVALID}
		}

		if !probe.Confidence.Matched() {
			continue
		}

		if probe.Confidence > bestConfidence {
			selected = parser
			selectedDescriptor = descriptor
			bestConfidence = probe.Confidence
			bestCount = 1
		} else if probe.Confidence == bestConfidence {
			selectedIsGeneric := isGenericBankEvidenceFormat(selectedDescriptor.Format)
			candidateIsGeneric := isGenericBankEvidenceFormat(descriptor.Format)
			switch {
			case selectedIsGeneric && !candidateIsGeneric:
				selected = parser
				selectedDescriptor = descriptor
				bestCount = 1
			case !selectedIsGeneric && candidateIsGeneric:
				// 通用银行表格是结构化兜底，不与同置信度的来源专用解析器争抢。
			default:
				bestCount++
			}
		}
	}

	if selected == nil || bestCount != 1 {
		return nil, ParserDescriptor{}, &ImportFormatError{Code: ISSUE_CODE_FILE_FORMAT_INVALID}
	}

	return selected, selectedDescriptor, nil
}

func (s *ReparseService) resolveSourceAccount(c core.Context, request ReparseImportFileRequest, descriptor ParserDescriptor, candidate SourceAccountCandidate, fileSHA256 string) (*SourceAccount, *SourceAccountDiscovery, error) {
	displayName, err := SafeSourceAccountDisplayName(descriptor.SourceType, candidate)
	if err != nil {
		return nil, nil, &ImportFormatError{Code: ISSUE_CODE_FILE_STRUCTURE_INVALID}
	}

	discovery := &SourceAccountDiscovery{
		SourceType:      descriptor.SourceType,
		EvidenceKind:    candidate.Kind,
		DisplayName:     displayName,
		DiscoveryMethod: candidate.DiscoveryMethod,
	}

	if request.SourceAccountId > 0 {
		account, findErr := s.sourceAccounts.FindSourceAccount(c, request.Uid, request.SourceAccountId)
		if findErr != nil {
			return nil, nil, findErr
		}

		if account == nil {
			return nil, nil, ErrImportSourceAccountNotFound
		}

		if account.SourceType != descriptor.SourceType || account.Status != SOURCE_ACCOUNT_STATUS_ACTIVE {
			return nil, nil, ErrImportSourceAccountUnavailable
		}

		return account, discovery, nil
	}

	if candidate.Kind == SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER {
		account, resolveErr := s.sourceAccounts.ResolveStableSourceAccount(c, request.Uid, descriptor.SourceType, candidate)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		if account == nil {
			return nil, nil, ErrImportPersistenceUnavailable
		}
		return account, discovery, nil
	}

	if candidate.Kind == SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY || candidate.Kind == SOURCE_ACCOUNT_EVIDENCE_MASKED_DISPLAY_ONLY {
		account, resolveErr := s.sourceAccounts.ResolveDisplaySourceAccount(c, request.Uid, descriptor.SourceType, candidate)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		if account != nil {
			return account, discovery, nil
		}
	}

	if descriptor.Format == EVIDENCE_FORMAT_CEB_CREDIT_PDF {
		account, ensureErr := s.sourceAccounts.EnsureCebCreditSourceAccount(c, request.Uid)
		if ensureErr != nil {
			return nil, nil, ensureErr
		}
		if account == nil {
			return nil, nil, ErrImportPersistenceUnavailable
		}
		return account, discovery, nil
	}

	account, ensureErr := s.sourceAccounts.EnsureFileSourceAccount(c, request.Uid, descriptor.SourceType, descriptor.Format, fileSHA256)
	if ensureErr != nil {
		return nil, nil, ensureErr
	}
	if account == nil {
		return nil, nil, ErrImportPersistenceUnavailable
	}
	return account, discovery, nil
}
