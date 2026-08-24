package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/converters/alipay"
	"github.com/mayswind/ezbookkeeping/pkg/converters/ceb"
	"github.com/mayswind/ezbookkeeping/pkg/converters/genericbank"
	"github.com/mayswind/ezbookkeeping/pkg/converters/wechat"
	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/services"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

type personalFinanceFlowApplication interface {
	ReparseImportFile(c core.Context, request importing.ReparseImportFileRequest) (*importing.ReparseImportFileResult, error)
	ListSourceAccounts(c core.Context, uid int64) ([]*importing.SourceAccount, error)
	SaveSourceAccount(c core.Context, request importing.SourceAccountSaveRequest) (*importing.SourceAccount, error)
	ListBatchPaymentAccounts(c core.Context, uid int64, batchId int64) ([]*importing.PaymentAccountGroup, error)
	ConfirmBatchPaymentAccount(c core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error)
	ExcludePaymentAccount(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error)
}

type personalFinanceFlowService struct {
	reparse         *importing.ReparseService
	sourceAccounts  *importing.SourceAccountService
	paymentAccounts *importing.PaymentAccountService
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

func (s *personalFinanceFlowService) ListBatchPaymentAccounts(c core.Context, uid int64, batchId int64) ([]*importing.PaymentAccountGroup, error) {
	return s.paymentAccounts.ListBatchPaymentAccounts(c, uid, batchId)
}

func (s *personalFinanceFlowService) ConfirmBatchPaymentAccount(c core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error) {
	return s.paymentAccounts.ConfirmBatchPaymentAccount(c, request)
}

func (s *personalFinanceFlowService) ExcludePaymentAccount(c core.Context, request importing.PaymentAccountSkipRequest) (*importing.PaymentAccountGroup, error) {
	return s.paymentAccounts.ExcludePaymentAccount(c, request)
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
	paymentAccounts, err := importing.NewPaymentAccountService(repository, generateId)
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
			genericbank.ImportEvidenceParser,
			ceb.ImportEvidenceParser,
		},
		sourceAccounts,
		dedup,
	)
	if err != nil {
		return nil, err
	}

	return &personalFinanceFlowService{reparse: reparse, sourceAccounts: sourceAccounts, paymentAccounts: paymentAccounts}, nil
}

type personalFinanceReparseRequest struct {
	FileId            int64                             `json:"fileId,string" binding:"required,min=1"`
	SourceAccountId   int64                             `json:"sourceAccountId,string" binding:"omitempty,min=1"`
	ParserName        string                            `json:"parserName" binding:"omitempty,max=64"`
	Currency          string                            `json:"currency" binding:"required,len=3"`
	TimezoneUtcOffset int16                             `json:"timezoneUtcOffset" binding:"min=-720,max=840"`
	ReasonCode        string                            `json:"reasonCode" binding:"required,max=64"`
	GenericCSVMapping *personalFinanceGenericCSVMapping `json:"genericCsvMapping"`
}

type personalFinanceGenericCSVMapping struct {
	Encoding                importing.GenericCSVEncoding   `json:"encoding"`
	Delimiter               importing.GenericCSVDelimiter  `json:"delimiter"`
	HeaderRow               int                            `json:"headerRow"`
	TimeFormat              importing.GenericCSVTimeFormat `json:"timeFormat"`
	AmountMode              importing.GenericCSVAmountMode `json:"amountMode"`
	SignedPositiveDirection importing.NormalizedDirection  `json:"signedPositiveDirection"`
	TimeColumn              int                            `json:"timeColumn"`
	AmountColumn            int                            `json:"amountColumn"`
	DirectionColumn         int                            `json:"directionColumn"`
	IncomeColumn            int                            `json:"incomeColumn"`
	ExpenseColumn           int                            `json:"expenseColumn"`
	CurrencyColumn          int                            `json:"currencyColumn"`
	TransactionIdColumn     int                            `json:"transactionIdColumn"`
	OrderIdColumn           int                            `json:"orderIdColumn"`
	MerchantOrderIdColumn   int                            `json:"merchantOrderIdColumn"`
	CounterpartyColumn      int                            `json:"counterpartyColumn"`
	ItemColumn              int                            `json:"itemColumn"`
	PaymentMethodColumn     int                            `json:"paymentMethodColumn"`
	StatusColumn            int                            `json:"statusColumn"`
	TransactionTypeColumn   int                            `json:"transactionTypeColumn"`
	NoteColumn              int                            `json:"noteColumn"`
	IncomeValues            []string                       `json:"incomeValues"`
	ExpenseValues           []string                       `json:"expenseValues"`
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

type personalFinancePaymentAccountListRequest struct {
	BatchId int64 `form:"batch_id,string" binding:"required,min=1"`
}

type personalFinancePaymentAccountConfirmRequest struct {
	BatchId         int64 `json:"batchId,string" binding:"required,min=1"`
	RowId           int64 `json:"rowId,string" binding:"required,min=1"`
	LedgerAccountId int64 `json:"ledgerAccountId,string" binding:"required,min=1"`
}

type personalFinancePaymentAccountExcludeRequest struct {
	BatchId int64 `json:"batchId,string" binding:"required,min=1"`
	RowId   int64 `json:"rowId,string" binding:"required,min=1"`
}

type personalFinancePaymentAccountResponse struct {
	SourceType      importing.SourceType `json:"sourceType"`
	Currency        string               `json:"currency"`
	DisplayName     string               `json:"displayName"`
	RowCount        int64                `json:"rowCount"`
	PendingRowCount int64                `json:"pendingRowCount"`
	SampleRowId     int64                `json:"sampleRowId,string"`
	LedgerAccountId *int64               `json:"ledgerAccountId,string,omitempty"`
	Mapped          bool                 `json:"mapped"`
	Excluded        bool                 `json:"excluded"`
}

type personalFinancePaymentAccountListResponse struct {
	Items []*personalFinancePaymentAccountResponse `json:"items"`
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
		ParserName:      request.ParserName,
		ParseOptions: importing.ResolvedParseOptions{
			Currency:          request.Currency,
			TimezoneUtcOffset: request.TimezoneUtcOffset,
			GenericCSVMapping: newGenericCSVMapping(request.GenericCSVMapping),
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

	details := &importing.ImportBatchDetails{Batch: result.Batch}
	if result.Batch != nil {
		importService, importErr := a.serviceFactory()
		if importErr != nil {
			return nil, errs.ErrOperationFailed
		}
		loaded, loadErr := importService.GetImportBatch(c, uid, result.Batch.BatchId)
		if loadErr != nil {
			log.Errorf(c, "[personal_finance_flow.ImportBatchReparseHandler] reload batch failed for user \"uid:%d\"", uid)
			return nil, personalFinanceFlowError(loadErr)
		}
		details = loaded
	}

	return &personalFinanceReparseResponse{
		Batch:                 newPersonalFinanceImportBatchResponse(details),
		SourceAccount:         newPersonalFinanceSourceAccountResponse(result.SourceAccount),
		Discovery:             newPersonalFinanceSourceAccountDiscoveryResponse(result.Discovery),
		RequiresSourceAccount: result.Batch == nil,
		ParserName:            result.Descriptor.Name,
		SourceType:            result.Descriptor.SourceType,
		Format:                result.Descriptor.Format,
	}, nil
}

func newGenericCSVMapping(mapping *personalFinanceGenericCSVMapping) *importing.GenericCSVMapping {
	if mapping == nil {
		return nil
	}
	return &importing.GenericCSVMapping{
		Encoding: mapping.Encoding, Delimiter: mapping.Delimiter, HeaderRow: mapping.HeaderRow,
		TimeFormat: mapping.TimeFormat, AmountMode: mapping.AmountMode, SignedPositiveDirection: mapping.SignedPositiveDirection,
		TimeColumn: mapping.TimeColumn, AmountColumn: mapping.AmountColumn, DirectionColumn: mapping.DirectionColumn,
		IncomeColumn: mapping.IncomeColumn, ExpenseColumn: mapping.ExpenseColumn, CurrencyColumn: mapping.CurrencyColumn,
		TransactionIdColumn: mapping.TransactionIdColumn, OrderIdColumn: mapping.OrderIdColumn, MerchantOrderIdColumn: mapping.MerchantOrderIdColumn,
		CounterpartyColumn: mapping.CounterpartyColumn, ItemColumn: mapping.ItemColumn, PaymentMethodColumn: mapping.PaymentMethodColumn,
		StatusColumn: mapping.StatusColumn, TransactionTypeColumn: mapping.TransactionTypeColumn, NoteColumn: mapping.NoteColumn,
		IncomeValues: append([]string(nil), mapping.IncomeValues...), ExpenseValues: append([]string(nil), mapping.ExpenseValues...),
	}
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

// PaymentAccountListHandler 按整个批次汇总支付宝/微信实际付款方式，不受行分页影响。
func (a *PersonalFinanceImportsApi) PaymentAccountListHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinancePaymentAccountListRequest)
	if err := c.ShouldBindQuery(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	groups, err := service.ListBatchPaymentAccounts(c, c.GetCurrentUid(), request.BatchId)
	if err != nil {
		return nil, personalFinanceFlowError(err)
	}
	if a.accounts == nil {
		return nil, errs.ErrOperationFailed
	}
	items := make([]*personalFinancePaymentAccountResponse, 0, len(groups))
	for _, group := range groups {
		if group != nil && group.LedgerAccountId != nil {
			account, accountErr := a.accounts.GetAccountByAccountId(c, c.GetCurrentUid(), *group.LedgerAccountId)
			if accountErr != nil && !errors.Is(accountErr, errs.ErrAccountNotFound) {
				return nil, errs.ErrOperationFailed
			}
			if !isPersonalFinancePaymentLedgerAccountUsable(account, group.Currency) {
				group.LedgerAccountId = nil
				group.Mapped = false
			}
		}
		response := newPersonalFinancePaymentAccountResponse(group)
		if response == nil {
			return nil, errs.ErrOperationFailed
		}
		items = append(items, response)
	}
	return &personalFinancePaymentAccountListResponse{Items: items}, nil
}

// PaymentAccountConfirmHandler 确认一个付款方式映射，并统一应用到该批次同组待处理行。
func (a *PersonalFinanceImportsApi) PaymentAccountConfirmHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.ensurePersonalFinanceImportWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}

	request := new(personalFinancePaymentAccountConfirmRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a.accounts == nil {
		return nil, errs.ErrOperationFailed
	}

	uid := c.GetCurrentUid()
	account, err := a.accounts.GetAccountByAccountId(c, uid, request.LedgerAccountId)
	if err != nil && !errors.Is(err, errs.ErrAccountNotFound) {
		return nil, errs.ErrOperationFailed
	}
	if account == nil || !isPersonalFinancePaymentLedgerAccountUsable(account, account.Currency) {
		return nil, errs.ErrParameterInvalid
	}

	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	group, err := service.ConfirmBatchPaymentAccount(c, importing.PaymentAccountConfirmRequest{
		Uid: uid, BatchId: request.BatchId, RowId: request.RowId,
		LedgerAccountId: request.LedgerAccountId, LedgerAccountCurrency: account.Currency,
	})
	if err != nil {
		return nil, personalFinanceFlowError(err)
	}
	response := newPersonalFinancePaymentAccountResponse(group)
	if response == nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// PaymentAccountExcludeHandler 忽略一个付款账户，并记住该选择供后续账单复用。
func (a *PersonalFinanceImportsApi) PaymentAccountExcludeHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.ensurePersonalFinanceImportWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}

	request := new(personalFinancePaymentAccountExcludeRequest)
	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	service, err := a.newPersonalFinanceFlowService()
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	group, err := service.ExcludePaymentAccount(c, importing.PaymentAccountSkipRequest{
		Uid: c.GetCurrentUid(), BatchId: request.BatchId, RowId: request.RowId,
	})
	if err != nil {
		return nil, personalFinanceFlowError(err)
	}
	response := newPersonalFinancePaymentAccountResponse(group)
	if response == nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

func isPersonalFinancePaymentLedgerAccountUsable(account *models.Account, currency string) bool {
	return account != nil && !account.Deleted && !account.Hidden && account.Type == models.ACCOUNT_TYPE_SINGLE_ACCOUNT && account.Currency == currency
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

func newPersonalFinancePaymentAccountResponse(group *importing.PaymentAccountGroup) *personalFinancePaymentAccountResponse {
	if group == nil || group.SampleRowId < 1 || group.RowCount < 1 || group.PendingRowCount < 0 || group.PendingRowCount > group.RowCount ||
		group.DisplayName == "" || (group.LedgerAccountId != nil && *group.LedgerAccountId < 1) || group.Mapped != (group.LedgerAccountId != nil) {
		return nil
	}
	return &personalFinancePaymentAccountResponse{
		SourceType: group.SourceType, Currency: group.Currency, DisplayName: group.DisplayName,
		RowCount: group.RowCount, PendingRowCount: group.PendingRowCount, SampleRowId: group.SampleRowId,
		LedgerAccountId: group.LedgerAccountId, Mapped: group.Mapped, Excluded: group.Excluded,
	}
}

func personalFinanceFlowError(err error) *errs.Error {
	switch {
	case errors.Is(err, importing.ErrImportFormatInvalid),
		errors.Is(err, importing.ErrImportSourceAccountNotFound),
		errors.Is(err, importing.ErrImportSourceAccountUnavailable),
		errors.Is(err, importing.ErrImportSourceAccountConflict),
		errors.Is(err, importing.ErrPaymentAccountRequestInvalid),
		errors.Is(err, importing.ErrPaymentAccountBatchNotFound),
		errors.Is(err, importing.ErrPaymentAccountRowNotFound),
		errors.Is(err, importing.ErrPaymentAccountAliasUnavailable),
		errors.Is(err, importing.ErrPaymentAccountLedgerUnavailable):
		return errs.ErrParameterInvalid
	default:
		return personalFinanceImportError(err)
	}
}
