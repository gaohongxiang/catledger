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
	if group.Excluded {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
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
	if group.Excluded || group.Currency != snapshot.Currency {
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
	if err := s.applyTaskExclusions(c, uid, members); err != nil {
		return nil, err
	}
	view := &TaskAccountsView{NeedsCreate: []*AccountGroupView{}, Reused: []*AccountGroupView{}, Excluded: []*AccountGroupView{}}
	merged := make(map[string]*AccountGroupView)
	order := make([]string, 0)
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
			item := &AccountGroupView{
				SourceType: group.SourceType, Currency: group.Currency, DisplayName: group.DisplayName,
				RowCount: group.RowCount, PendingRowCount: group.PendingRowCount, SampleRowId: group.SampleRowId,
				LedgerAccountId: group.LedgerAccountId, Mapped: group.Mapped, Excluded: group.Excluded,
				SkippedRowCount: group.SkippedRowCount, SuggestedType: suggestedAccountType(group.DisplayName),
			}
			key := accountGroupMergeKey(item)
			if existing := merged[key]; existing != nil {
				existing.RowCount += item.RowCount
				existing.PendingRowCount += item.PendingRowCount
				existing.SkippedRowCount += item.SkippedRowCount
				continue
			}
			merged[key] = item
			order = append(order, key)
		}
	}
	for _, key := range order {
		item := merged[key]
		if item.Excluded || (!item.Mapped && item.PendingRowCount == 0 && item.SkippedRowCount > 0) {
			view.Excluded = append(view.Excluded, item)
		} else if item.Mapped && item.LedgerAccountId != nil {
			view.Reused = append(view.Reused, item)
		} else if item.PendingRowCount > 0 {
			view.NeedsCreate = append(view.NeedsCreate, item)
		}
	}
	return view, nil
}

func (s *Service) applyTaskExclusions(c core.Context, uid int64, members []*TaskMember) error {
	if s.payments == nil {
		return nil
	}
	for _, member := range members {
		if member == nil {
			continue
		}
		if err := s.payments.ApplyPersistedExclusions(c, uid, member.BatchId); err != nil {
			return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
	}
	return nil
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

type ExcludeAccountRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	SampleRowId     int64
	IdempotencyKey  string
}

type SkipAccountRowsRequest struct {
	Uid             int64
	TaskId          int64
	ExpectedVersion int64
	SampleRowId     int64
	RowIds          []int64
	IdempotencyKey  string
}

func (s *Service) ExcludeTaskAccount(c core.Context, request ExcludeAccountRequest) (*TaskAccountsView, error) {
	return s.mutateTaskAccountSkip(c, request, true)
}

func (s *Service) RestoreTaskAccount(c core.Context, request ExcludeAccountRequest) (*TaskAccountsView, error) {
	return s.mutateTaskAccountSkip(c, request, false)
}

func (s *Service) mutateTaskAccountSkip(c core.Context, request ExcludeAccountRequest, exclude bool) (*TaskAccountsView, error) {
	if s == nil || s.payments == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 ||
		request.SampleRowId < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	group, _, err := s.findAccountGroup(c, request.Uid, request.TaskId, request.SampleRowId)
	if err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	action := "exclude_account"
	if !exclude {
		action = "restore_account"
	}
	for _, member := range members {
		if member == nil {
			continue
		}
		target, err := s.matchingAccountGroup(c, request.Uid, member.BatchId, group)
		if err != nil || target == nil {
			continue
		}
		skip := importing.PaymentAccountSkipRequest{Uid: request.Uid, BatchId: member.BatchId, RowId: target.SampleRowId}
		if exclude {
			_, err = s.payments.ExcludePaymentAccount(c, skip)
		} else {
			_, err = s.payments.RestorePaymentAccount(c, skip)
		}
		if err != nil {
			return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
		}
	}
	if err := s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_APPLY_ACCOUNTS, []string{
		action, strconv.FormatInt(request.SampleRowId, 10),
	}, nil); err != nil {
		return nil, err
	}
	if err := s.refreshAccountStatus(c, request.Uid, request.TaskId); err != nil {
		return nil, err
	}
	return s.collectAccounts(c, request.Uid, request.TaskId)
}

func (s *Service) SkipTaskAccountRows(c core.Context, request SkipAccountRowsRequest) (*TaskAccountsView, error) {
	return s.setTaskAccountRows(c, request, true)
}

func (s *Service) RestoreTaskAccountRows(c core.Context, request SkipAccountRowsRequest) (*TaskAccountsView, error) {
	return s.setTaskAccountRows(c, request, false)
}

func (s *Service) setTaskAccountRows(c core.Context, request SkipAccountRowsRequest, skip bool) (*TaskAccountsView, error) {
	if s == nil || s.payments == nil || request.Uid < 1 || request.TaskId < 1 || request.ExpectedVersion < 1 ||
		request.SampleRowId < 1 || len(request.RowIds) < 1 || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	task, err := s.requireTask(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, err
	}
	if task.Version != request.ExpectedVersion {
		return nil, serviceError(ErrServiceVersionConflict, SERVICE_ERROR_VERSION_CONFLICT)
	}
	group, _, err := s.findAccountGroup(c, request.Uid, request.TaskId, request.SampleRowId)
	if err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, request.Uid, request.TaskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	wanted := make(map[int64]struct{}, len(request.RowIds))
	for _, rowId := range request.RowIds {
		if rowId < 1 {
			return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		wanted[rowId] = struct{}{}
	}
	action := "skip_rows"
	if !skip {
		action = "restore_rows"
	}
	matched := 0
	for _, member := range members {
		if member == nil {
			continue
		}
		target, err := s.matchingAccountGroup(c, request.Uid, member.BatchId, group)
		if err != nil || target == nil {
			continue
		}
		rows, err := s.payments.ListPaymentAccountGroupRows(c, request.Uid, member.BatchId, target.SampleRowId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		batchRowIds := make([]int64, 0)
		for _, row := range rows {
			if row != nil {
				if _, ok := wanted[row.RowId]; ok {
					batchRowIds = append(batchRowIds, row.RowId)
				}
			}
		}
		if len(batchRowIds) == 0 {
			continue
		}
		skipReq := importing.PaymentAccountSkipRequest{Uid: request.Uid, BatchId: member.BatchId, RowId: target.SampleRowId, RowIds: batchRowIds}
		if skip {
			_, err = s.payments.SkipPaymentAccountRows(c, skipReq)
		} else {
			_, err = s.payments.RestorePaymentAccountRows(c, skipReq)
		}
		if err != nil {
			return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
		}
		matched += len(batchRowIds)
	}
	if matched < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if err := s.bumpTask(c, request.Uid, request.TaskId, request.ExpectedVersion, request.IdempotencyKey, ACTION_TYPE_APPLY_ACCOUNTS, []string{
		action, strconv.FormatInt(request.SampleRowId, 10),
	}, nil); err != nil {
		return nil, err
	}
	if err := s.refreshAccountStatus(c, request.Uid, request.TaskId); err != nil {
		return nil, err
	}
	return s.collectAccounts(c, request.Uid, request.TaskId)
}

func (s *Service) ListTaskAccountRows(c core.Context, uid int64, taskId int64, sampleRowId int64) ([]*AccountRowView, error) {
	if s == nil || s.payments == nil || uid < 1 || taskId < 1 || sampleRowId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	if _, err := s.requireTask(c, uid, taskId); err != nil {
		return nil, err
	}
	members, err := s.repository.ListMembers(c, uid, taskId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	if err := s.applyTaskExclusions(c, uid, members); err != nil {
		return nil, err
	}
	group, _, err := s.findAccountGroup(c, uid, taskId, sampleRowId)
	if err != nil {
		return nil, err
	}
	views := make([]*AccountRowView, 0)
	for _, member := range members {
		if member == nil {
			continue
		}
		target, err := s.matchingAccountGroup(c, uid, member.BatchId, group)
		if err != nil || target == nil {
			continue
		}
		rows, err := s.payments.ListPaymentAccountGroupRows(c, uid, member.BatchId, target.SampleRowId)
		if err != nil {
			return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
		}
		for _, row := range rows {
			if row == nil {
				continue
			}
			views = append(views, &AccountRowView{
				RowId: row.RowId, BatchId: row.BatchId, UnixTime: row.UnixTime, Amount: row.Amount,
				Currency: row.Currency, Direction: row.Direction, Label: row.Label, Skipped: row.Skipped,
			})
		}
	}
	return views, nil
}

func (s *Service) matchingAccountGroup(c core.Context, uid int64, batchId int64, wanted *importing.PaymentAccountGroup) (*importing.PaymentAccountGroup, error) {
	if wanted == nil {
		return nil, nil
	}
	groups, err := s.payments.ListBatchPaymentAccounts(c, uid, batchId)
	if err != nil {
		return nil, serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
	}
	for _, group := range groups {
		if group != nil && group.Currency == wanted.Currency && group.DisplayName == wanted.DisplayName {
			return group, nil
		}
	}
	return nil, nil
}

func accountGroupMergeKey(group *AccountGroupView) string {
	if group == nil {
		return ""
	}
	bucket := "pending"
	if group.Excluded || (!group.Mapped && group.PendingRowCount == 0 && group.SkippedRowCount > 0) {
		bucket = "excluded"
	} else if group.Mapped && group.LedgerAccountId != nil {
		bucket = "reused:" + strconv.FormatInt(*group.LedgerAccountId, 10)
	}
	return bucket + "\x00" + group.Currency + "\x00" + group.DisplayName
}
