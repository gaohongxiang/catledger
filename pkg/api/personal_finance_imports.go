package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/reconciliation"
	"github.com/gaohongxiang/catledger/pkg/services"
	"github.com/gaohongxiang/catledger/pkg/settings"
	"github.com/gaohongxiang/catledger/pkg/uuid"
)

const personalFinanceImportMultipartOverhead = int64(1024 * 1024)

type personalFinanceImportApplication interface {
	UploadImportFile(c core.Context, upload importing.ImportFileUpload) (*importing.ImportFileUploadResult, error)
	GetImportFile(c core.Context, uid int64, fileId int64) (*importing.ImportFile, error)
	ListImportFiles(c core.Context, uid int64, page int32, count int32) (*importing.ImportFilePage, error)
	GetImportBatch(c core.Context, uid int64, batchId int64) (*importing.ImportBatchDetails, error)
	ListImportBatches(c core.Context, uid int64, fileId int64, page int32, count int32) (*importing.ImportBatchPage, error)
	ListRawImportRows(c core.Context, uid int64, batchId int64, page int32, count int32, includeRawSnapshot bool) (*importing.RawImportRowPage, error)
}

type personalFinanceUserReader interface {
	GetUserById(c core.Context, uid int64) (*models.User, error)
}

type personalFinanceAccountReader interface {
	GetAccountByAccountId(c core.Context, uid int64, accountId int64) (*models.Account, error)
}

type personalFinanceLifecycleApplication interface {
	DiscardImportBatch(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error)
	DeleteImportFileContent(c core.Context, uid int64, fileId int64) (*importing.ImportFile, error)
	GetUndoImpact(c core.Context, uid int64, batchId int64) (*importing.UndoImpact, error)
	CheckUserConsistency(c core.Context, uid int64) (*importing.UserConsistencyReport, error)
}

// PersonalFinanceImportsApi 提供独立命名空间下的持久导入纵切面。
type PersonalFinanceImportsApi struct {
	config                  *settings.ConfigContainer
	users                   personalFinanceUserReader
	accounts                personalFinanceAccountReader
	serviceFactory          func() (personalFinanceImportApplication, error)
	flowServiceFactory      func() (personalFinanceFlowApplication, error)
	evidenceServiceFactory  func() (personalFinanceEvidenceApplication, error)
	lifecycleServiceFactory func() (personalFinanceLifecycleApplication, error)
	candidateServiceFactory func() (personalFinanceCandidateApplication, error)
}

// PersonalFinanceImports 是 Web 路由使用的默认 API 实例。
var PersonalFinanceImports = &PersonalFinanceImportsApi{
	config:   settings.Container,
	users:    services.Users,
	accounts: services.Accounts,
	serviceFactory: func() (personalFinanceImportApplication, error) {
		repository, err := importing.NewRepository(datastore.Container.UserDataStore)

		if err != nil {
			return nil, err
		}

		return importing.NewImportService(
			repository,
			services.PersonalFinanceImportFilesStorage,
			func() int64 {
				return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
			},
		)
	},
	flowServiceFactory: newPersonalFinanceFlowApplication,
	evidenceServiceFactory: func() (personalFinanceEvidenceApplication, error) {
		repository, err := importing.NewRepository(datastore.Container.UserDataStore)

		if err != nil {
			return nil, err
		}

		return importing.NewPostingService(
			repository,
			services.PersonalFinancePostingAuthorization,
			services.Transactions,
			func() int64 {
				return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
			},
		)
	},
	lifecycleServiceFactory: func() (personalFinanceLifecycleApplication, error) {
		repository, err := importing.NewRepository(datastore.Container.UserDataStore)
		if err != nil {
			return nil, err
		}
		return importing.NewLifecycleService(repository, services.PersonalFinanceImportFilesStorage, services.PersonalFinanceImportFilesStorage)
	},
	candidateServiceFactory: func() (personalFinanceCandidateApplication, error) {
		return reconciliation.NewCandidateService(datastore.Container.UserDataStore, uuid.Container)
	},
}

type personalFinanceImportBatchListRequest struct {
	FileId int64 `form:"file_id,string" binding:"omitempty,min=1"`
	Page   int32 `form:"page" binding:"omitempty,min=0"`
	Count  int32 `form:"count" binding:"omitempty,min=1,max=100"`
}

type personalFinanceImportFileListRequest struct {
	Page  int32 `form:"page" binding:"omitempty,min=0"`
	Count int32 `form:"count" binding:"omitempty,min=1,max=100"`
}

type personalFinanceImportFileGetRequest struct {
	FileId int64 `form:"file_id,string" binding:"required,min=1"`
}

type personalFinanceImportBatchGetRequest struct {
	BatchId int64 `form:"batch_id,string" binding:"required,min=1"`
}

type personalFinanceRawImportRowListRequest struct {
	BatchId            int64 `form:"batch_id,string" binding:"required,min=1"`
	Page               int32 `form:"page" binding:"omitempty,min=0"`
	Count              int32 `form:"count" binding:"omitempty,min=1,max=100"`
	IncludeRawSnapshot bool  `form:"include_raw_snapshot"`
}

type personalFinanceImportBatchDiscardRequest struct {
	BatchId int64 `json:"batchId,string" binding:"required,min=1"`
}

type personalFinanceImportFileDeleteContentRequest struct {
	FileId int64 `json:"fileId,string" binding:"required,min=1"`
}

type personalFinanceUndoImpactResponse struct {
	BatchId                  int64                        `json:"batchId,string"`
	LinkedTransactionCount   int64                        `json:"linkedTransactionCount"`
	PostingCreatedCount      int64                        `json:"postingCreatedCount"`
	PostingReusedCount       int64                        `json:"postingReusedCount"`
	ModifiedTransactionCount int64                        `json:"modifiedTransactionCount"`
	MissingTransactionCount  int64                        `json:"missingTransactionCount"`
	SharedTransactionCount   int64                        `json:"sharedTransactionCount"`
	ReasonCodes              []importing.UndoImpactReason `json:"reasonCodes"`
}

type personalFinanceImportFileResponse struct {
	Id                     int64                            `json:"id,string"`
	OriginalFileName       string                           `json:"originalFileName"`
	FileSize               int64                            `json:"fileSize,string"`
	MimeType               string                           `json:"mimeType"`
	FileExtension          string                           `json:"fileExtension"`
	ContentState           importing.ImportFileContentState `json:"contentState"`
	CreatedUnixTime        int64                            `json:"createdUnixTime"`
	UpdatedUnixTime        int64                            `json:"updatedUnixTime"`
	ContentDeletedUnixTime *int64                           `json:"contentDeletedUnixTime,omitempty"`
}

type personalFinanceImportFileUploadResponse struct {
	File      *personalFinanceImportFileResponse `json:"file"`
	Duplicate bool                               `json:"duplicate"`
	Recovered bool                               `json:"recovered"`
}

type personalFinanceImportFilePageResponse struct {
	Items      []*personalFinanceImportFileResponse `json:"items"`
	TotalCount int64                                `json:"totalCount"`
}

type personalFinanceImportBatchResponse struct {
	Id                         int64                                `json:"id,string"`
	FileId                     int64                                `json:"fileId,string"`
	SourceAccountId            *int64                               `json:"sourceAccountId,string,omitempty"`
	Status                     importing.ImportBatchStatus          `json:"status"`
	SourceType                 importing.SourceType                 `json:"sourceType"`
	LedgerAccountId            *int64                               `json:"ledgerAccountId,string,omitempty"`
	ParserName                 string                               `json:"parserName"`
	ParserVersion              importing.RuleVersion                `json:"parserVersion"`
	NormalizationVersion       importing.RuleVersion                `json:"normalizationVersion"`
	IdentityKeyVersion         importing.RuleVersion                `json:"identityKeyVersion"`
	CoreDigestVersion          importing.RuleVersion                `json:"coreDigestVersion"`
	FingerprintVersion         importing.RuleVersion                `json:"fingerprintVersion"`
	RawSnapshotVersion         importing.RuleVersion                `json:"rawSnapshotVersion"`
	ReparseReasonCode          string                               `json:"reparseReasonCode"`
	StatementStartUnixTime     *int64                               `json:"statementStartUnixTime,omitempty"`
	StatementEndUnixTime       *int64                               `json:"statementEndUnixTime,omitempty"`
	StatementTimezoneUtcOffset *int16                               `json:"statementTimezoneUtcOffset,omitempty"`
	StatementDate              string                               `json:"statementDate,omitempty"`
	DueDate                    string                               `json:"dueDate,omitempty"`
	CreditLimitAmount          *int64                               `json:"creditLimitAmount,string,omitempty"`
	CreditLimitCurrency        string                               `json:"creditLimitCurrency,omitempty"`
	TotalRowCount              int64                                `json:"totalRowCount"`
	ValidRowCount              int64                                `json:"validRowCount"`
	InvalidRowCount            int64                                `json:"invalidRowCount"`
	ExactDuplicateRowCount     int64                                `json:"exactDuplicateRowCount"`
	IdentityConflictRowCount   int64                                `json:"identityConflictRowCount"`
	PendingRowCount            int64                                `json:"pendingRowCount"`
	PostedRowCount             int64                                `json:"postedRowCount"`
	ErrorCode                  string                               `json:"errorCode"`
	ErrorSummary               string                               `json:"errorSummary"`
	CreatedUnixTime            int64                                `json:"createdUnixTime"`
	StartedUnixTime            *int64                               `json:"startedUnixTime,omitempty"`
	CompletedUnixTime          *int64                               `json:"completedUnixTime,omitempty"`
	UpdatedUnixTime            int64                                `json:"updatedUnixTime"`
	File                       *personalFinanceImportFileResponse   `json:"file,omitempty"`
	Issues                     []*personalFinanceBatchIssueResponse `json:"issues,omitempty"`
}

type personalFinanceBatchIssueResponse struct {
	Code     importing.IssueCode     `json:"code"`
	Severity importing.IssueSeverity `json:"severity"`
	Field    string                  `json:"field,omitempty"`
}

type personalFinanceImportBatchPageResponse struct {
	Items      []*personalFinanceImportBatchResponse `json:"items"`
	TotalCount int64                                 `json:"totalCount"`
}

type personalFinanceRawImportRowResponse struct {
	Id                          int64                           `json:"id,string"`
	BatchId                     int64                           `json:"batchId,string"`
	RowNumber                   int64                           `json:"rowNumber"`
	SourceLocator               string                          `json:"sourceLocator"`
	IdentityId                  *int64                          `json:"identityId,string,omitempty"`
	SourceTransactionId         string                          `json:"sourceTransactionId"`
	SourceOrderId               string                          `json:"sourceOrderId"`
	SourceMerchantOrderId       string                          `json:"sourceMerchantOrderId"`
	RawTransactionTime          string                          `json:"rawTransactionTime"`
	RawAmount                   string                          `json:"rawAmount"`
	RawDirection                string                          `json:"rawDirection"`
	RawStatus                   string                          `json:"rawStatus"`
	RawTransactionType          string                          `json:"rawTransactionType"`
	RawCounterparty             string                          `json:"rawCounterparty"`
	RawItem                     string                          `json:"rawItem"`
	RawPaymentMethod            string                          `json:"rawPaymentMethod"`
	RawNote                     string                          `json:"rawNote"`
	NormalizedUnixTime          *int64                          `json:"normalizedUnixTime,omitempty"`
	NormalizedTimezoneUtcOffset *int16                          `json:"normalizedTimezoneUtcOffset,omitempty"`
	NormalizedAmount            *int64                          `json:"normalizedAmount,string,omitempty"`
	Currency                    string                          `json:"currency"`
	NormalizedDirection         importing.NormalizedDirection   `json:"normalizedDirection"`
	NormalizedTransactionType   importing.SourceTransactionType `json:"normalizedTransactionType"`
	EconomicEffect              importing.EconomicEffect        `json:"economicEffect"`
	LedgerAccountId             *int64                          `json:"ledgerAccountId,string,omitempty"`
	PrimaryIssueCode            importing.IssueCode             `json:"primaryIssueCode"`
	ParserVersion               importing.RuleVersion           `json:"parserVersion"`
	NormalizationVersion        importing.RuleVersion           `json:"normalizationVersion"`
	IdentityKeyVersion          importing.RuleVersion           `json:"identityKeyVersion"`
	CoreDigestVersion           importing.RuleVersion           `json:"coreDigestVersion"`
	FingerprintVersion          importing.RuleVersion           `json:"fingerprintVersion"`
	RawSnapshotVersion          importing.RuleVersion           `json:"rawSnapshotVersion"`
	SemanticEligibility         importing.SemanticEligibility   `json:"semanticEligibility"`
	ParseState                  importing.ParseState            `json:"parseState"`
	IdentityState               importing.IdentityState         `json:"identityState"`
	Disposition                 importing.ImportDisposition     `json:"disposition"`
	ProcessingState             importing.ProcessingState       `json:"processingState"`
	CreatedUnixTime             int64                           `json:"createdUnixTime"`
	RawFields                   json.RawMessage                 `json:"rawFields,omitempty"`
	Issues                      json.RawMessage                 `json:"issues,omitempty"`
}

type personalFinanceRawImportRowPageResponse struct {
	Batch      *personalFinanceImportBatchResponse    `json:"batch"`
	Items      []*personalFinanceRawImportRowResponse `json:"items"`
	TotalCount int64                                  `json:"totalCount"`
}

// ImportFileUploadHandler 持久化原始上传，不调用任何来源解析器。
func (a *PersonalFinanceImportsApi) ImportFileUploadHandler(c *core.WebContext) (any, *errs.Error) {
	uid := c.GetCurrentUid()
	config := a.config.GetCurrentConfig()

	if config == nil || !config.EnableDataImport {
		return nil, errs.ErrDataImportNotAllowed
	}

	user, err := a.users.GetUserById(c, uid)

	if err != nil {
		log.Warnf(c, "[personal_finance_imports.ImportFileUploadHandler] cannot load current user \"uid:%d\"", uid)
		return nil, errs.ErrUserNotFound
	}

	if user.FeatureRestriction.Contains(core.USER_FEATURE_RESTRICTION_TYPE_IMPORT_TRANSACTION) {
		return nil, errs.ErrNotPermittedToPerformThisAction
	}

	maximumFileSize := int64(config.MaxImportFileSize)

	if c.Request == nil || c.Request.Body == nil {
		return nil, errs.ErrParameterInvalid
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maximumFileSize+personalFinanceImportMultipartOverhead)
	form, err := c.MultipartForm()

	if err != nil {
		var maximumBytesError *http.MaxBytesError

		if errors.As(err, &maximumBytesError) {
			return nil, errs.ErrExceedMaxUploadFileSize
		}

		log.Warnf(c, "[personal_finance_imports.ImportFileUploadHandler] invalid multipart request for user \"uid:%d\"", uid)
		return nil, errs.ErrParameterInvalid
	}
	defer form.RemoveAll()

	files := form.File["file"]

	if len(files) < 1 {
		return nil, errs.ErrNoFilesUpload
	}

	if files[0].Size < 1 {
		return nil, errs.ErrUploadedFileEmpty
	}

	if files[0].Size > maximumFileSize {
		return nil, errs.ErrExceedMaxUploadFileSize
	}

	uploadedFile, err := files[0].Open()

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileUploadHandler] cannot open upload for user \"uid:%d\"", uid)
		return nil, errs.ErrOperationFailed
	}

	defer uploadedFile.Close()
	content, err := io.ReadAll(io.LimitReader(uploadedFile, maximumFileSize+1))

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileUploadHandler] cannot read upload for user \"uid:%d\"", uid)
		return nil, errs.ErrOperationFailed
	}

	if len(content) < 1 {
		return nil, errs.ErrUploadedFileEmpty
	}

	if int64(len(content)) > maximumFileSize {
		return nil, errs.ErrExceedMaxUploadFileSize
	}

	service, err := a.serviceFactory()

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileUploadHandler] import service is unavailable for user \"uid:%d\"", uid)
		return nil, errs.ErrOperationFailed
	}

	result, err := service.UploadImportFile(c, importing.ImportFileUpload{
		Uid:              uid,
		OriginalFileName: files[0].Filename,
		MimeType:         http.DetectContentType(content),
		CreatedIp:        c.ClientIP(),
		Content:          content,
	})

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileUploadHandler] upload persistence failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	log.Infof(c, "[personal_finance_imports.ImportFileUploadHandler] import file \"id:%d\" is durable for user \"uid:%d\"", result.File.FileId, uid)
	return &personalFinanceImportFileUploadResponse{
		File:      newPersonalFinanceImportFileResponse(result.File),
		Duplicate: result.Duplicate,
		Recovered: result.Recovered,
	}, nil
}

// ImportFileListHandler 返回当前用户的稳定分页原文件元数据。
func (a *PersonalFinanceImportsApi) ImportFileListHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportFileListRequest)

	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	service, err := a.serviceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	page, err := service.ListImportFiles(c, uid, request.Page, request.Count)

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileListHandler] file query failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	items := make([]*personalFinanceImportFileResponse, 0, len(page.Items))

	for _, file := range page.Items {
		items = append(items, newPersonalFinanceImportFileResponse(file))
	}

	return &personalFinanceImportFilePageResponse{Items: items, TotalCount: page.TotalCount}, nil
}

// ImportFileGetHandler 返回当前用户的一份原文件元数据。
func (a *PersonalFinanceImportsApi) ImportFileGetHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportFileGetRequest)

	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	service, err := a.serviceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	file, err := service.GetImportFile(c, uid, request.FileId)

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportFileGetHandler] file query failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	return newPersonalFinanceImportFileResponse(file), nil
}

// ImportBatchListHandler 返回当前用户的稳定分页批次历史。
func (a *PersonalFinanceImportsApi) ImportBatchListHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportBatchListRequest)

	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	service, err := a.serviceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	page, err := service.ListImportBatches(c, uid, request.FileId, request.Page, request.Count)

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportBatchListHandler] batch query failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	items := make([]*personalFinanceImportBatchResponse, 0, len(page.Items))

	for _, item := range page.Items {
		items = append(items, newPersonalFinanceImportBatchResponse(item))
	}

	return &personalFinanceImportBatchPageResponse{Items: items, TotalCount: page.TotalCount}, nil
}

// ImportBatchGetHandler 返回当前用户的一个批次及文件元数据。
func (a *PersonalFinanceImportsApi) ImportBatchGetHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportBatchGetRequest)

	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	service, err := a.serviceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	details, err := service.GetImportBatch(c, uid, request.BatchId)

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.ImportBatchGetHandler] batch query failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	return newPersonalFinanceImportBatchResponse(details), nil
}

// RawImportRowListHandler 返回当前用户批次内按逻辑行号稳定分页的原始行。
func (a *PersonalFinanceImportsApi) RawImportRowListHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceRawImportRowListRequest)

	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	service, err := a.serviceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	page, err := service.ListRawImportRows(c, uid, request.BatchId, request.Page, request.Count, request.IncludeRawSnapshot)

	if err != nil {
		log.Errorf(c, "[personal_finance_imports.RawImportRowListHandler] row query failed for user \"uid:%d\"", uid)
		return nil, personalFinanceImportError(err)
	}

	items := make([]*personalFinanceRawImportRowResponse, 0, len(page.Items))

	for _, row := range page.Items {
		items = append(items, newPersonalFinanceRawImportRowResponse(row, request.IncludeRawSnapshot))
	}

	return &personalFinanceRawImportRowPageResponse{
		Batch:      newPersonalFinanceImportBatchResponse(page.Batch),
		Items:      items,
		TotalCount: page.TotalCount,
	}, nil
}

// ImportBatchDiscardHandler 废弃尚未产生任何账本影响的批次。
func (a *PersonalFinanceImportsApi) ImportBatchDiscardHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportBatchDiscardRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	service, err := a.lifecycleServiceFactory()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	batch, err := service.DiscardImportBatch(c, c.GetCurrentUid(), request.BatchId)
	if err != nil {
		return nil, personalFinanceImportError(err)
	}
	return newPersonalFinanceImportBatchResponse(&importing.ImportBatchDetails{Batch: batch}), nil
}

// ImportFileDeleteContentHandler 只删除原文件字节，不删除证据链。
func (a *PersonalFinanceImportsApi) ImportFileDeleteContentHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportFileDeleteContentRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	service, err := a.lifecycleServiceFactory()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	file, err := service.DeleteImportFileContent(c, c.GetCurrentUid(), request.FileId)
	if err != nil {
		return nil, personalFinanceImportError(err)
	}
	return newPersonalFinanceImportFileResponse(file), nil
}

// ImportBatchUndoImpactHandler 返回聚合影响，绝不执行账本撤销。
func (a *PersonalFinanceImportsApi) ImportBatchUndoImpactHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceImportBatchGetRequest)
	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	service, err := a.lifecycleServiceFactory()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	impact, err := service.GetUndoImpact(c, c.GetCurrentUid(), request.BatchId)
	if err != nil {
		return nil, personalFinanceImportError(err)
	}
	return &personalFinanceUndoImpactResponse{
		BatchId: impact.BatchId, LinkedTransactionCount: impact.LinkedTransactionCount,
		PostingCreatedCount: impact.PostingCreatedCount, PostingReusedCount: impact.PostingReusedCount,
		ModifiedTransactionCount: impact.ModifiedTransactionCount, MissingTransactionCount: impact.MissingTransactionCount,
		SharedTransactionCount: impact.SharedTransactionCount, ReasonCodes: impact.ReasonCodes,
	}, nil
}

// PersonalFinanceConsistencyHandler 返回当前用户的脱敏一致性聚合。
func (a *PersonalFinanceImportsApi) PersonalFinanceConsistencyHandler(c *core.WebContext) (any, *errs.Error) {
	service, err := a.lifecycleServiceFactory()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	report, err := service.CheckUserConsistency(c, c.GetCurrentUid())
	if err != nil {
		return nil, personalFinanceImportError(err)
	}
	return report, nil
}

func personalFinanceImportError(err error) *errs.Error {
	switch {
	case errors.Is(err, importing.ErrImportRequestInvalid):
		return errs.ErrParameterInvalid
	case errors.Is(err, importing.ErrImportFileNotFound), errors.Is(err, importing.ErrImportBatchNotFound):
		// 不区分“不存在”和“属于其他 uid”，避免对象枚举。
		return errs.ErrParameterInvalid
	case errors.Is(err, importing.ErrImportIdentifierUnavailable):
		return errs.ErrSystemIsBusy
	case errors.Is(err, importing.ErrImportBatchNotDiscardable), errors.Is(err, importing.ErrImportFileContentNotDeletable):
		return errs.ErrNotPermittedToPerformThisAction
	default:
		return errs.ErrOperationFailed
	}
}

func newPersonalFinanceImportFileResponse(file *importing.ImportFile) *personalFinanceImportFileResponse {
	if file == nil {
		return nil
	}

	return &personalFinanceImportFileResponse{
		Id:                     file.FileId,
		OriginalFileName:       file.OriginalFileName,
		FileSize:               file.FileSize,
		MimeType:               file.MimeType,
		FileExtension:          file.FileExtension,
		ContentState:           file.ContentState,
		CreatedUnixTime:        file.CreatedUnixTime,
		UpdatedUnixTime:        file.UpdatedUnixTime,
		ContentDeletedUnixTime: file.ContentDeletedUnixTime,
	}
}

func newPersonalFinanceImportBatchResponse(details *importing.ImportBatchDetails) *personalFinanceImportBatchResponse {
	if details == nil || details.Batch == nil {
		return nil
	}

	batch := details.Batch
	response := &personalFinanceImportBatchResponse{
		Id:                         batch.BatchId,
		FileId:                     batch.FileId,
		SourceAccountId:            batch.SourceAccountId,
		Status:                     batch.Status,
		SourceType:                 batch.SourceTypeSnapshot,
		LedgerAccountId:            batch.LedgerAccountId,
		ParserName:                 batch.ParserName,
		ParserVersion:              batch.ParserVersion,
		NormalizationVersion:       batch.NormalizationVersion,
		IdentityKeyVersion:         batch.IdentityKeyVersion,
		CoreDigestVersion:          batch.CoreDigestVersion,
		FingerprintVersion:         batch.FingerprintVersion,
		RawSnapshotVersion:         batch.RawSnapshotVersion,
		ReparseReasonCode:          batch.ReparseReasonCode,
		StatementStartUnixTime:     batch.StatementStartUnixTime,
		StatementEndUnixTime:       batch.StatementEndUnixTime,
		StatementTimezoneUtcOffset: batch.StatementTimezoneUtcOffset,
		TotalRowCount:              batch.TotalRowCount,
		ValidRowCount:              batch.ValidRowCount,
		InvalidRowCount:            batch.InvalidRowCount,
		ExactDuplicateRowCount:     batch.ExactDuplicateRowCount,
		IdentityConflictRowCount:   batch.IdentityConflictRowCount,
		PendingRowCount:            batch.PendingRowCount,
		PostedRowCount:             batch.PostedRowCount,
		ErrorCode:                  batch.ErrorCode,
		ErrorSummary:               batch.ErrorSummary,
		CreatedUnixTime:            batch.CreatedUnixTime,
		StartedUnixTime:            batch.StartedUnixTime,
		CompletedUnixTime:          batch.CompletedUnixTime,
		UpdatedUnixTime:            batch.UpdatedUnixTime,
		File:                       newPersonalFinanceImportFileResponse(details.File),
	}

	if header := details.CardHeader; header != nil {
		response.StatementDate = header.StatementDate
		response.DueDate = header.DueDate
		response.CreditLimitAmount = header.CreditLimitAmount
		response.CreditLimitCurrency = header.Currency
	}

	if len(details.Issues) > 0 {
		response.Issues = make([]*personalFinanceBatchIssueResponse, 0, len(details.Issues))
		for _, issue := range details.Issues {
			if issue == nil {
				continue
			}

			response.Issues = append(response.Issues, &personalFinanceBatchIssueResponse{
				Code:     issue.Code,
				Severity: issue.Severity,
				Field:    issue.Field,
			})
		}
	}

	return response
}

func newPersonalFinanceRawImportRowResponse(row *importing.RawImportRow, includeRawSnapshot bool) *personalFinanceRawImportRowResponse {
	response := &personalFinanceRawImportRowResponse{
		Id:                          row.RowId,
		BatchId:                     row.BatchId,
		RowNumber:                   row.RowNumber,
		SourceLocator:               row.SourceLocator,
		IdentityId:                  row.IdentityId,
		SourceTransactionId:         row.SourceTransactionId,
		SourceOrderId:               row.SourceOrderId,
		SourceMerchantOrderId:       row.SourceMerchantOrderId,
		RawTransactionTime:          row.RawTransactionTime,
		RawAmount:                   row.RawAmount,
		RawDirection:                row.RawDirection,
		RawStatus:                   row.RawStatus,
		RawTransactionType:          row.RawTransactionType,
		RawCounterparty:             row.RawCounterparty,
		RawItem:                     row.RawItem,
		RawPaymentMethod:            row.RawPaymentMethod,
		RawNote:                     row.RawNote,
		NormalizedUnixTime:          row.NormalizedUnixTime,
		NormalizedTimezoneUtcOffset: row.NormalizedTimezoneUtcOffset,
		NormalizedAmount:            row.NormalizedAmount,
		Currency:                    row.Currency,
		NormalizedDirection:         row.NormalizedDirection,
		NormalizedTransactionType:   row.NormalizedTransactionType,
		EconomicEffect:              row.EconomicEffect,
		LedgerAccountId:             row.LedgerAccountId,
		PrimaryIssueCode:            row.PrimaryIssueCode,
		ParserVersion:               row.ParserVersion,
		NormalizationVersion:        row.NormalizationVersion,
		IdentityKeyVersion:          row.IdentityKeyVersion,
		CoreDigestVersion:           row.CoreDigestVersion,
		FingerprintVersion:          row.FingerprintVersion,
		RawSnapshotVersion:          row.RawSnapshotVersion,
		SemanticEligibility:         row.SemanticEligibility,
		ParseState:                  row.ParseState,
		IdentityState:               row.IdentityState,
		Disposition:                 row.Disposition,
		ProcessingState:             row.ProcessingState,
		CreatedUnixTime:             row.CreatedUnixTime,
	}

	if includeRawSnapshot {
		response.RawFields = json.RawMessage(row.RawFieldsJson)
		response.Issues = json.RawMessage(row.IssuesJson)
	}

	return response
}
