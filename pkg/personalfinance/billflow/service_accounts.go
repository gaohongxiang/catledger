package billflow

import (
	"strconv"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

type CreateAccountRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	SampleRowId     int64
	Name            string
	Category        models.AccountCategory
	Currency        string
	IdempotencyKey  string
}

type OverrideAccountRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	SampleRowId     int64
	LedgerAccountId int64
	IdempotencyKey  string
}

func (s *Service) GetTaskAccounts(c core.Context, uid int64, taskId int64) (*TaskAccountsView, error) {
	if s == nil || s.payments == nil || uid < 1 || taskId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	return s.collectAccounts(c, uid, taskId)
}

func (s *Service) CreateTaskAccount(c core.Context, request CreateAccountRequest) (*TaskAccountsView, error) {
	if s == nil || s.accounts == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 ||
		request.SampleRowId < 1 || strings.TrimSpace(request.Name) == "" || request.Currency == "" || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if request.Category != models.ACCOUNT_CATEGORY_CASH && request.Category != models.ACCOUNT_CATEGORY_VIRTUAL &&
		request.Category != models.ACCOUNT_CATEGORY_CREDIT_CARD && request.Category != models.ACCOUNT_CATEGORY_CHECKING_ACCOUNT {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	group, batchId, err := s.findAccountGroup(c, request.Uid, request.TaskId, request.SampleRowId)
	if err != nil {
		return nil, err
	}
	accountId, err := s.accounts.CreateAccount(c, request.Uid, request.Name, request.Category, request.Currency)
	if err != nil || accountId < 1 {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	if _, err := s.payments.ConfirmBatchPaymentAccount(c, importing.PaymentAccountConfirmRequest{
		Uid: request.Uid, BatchId: batchId, RowId: request.SampleRowId, LedgerAccountId: accountId, LedgerAccountCurrency: request.Currency,
	}); err != nil {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	_ = group
	if err := s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_APPLY_ACCOUNTS, []string{
		"create_account", strconv.FormatInt(request.SampleRowId, 10), strconv.FormatInt(accountId, 10),
	}, func(next *Task) {
		next.CreatedAccountCount++
		next.ConfirmPolicy = CONFIRM_POLICY_CONFIRM_THEN_POST
	}); err != nil {
		return nil, err
	}
	if err := s.refreshAccountStatus(c, request.Uid, request.TaskId); err != nil {
		return nil, err
	}
	return s.collectAccounts(c, request.Uid, request.TaskId)
}

func (s *Service) OverrideTaskAccount(c core.Context, request OverrideAccountRequest) (*TaskAccountsView, error) {
	if s == nil || s.accounts == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 ||
		request.SampleRowId < 1 || request.LedgerAccountId < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	snapshot, err := s.accounts.LoadAccount(c, request.Uid, request.LedgerAccountId)
	if err != nil || snapshot == nil || snapshot.Deleted || snapshot.Hidden {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	group, batchId, err := s.findAccountGroup(c, request.Uid, request.TaskId, request.SampleRowId)
	if err != nil {
		return nil, err
	}
	if group.Currency != snapshot.Currency {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	if _, err := s.payments.ConfirmBatchPaymentAccount(c, importing.PaymentAccountConfirmRequest{
		Uid: request.Uid, BatchId: batchId, RowId: request.SampleRowId, LedgerAccountId: request.LedgerAccountId, LedgerAccountCurrency: group.Currency,
	}); err != nil {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	if err := s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_APPLY_ACCOUNTS, []string{
		"override_account", strconv.FormatInt(request.SampleRowId, 10), strconv.FormatInt(request.LedgerAccountId, 10),
	}, func(next *Task) {
		next.ReusedMappingCount++
	}); err != nil {
		return nil, err
	}
	if err := s.refreshAccountStatus(c, request.Uid, request.TaskId); err != nil {
		return nil, err
	}
	return s.collectAccounts(c, request.Uid, request.TaskId)
}

func (s *Service) collectAccounts(c core.Context, uid int64, taskId int64) (*TaskAccountsView, error) {
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	view := &TaskAccountsView{NeedsCreate: []*AccountGroupView{}, Reused: []*AccountGroupView{}}
	seen := make(map[string]struct{})
	for _, member := range members {
		if member == nil {
			continue
		}
		groups, err := s.payments.ListBatchPaymentAccounts(c, uid, member.BatchId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, group := range groups {
			if group == nil {
				continue
			}
			key := string(group.SourceType) + "\x00" + group.Currency + "\x00" + group.DisplayName
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			item := &AccountGroupView{
				SourceType: group.SourceType, Currency: group.Currency, DisplayName: group.DisplayName,
				RowCount: group.RowCount, PendingRowCount: group.PendingRowCount, SampleRowId: group.SampleRowId,
				LedgerAccountId: group.LedgerAccountId, Mapped: group.Mapped, SuggestedType: suggestedAccountType(group.DisplayName),
			}
			if group.Mapped && group.LedgerAccountId != nil {
				view.Reused = append(view.Reused, item)
			} else {
				view.NeedsCreate = append(view.NeedsCreate, item)
			}
		}
	}
	return view, nil
}

func (s *Service) refreshAccountStatus(c core.Context, uid int64, taskId int64) error {
	task, err := s.requireTask(c, uid, taskId)
	if err != nil {
		return err
	}
	accounts, err := s.collectAccounts(c, uid, taskId)
	if err != nil {
		return err
	}
	reused := int64(len(accounts.Reused))
	needs := len(accounts.NeedsCreate)
	next := cloneTask(task)
	next.ReusedMappingCount = reused
	if needs > 0 {
		next.Status = TASK_STATUS_ACCOUNTS_PENDING
	} else if task.Status == TASK_STATUS_ACCOUNTS_PENDING || task.Status == TASK_STATUS_RECEIVING {
		next.Status = TASK_STATUS_RECEIVING
	}
	if next.Status == task.Status && next.ReusedMappingCount == task.ReusedMappingCount {
		return nil
	}
	next.Version = task.Version + 1
	next.UpdatedUnixTime = s.now().Unix()
	return s.repository.DoTransaction(c, uid, func(tx *RepositoryTransaction) error {
		updated, err := tx.UpdateTaskCAS(task.Version, next)
		if err != nil || !updated {
			return serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
		}
		return nil
	})
}

func (s *Service) findAccountGroup(c core.Context, uid int64, taskId int64, sampleRowId int64) (*importing.PaymentAccountGroup, int64, error) {
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, 0, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, member := range members {
		if member == nil {
			continue
		}
		groups, err := s.payments.ListBatchPaymentAccounts(c, uid, member.BatchId)
		if err != nil {
			return nil, 0, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, group := range groups {
			if group != nil && group.SampleRowId == sampleRowId {
				return group, member.BatchId, nil
			}
		}
	}
	return nil, 0, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
}
