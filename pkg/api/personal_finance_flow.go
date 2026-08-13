package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/converters/alipay"
	"github.com/mayswind/ezbookkeeping/pkg/converters/wechat"
	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/services"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

type personalFinanceFlowApplication interface {
	ReparseImportFile(c core.Context, request importing.ReparseImportFileRequest) (*importing.ReparseImportFileResult, error)
	ListSourceAccounts(c core.Context, uid int64) ([]*importing.SourceAccount, error)
	SaveSourceAccount(c core.Context, request importing.SourceAccountSaveRequest) (*importing.SourceAccount, error)
}

type personalFinanceFlowService struct {
	reparse        *importing.ReparseService
	sourceAccounts *importing.SourceAccountService
}

func (s *personalFinanceFlowService) ReparseImportFile(c core.Context, request importing.ReparseImportFileRequest) (*importing.ReparseImportFileResult, error) {
	return s.reparse.ReparseImportFile(c, request)
}

func (s *personalFinanceFlowService) ListSourceAccounts(c core.Context, uid int64) ([]*importing.SourceAccount, error) {
	return s.sourceAccounts.ListSourceAccounts(c, uid)
}

func (s *personalFinanceFlowService) SaveSourceAccount(c core.Context, request importing.SourceAccountSaveRequest) (*importing.SourceAccount, error) {
	return s.sourceAccounts.SaveSourceAccount(c, request)
}

func newPersonalFinanceFlowApplication() (personalFinanceFlowApplication, error) {
	repository, err := importing.NewRepository(datastore.Container.UserDataStore)
	if err != nil {
		return nil, err
	}

	generateId := func() int64 {
		return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	}
	sourceAccounts, err := importing.NewSourceAccountService(repository, generateId)
	if err != nil {
		return nil, err
	}

	dedup, err := importing.NewDedupService(repository, generateId)
	if err != nil {
		return nil, err
	}

	reparse, err := importing.NewReparseService(
		repository,
		services.PersonalFinanceImportFilesStorage,
		[]importing.ImportEvidenceParser{
			alipay.AlipayAppImportEvidenceParser,
			alipay.AlipayWebImportEvidenceParser,
			wechat.WeChatPayImportEvidenceCsvParser,
			wechat.WeChatPayImportEvidenceXlsxParser,
		},
		sourceAccounts,
		dedup,
	)
	if err != nil {
		return nil, err
	}

	return &personalFinanceFlowService{reparse: reparse, sourceAccounts: sourceAccounts}, nil
}

type personalFinanceReparseRequest struct {
	FileId            int64  `json:"fileId,string" binding:"required,min=1"`
	SourceAccountId   int64  `json:"sourceAccountId,string" binding:"omitempty,min=1"`
	Currency          string `json:"currency" binding:"required,len=3"`
	TimezoneUtcOffset int16  `json:"timezoneUtcOffset" binding:"min=-720,max=840"`
	ReasonCode        string `json:"reasonCode" binding:"required,max=64"`
}

type personalFinanceSourceAccountSaveRequest struct {
	Id              int64                         `json:"id,string" binding:"omitempty,min=1"`
	SourceType      importing.SourceType          `json:"sourceType" binding:"required"`
	DisplayName     string                        `json:"displayName" binding:"required,max=128"`
	LedgerAccountId int64                         `json:"ledgerAccountId,string" binding:"omitempty,min=1"`
	Status          importing.SourceAccountStatus `json:"status" binding:"required"`
}

type personalFinanceSourceAccountResponse struct {
	Id              int64                                  `json:"id,string"`
	SourceType      importing.SourceType                   `json:"sourceType"`
	LedgerAccountId *int64                                 `json:"ledgerAccountId,string,omitempty"`
	Status          importing.SourceAccountStatus          `json:"status"`
	DisplayName     string                                 `json:"displayName"`
	DiscoveryMethod importing.SourceAccountDiscoveryMethod `json:"discoveryMethod"`
	CreatedUnixTime int64                                  `json:"createdUnixTime"`
	UpdatedUnixTime int64                                  `json:"updatedUnixTime"`
}

type personalFinanceSourceAccountListResponse struct {
	Items []*personalFinanceSourceAccountResponse `json:"items"`
}

type personalFinanceSourceAccountDiscoveryResponse struct {
	SourceType      importing.SourceType                   `json:"sourceType"`
	EvidenceKind    importing.SourceAccountEvidenceKind    `json:"evidenceKind"`
	DisplayName     string                                 `json:"displayName"`
	DiscoveryMethod importing.SourceAccountDiscoveryMethod `json:"discoveryMethod"`
}

type personalFinanceReparseResponse struct {
	Batch                 *personalFinanceImportBatchResponse            `json:"batch,omitempty"`
	SourceAccount         *personalFinanceSourceAccountResponse          `json:"sourceAccount,omitempty"`
	Discovery             *personalFinanceSourceAccountDiscoveryResponse `json:"discovery,omitempty"`
	RequiresSourceAccount bool                                           `json:"requiresSourceAccount"`
	ParserName            string                                         `json:"parserName"`
	SourceType            importing.SourceType                           `json:"sourceType"`
	Format                importing.EvidenceFormat                       `json:"format"`
}

type personalFinanceTransactionEvidenceRequest struct {
	TransactionId int64 `form:"transaction_id,string" binding:"required,min=1"`
}

type personalFinanceTransactionEvidenceItemResponse struct {
	RowId                       int64                                     `json:"rowId,string"`
	BatchId                     int64                                     `json:"batchId,string"`
	FileId                      int64                                     `json:"fileId,string"`
	RowNumber                   int64                                     `json:"rowNumber"`
	SourceType                  importing.SourceType                      `json:"sourceType"`
	FileExtension               string                                    `json:"fileExtension"`
	NormalizedUnixTime          *int64                                    `json:"normalizedUnixTime,omitempty"`
	NormalizedTimezoneUtcOffset *int16                                    `json:"normalizedTimezoneUtcOffset,omitempty"`
	NormalizedAmount            *int64                                    `json:"normalizedAmount,string,omitempty"`
	Currency                    string                                    `json:"currency"`
	NormalizedDirection         importing.NormalizedDirection             `json:"normalizedDirection"`
	NormalizedTransactionType   importing.SourceTransactionType           `json:"normalizedTransactionType"`
	EconomicEffect              importing.EconomicEffect                  `json:"economicEffect"`
	PrimaryIssueCode            importing.IssueCode                       `json:"primaryIssueCode"`
	ParseState                  importing.ParseState                      `json:"parseState"`
	IdentityState               importing.IdentityState                   `json:"identityState"`
	Disposition                 importing.ImportDisposition               `json:"disposition"`
	ProcessingState             importing.ProcessingState                 `json:"processingState"`
	RelationRole                importing.RawRowTransactionRelationRole   `json:"relationRole"`
	CreationMethod              importing.RawRowTransactionCreationMethod `json:"creationMethod"`
	RuleVersion                 importing.RuleVersion                     `json:"ruleVersion"`
	TransactionUpdatedUnixTime  int64                                     `json:"transactionUpdatedUnixTime"`
	LinkedUnixTime              int64                                     `json:"linkedUnixTime"`
}

type personalFinanceTransactionEvidenceResponse struct {
	TransactionId int64                                             `json:"transactionId,string"`
	Items         []*personalFinanceTransactionEvidenceItemResponse `json:"items"`
}

// ImportBatchReparseHandler 从已校验原文件创建新批次，弱来源证据要求用户显式选择档案。
func (a *PersonalFinanceImportsApi) ImportBatchReparseHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.ensurePersonalFinanceImportWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}

	request := new(personalFinanceReparseRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	uid := c.GetCurrentUid()
	result, err := service.ReparseImportFile(c, importing.ReparseImportFileRequest{
		Uid:             uid,
		FileId:          request.FileId,
		SourceAccountId: request.SourceAccountId,
		ParseOptions: importing.ResolvedParseOptions{
			Currency:          request.Currency,
			TimezoneUtcOffset: request.TimezoneUtcOffset,
		},
		ReparseReasonCode: request.ReasonCode,
	})
	if err != nil {
		log.Warnf(c, "[personal_finance_flow.ImportBatchReparseHandler] reparse failed for user \"uid:%d\" and file \"id:%d\"", uid, request.FileId)
		return nil, personalFinanceFlowError(err)
	}

	if result == nil {
		return nil, errs.ErrOperationFailed
	}

	return &personalFinanceReparseResponse{
		Batch:                 newPersonalFinanceImportBatchResponse(&importing.ImportBatchDetails{Batch: result.Batch}),
		SourceAccount:         newPersonalFinanceSourceAccountResponse(result.SourceAccount),
		Discovery:             newPersonalFinanceSourceAccountDiscoveryResponse(result.Discovery),
		RequiresSourceAccount: result.Batch == nil,
		ParserName:            result.Descriptor.Name,
		SourceType:            result.Descriptor.SourceType,
		Format:                result.Descriptor.Format,
	}, nil
}

// SourceAccountListHandler 返回不含身份哈希的来源账户档案。
func (a *PersonalFinanceImportsApi) SourceAccountListHandler(c *core.WebContext) (any, *errs.Error) {
	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	accounts, err := service.ListSourceAccounts(c, c.GetCurrentUid())
	if err != nil {
		return nil, personalFinanceFlowError(err)
	}

	items := make([]*personalFinanceSourceAccountResponse, 0, len(accounts))
	for _, account := range accounts {
		items = append(items, newPersonalFinanceSourceAccountResponse(account))
	}

	return &personalFinanceSourceAccountListResponse{Items: items}, nil
}

// SourceAccountSaveHandler 创建人工档案，或只更新既有档案的展示、映射和状态。
func (a *PersonalFinanceImportsApi) SourceAccountSaveHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.ensurePersonalFinanceImportWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}

	request := new(personalFinanceSourceAccountSaveRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	account, err := service.SaveSourceAccount(c, importing.SourceAccountSaveRequest{
		Uid:             c.GetCurrentUid(),
		SourceAccountId: request.Id,
		SourceType:      request.SourceType,
		DisplayName:     request.DisplayName,
		LedgerAccountId: request.LedgerAccountId,
		Status:          request.Status,
	})
	if err != nil {
		return nil, personalFinanceFlowError(err)
	}

	return newPersonalFinanceSourceAccountResponse(account), nil
}

// TransactionEvidenceHandler 返回不含原始标识、原始字段、备注和存储 key 的证据摘要。
func (a *PersonalFinanceImportsApi) TransactionEvidenceHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceTransactionEvidenceRequest)
	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	if a.postingServiceFactory == nil {
		return nil, errs.ErrOperationFailed
	}

	service, err := a.postingServiceFactory()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	result, err := service.GetTransactionEvidence(c, c.GetCurrentUid(), request.TransactionId)
	if err != nil {
		return nil, personalFinancePostingError(err)
	}
	if result == nil {
		return nil, errs.ErrOperationFailed
	}

	response := newPersonalFinanceTransactionEvidenceResponse(result)
	if response == nil {
		return nil, errs.ErrOperationFailed
	}

	return response, nil
}

func newPersonalFinanceTransactionEvidenceResponse(result *importing.TransactionEvidenceResult) *personalFinanceTransactionEvidenceResponse {
	if result == nil {
		return nil
	}

	items := make([]*personalFinanceTransactionEvidenceItemResponse, 0, len(result.Items))
	for _, item := range result.Items {
		if item == nil || item.Link == nil || item.Row == nil || item.Batch == nil || item.File == nil {
			return nil
		}

		items = append(items, &personalFinanceTransactionEvidenceItemResponse{
			RowId:                       item.Row.RowId,
			BatchId:                     item.Batch.BatchId,
			FileId:                      item.File.FileId,
			RowNumber:                   item.Row.RowNumber,
			SourceType:                  item.Batch.SourceTypeSnapshot,
			FileExtension:               item.File.FileExtension,
			NormalizedUnixTime:          item.Row.NormalizedUnixTime,
			NormalizedTimezoneUtcOffset: item.Row.NormalizedTimezoneUtcOffset,
			NormalizedAmount:            item.Row.NormalizedAmount,
			Currency:                    item.Row.Currency,
			NormalizedDirection:         item.Row.NormalizedDirection,
			NormalizedTransactionType:   item.Row.NormalizedTransactionType,
			EconomicEffect:              item.Row.EconomicEffect,
			PrimaryIssueCode:            item.Row.PrimaryIssueCode,
			ParseState:                  item.Row.ParseState,
			IdentityState:               item.Row.IdentityState,
			Disposition:                 item.Row.Disposition,
			ProcessingState:             item.Row.ProcessingState,
			RelationRole:                item.Link.RelationRole,
			CreationMethod:              item.Link.CreationMethod,
			RuleVersion:                 item.Link.RuleVersion,
			TransactionUpdatedUnixTime:  item.Link.TransactionUpdatedUnixTime,
			LinkedUnixTime:              item.Link.CreatedUnixTime,
		})
	}

	return &personalFinanceTransactionEvidenceResponse{TransactionId: result.TransactionId, Items: items}
}

func (a *PersonalFinanceImportsApi) newPersonalFinanceFlowService() (personalFinanceFlowApplication, error) {
	if a.flowServiceFactory == nil {
		return nil, importing.ErrImportPersistenceUnavailable
	}

	return a.flowServiceFactory()
}

func (a *PersonalFinanceImportsApi) ensurePersonalFinanceImportWriteAllowed(c *core.WebContext) *errs.Error {
	if a.config == nil || a.users == nil {
		return errs.ErrDataImportNotAllowed
	}

	config := a.config.GetCurrentConfig()
	if config == nil || !config.EnableDataImport {
		return errs.ErrDataImportNotAllowed
	}

	user, err := a.users.GetUserById(c, c.GetCurrentUid())
	if err != nil || user == nil {
		return errs.ErrUserNotFound
	}

	if user.FeatureRestriction.Contains(core.USER_FEATURE_RESTRICTION_TYPE_IMPORT_TRANSACTION) {
		return errs.ErrNotPermittedToPerformThisAction
	}

	return nil
}

func newPersonalFinanceSourceAccountResponse(account *importing.SourceAccount) *personalFinanceSourceAccountResponse {
	if account == nil {
		return nil
	}

	return &personalFinanceSourceAccountResponse{
		Id:              account.SourceAccountId,
		SourceType:      account.SourceType,
		LedgerAccountId: account.LedgerAccountId,
		Status:          account.Status,
		DisplayName:     account.MaskedDisplayName,
		DiscoveryMethod: account.DiscoveryMethod,
		CreatedUnixTime: account.CreatedUnixTime,
		UpdatedUnixTime: account.UpdatedUnixTime,
	}
}

func newPersonalFinanceSourceAccountDiscoveryResponse(discovery *importing.SourceAccountDiscovery) *personalFinanceSourceAccountDiscoveryResponse {
	if discovery == nil {
		return nil
	}

	return &personalFinanceSourceAccountDiscoveryResponse{
		SourceType:      discovery.SourceType,
		EvidenceKind:    discovery.EvidenceKind,
		DisplayName:     discovery.DisplayName,
		DiscoveryMethod: discovery.DiscoveryMethod,
	}
}

func personalFinanceFlowError(err error) *errs.Error {
	switch {
	case errors.Is(err, importing.ErrImportFormatInvalid),
		errors.Is(err, importing.ErrImportSourceAccountNotFound),
		errors.Is(err, importing.ErrImportSourceAccountUnavailable),
		errors.Is(err, importing.ErrImportSourceAccountConflict):
		return errs.ErrParameterInvalid
	default:
		return personalFinanceImportError(err)
	}
}
