package api

import (
	"errors"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

type personalFinancePostingApplication interface {
	PostImportBatch(c core.Context, request importing.PostImportBatchRequest, clientTimezone *time.Location) (*importing.ImportPostingResult, error)
	GetTransactionEvidence(c core.Context, uid int64, transactionId int64) (*importing.TransactionEvidenceResult, error)
}

type personalFinancePostingRequest struct {
	BatchId        int64                           `json:"batchId,string" binding:"required,min=1"`
	IdempotencyKey string                          `json:"idempotencyKey" binding:"required"`
	Commands       []personalFinancePostingCommand `json:"commands" binding:"required,min=1,dive"`
}

type personalFinancePostingCommand struct {
	RowIds []string                            `json:"rowIds" binding:"required,min=1"`
	Draft  *personalFinancePostingDraftRequest `json:"draft"`
}

type personalFinancePostingDraftRequest struct {
	Type                 models.TransactionType `json:"type" binding:"required"`
	CategoryId           int64                  `json:"categoryId,string" binding:"required,min=1"`
	Time                 int64                  `json:"time" binding:"required,min=1"`
	UtcOffset            int16                  `json:"utcOffset" binding:"min=-720,max=840"`
	SourceAccountId      int64                  `json:"sourceAccountId,string" binding:"required,min=1"`
	DestinationAccountId int64                  `json:"destinationAccountId,string" binding:"min=0"`
	SourceAmount         int64                  `json:"sourceAmount" binding:"validTransactionAmount"`
	DestinationAmount    int64                  `json:"destinationAmount" binding:"validTransactionAmount"`
	HideAmount           bool                   `json:"hideAmount"`
	TagIds               []string               `json:"tagIds"`
	Comment              string                 `json:"comment" binding:"max=255"`
}

type personalFinancePostingResponse struct {
	Id                      int64                         `json:"id,string"`
	BatchId                 int64                         `json:"batchId,string"`
	Status                  importing.ImportPostingStatus `json:"status"`
	SelectedRowCount        int64                         `json:"selectedRowCount"`
	CreatedTransactionCount int64                         `json:"createdTransactionCount"`
	ReusedTransactionCount  int64                         `json:"reusedTransactionCount"`
	CreatedUnixTime         int64                         `json:"createdUnixTime"`
	StartedUnixTime         *int64                        `json:"startedUnixTime,omitempty"`
	CompletedUnixTime       *int64                        `json:"completedUnixTime,omitempty"`
	FailedUnixTime          *int64                        `json:"failedUnixTime,omitempty"`
	Replayed                bool                          `json:"replayed"`
}

// ImportBatchPostHandler 原子创建或复用正式交易并写入证据关系。
func (a *PersonalFinanceImportsApi) ImportBatchPostHandler(c *core.WebContext) (any, *errs.Error) {
	if a.config == nil {
		return nil, errs.ErrDataImportNotAllowed
	}

	config := a.config.GetCurrentConfig()

	if config == nil || !config.EnableDataImport {
		return nil, errs.ErrDataImportNotAllowed
	}

	request := new(personalFinancePostingRequest)

	if err := c.ShouldBindJSON(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	clientTimezone, err := c.GetClientTimezone()

	if err != nil {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}

	commands := make([]importing.PostingIdentityCommand, len(request.Commands))

	for index, command := range request.Commands {
		rowIds, parseErr := utils.StringArrayToInt64Array(command.RowIds)

		if parseErr != nil {
			return nil, errs.ErrParameterInvalid
		}

		commands[index].RowIds = rowIds

		if command.Draft == nil {
			continue
		}

		tagIds, parseErr := utils.StringArrayToInt64Array(command.Draft.TagIds)

		if parseErr != nil {
			return nil, errs.ErrTransactionTagIdInvalid
		}

		commands[index].Draft = &importing.LedgerTransactionDraft{
			Type:                 command.Draft.Type,
			CategoryId:           command.Draft.CategoryId,
			UnixTime:             command.Draft.Time,
			TimezoneUtcOffset:    command.Draft.UtcOffset,
			SourceAccountId:      command.Draft.SourceAccountId,
			DestinationAccountId: command.Draft.DestinationAccountId,
			SourceAmount:         command.Draft.SourceAmount,
			DestinationAmount:    command.Draft.DestinationAmount,
			HideAmount:           command.Draft.HideAmount,
			TagIds:               tagIds,
			Comment:              command.Draft.Comment,
		}
	}

	if a.postingServiceFactory == nil {
		return nil, errs.ErrOperationFailed
	}

	service, err := a.postingServiceFactory()

	if err != nil {
		return nil, errs.ErrOperationFailed
	}

	uid := c.GetCurrentUid()
	result, err := service.PostImportBatch(c, importing.PostImportBatchRequest{
		Uid:            uid,
		BatchId:        request.BatchId,
		IdempotencyKey: request.IdempotencyKey,
		CreatedIp:      c.ClientIP(),
		Commands:       commands,
	}, clientTimezone)

	if err != nil {
		log.Warnf(c, "[personal_finance_posting.ImportBatchPostHandler] posting failed for user \"uid:%d\" and batch \"id:%d\"", uid, request.BatchId)
		return nil, personalFinancePostingError(err)
	}

	if result == nil || result.Posting == nil {
		return nil, errs.ErrOperationFailed
	}

	posting := result.Posting
	return &personalFinancePostingResponse{
		Id:                      posting.PostingId,
		BatchId:                 posting.BatchId,
		Status:                  posting.Status,
		SelectedRowCount:        posting.SelectedRowCount,
		CreatedTransactionCount: posting.CreatedTransactionCount,
		ReusedTransactionCount:  posting.ReusedTransactionCount,
		CreatedUnixTime:         posting.CreatedUnixTime,
		StartedUnixTime:         posting.StartedUnixTime,
		CompletedUnixTime:       posting.CompletedUnixTime,
		FailedUnixTime:          posting.FailedUnixTime,
		Replayed:                result.Replayed,
	}, nil
}

func personalFinancePostingError(err error) *errs.Error {
	switch {
	case errors.Is(err, importing.ErrImportPostingRequestInvalid),
		errors.Is(err, importing.ErrImportPostingBatchNotFound),
		errors.Is(err, importing.ErrImportPostingEvidenceInvalid),
		errors.Is(err, importing.ErrImportPostingLedgerRejected):
		return errs.ErrParameterInvalid
	case errors.Is(err, importing.ErrImportPostingIdempotencyConflict),
		errors.Is(err, importing.ErrImportPostingPreviouslyFailed),
		errors.Is(err, importing.ErrImportPostingNotAvailable):
		return errs.ErrRepeatedRequest
	case errors.Is(err, importing.ErrImportPostingAuthorizationFailed):
		return errs.ErrNotPermittedToPerformThisAction
	case errors.Is(err, importing.ErrImportIdentifierUnavailable):
		return errs.ErrSystemIsBusy
	default:
		return errs.ErrOperationFailed
	}
}
