package api

import (
	"errors"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

type personalFinanceEvidenceApplication interface {
	GetTransactionEvidence(c core.Context, uid int64, transactionId int64) (*importing.TransactionEvidenceResult, error)
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
