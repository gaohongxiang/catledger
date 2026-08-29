package api

import (
	"sort"
	"strconv"
	"strings"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

type personalFinanceReviewAccountReader interface {
	GetAccountByAccountId(c core.Context, uid int64, accountId int64) (*models.Account, error)
}

type personalFinanceReviewIssueMappingRepository interface {
	FindReviewIssueById(c core.Context, uid int64, issueId int64) (*organizer.ReviewIssue, error)
	ListReviewIssueMembers(c core.Context, uid int64, issueId int64) ([]*organizer.ReviewIssueMember, error)
	ListEvidenceForEvents(c core.Context, uid int64, eventIds []int64) ([]*organizer.EconomicEventEvidence, error)
}

type personalFinanceReviewEvidenceReader interface {
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*importing.ImportBatch, error)
	FindRawImportRowsByIds(c core.Context, uid int64, rowIds []int64) ([]*importing.RawImportRow, error)
}

type personalFinanceReviewSourceAccountMapper interface {
	FindSourceAccount(c core.Context, uid int64, sourceAccountId int64) (*importing.SourceAccount, error)
	SaveSourceAccount(c core.Context, request importing.SourceAccountSaveRequest) (*importing.SourceAccount, error)
}

type personalFinanceReviewPaymentAccountMapper interface {
	ConfirmBatchPaymentAccount(c core.Context, request importing.PaymentAccountConfirmRequest) (*importing.PaymentAccountGroup, error)
}

type personalFinanceReviewAccountMappingCoordinator struct {
	repository      personalFinanceReviewIssueMappingRepository
	evidence        personalFinanceReviewEvidenceReader
	accounts        personalFinanceReviewAccountReader
	sourceAccounts  personalFinanceReviewSourceAccountMapper
	paymentAccounts personalFinanceReviewPaymentAccountMapper
}

type personalFinanceReviewAccountMappingPlan struct {
	paymentAccounts []importing.PaymentAccountConfirmRequest
	sourceAccounts  []importing.SourceAccountSaveRequest
}

// prepare 把本轮“记账账户”决定翻译为用户自己的持久映射。
// 付款方式有稳定别名时优先记付款方式；否则只在来源账户能够安全代表该行时记来源账户。
func (m *personalFinanceReviewAccountMappingCoordinator) prepare(c core.Context, request organizer.ResolveReviewIssueRequest) (*personalFinanceReviewAccountMappingPlan, error) {
	if m == nil {
		return nil, nil
	}
	if request.Decision != organizer.REVIEW_ISSUE_DECISION_APPLY_FIELDS ||
		request.Correction.FieldMask&organizer.MANUAL_FIELD_LEDGER_ACCOUNT == 0 {
		return nil, nil
	}
	if m.repository == nil || m.evidence == nil || m.accounts == nil || m.sourceAccounts == nil || m.paymentAccounts == nil ||
		request.Correction.LedgerAccountId == nil || *request.Correction.LedgerAccountId < 1 {
		return nil, organizer.ErrReviewIssueDecisionInvalid
	}

	issue, err := m.repository.FindReviewIssueById(c, request.Uid, request.IssueId)
	if err != nil {
		return nil, err
	}
	if issue == nil || issue.UpdateId != request.UpdateId {
		return nil, organizer.ErrReviewIssueNotFound
	}
	if issue.IssueType != organizer.REVIEW_ISSUE_TYPE_ACCOUNT_MAPPING {
		return nil, nil
	}

	account, err := m.accounts.GetAccountByAccountId(c, request.Uid, *request.Correction.LedgerAccountId)
	if err != nil {
		return nil, organizer.ErrReviewIssueDecisionInvalid
	}
	if account == nil || account.Uid != request.Uid || account.Deleted || account.Hidden || account.Type != models.ACCOUNT_TYPE_SINGLE_ACCOUNT {
		return nil, organizer.ErrReviewIssueDecisionInvalid
	}

	members, err := m.repository.ListReviewIssueMembers(c, request.Uid, request.IssueId)
	if err != nil {
		return nil, err
	}
	eventIds := make([]int64, 0, len(members))
	for _, member := range members {
		if member != nil && member.Role == organizer.REVIEW_ISSUE_MEMBER_ROLE_SUBJECT && member.ObjectType == organizer.REVIEW_OBJECT_TYPE_EVENT {
			eventIds = append(eventIds, member.ObjectId)
		}
	}
	if len(eventIds) < 1 {
		return nil, organizer.ErrReviewIssueDecisionInvalid
	}

	links, err := m.repository.ListEvidenceForEvents(c, request.Uid, eventIds)
	if err != nil {
		return nil, err
	}
	rowIds := make([]int64, 0, len(links))
	for _, link := range links {
		if link != nil && link.EvidenceRole != organizer.EVIDENCE_ROLE_DISCARDED {
			rowIds = append(rowIds, link.RowId)
		}
	}
	rows, err := m.evidence.FindRawImportRowsByIds(c, request.Uid, rowIds)
	if err != nil {
		return nil, err
	}
	if len(rows) < 1 {
		return nil, organizer.ErrReviewIssueDecisionInvalid
	}

	plan := &personalFinanceReviewAccountMappingPlan{}
	paymentSeen := make(map[string]struct{})
	sourceSeen := make(map[int64]struct{})
	batches := make(map[int64]*importing.ImportBatch)
	for _, row := range rows {
		if row == nil || row.Uid != request.Uid || row.ParseState != importing.PARSE_STATE_VALID || row.Currency != account.Currency {
			return nil, organizer.ErrReviewIssueDecisionInvalid
		}
		batch := batches[row.BatchId]
		if batch == nil {
			batch, err = m.evidence.FindImportBatchById(c, request.Uid, row.BatchId)
			if err != nil {
				return nil, err
			}
			if batch == nil || batch.Uid != request.Uid {
				return nil, organizer.ErrReviewIssueDecisionInvalid
			}
			batches[row.BatchId] = batch
		}

		if alias, reusable := importing.BuildPaymentAccountAlias(row.RawPaymentMethod); reusable {
			key := strconv.FormatInt(row.BatchId, 10) + "\x00" + row.Currency + "\x00" + alias.Key
			if _, exists := paymentSeen[key]; !exists {
				paymentSeen[key] = struct{}{}
				plan.paymentAccounts = append(plan.paymentAccounts, importing.PaymentAccountConfirmRequest{
					Uid: request.Uid, BatchId: row.BatchId, RowId: row.RowId,
					LedgerAccountId: *request.Correction.LedgerAccountId, LedgerAccountCurrency: account.Currency,
				})
			}
			continue
		}

		if !reviewRowCanUseSourceAccount(batch.SourceTypeSnapshot, row.RawPaymentMethod) || batch.SourceAccountId == nil || *batch.SourceAccountId < 1 {
			continue
		}
		sourceAccountId := *batch.SourceAccountId
		if _, exists := sourceSeen[sourceAccountId]; exists {
			continue
		}
		sourceAccount, findErr := m.sourceAccounts.FindSourceAccount(c, request.Uid, sourceAccountId)
		if findErr != nil {
			return nil, findErr
		}
		if sourceAccount == nil || sourceAccount.SourceType != batch.SourceTypeSnapshot {
			return nil, organizer.ErrReviewIssueDecisionInvalid
		}
		sourceSeen[sourceAccountId] = struct{}{}
		plan.sourceAccounts = append(plan.sourceAccounts, importing.SourceAccountSaveRequest{
			Uid: request.Uid, SourceAccountId: sourceAccountId, SourceType: sourceAccount.SourceType,
			DisplayName: sourceAccount.MaskedDisplayName, LedgerAccountId: *request.Correction.LedgerAccountId,
			Status: sourceAccount.Status,
		})
	}

	sort.Slice(plan.paymentAccounts, func(i, j int) bool {
		if plan.paymentAccounts[i].BatchId == plan.paymentAccounts[j].BatchId {
			return plan.paymentAccounts[i].RowId < plan.paymentAccounts[j].RowId
		}
		return plan.paymentAccounts[i].BatchId < plan.paymentAccounts[j].BatchId
	})
	sort.Slice(plan.sourceAccounts, func(i, j int) bool {
		return plan.sourceAccounts[i].SourceAccountId < plan.sourceAccounts[j].SourceAccountId
	})
	return plan, nil
}

func (m *personalFinanceReviewAccountMappingCoordinator) apply(c core.Context, plan *personalFinanceReviewAccountMappingPlan) error {
	if m == nil || plan == nil {
		return nil
	}
	for _, request := range plan.paymentAccounts {
		if _, err := m.paymentAccounts.ConfirmBatchPaymentAccount(c, request); err != nil {
			return err
		}
	}
	for _, request := range plan.sourceAccounts {
		if _, err := m.sourceAccounts.SaveSourceAccount(c, request); err != nil {
			return err
		}
	}
	return nil
}

func reviewRowCanUseSourceAccount(sourceType importing.SourceType, rawPaymentMethod string) bool {
	if sourceType == importing.SOURCE_TYPE_BANK {
		return true
	}
	return (sourceType == importing.SOURCE_TYPE_ALIPAY || sourceType == importing.SOURCE_TYPE_WECHAT) && strings.TrimSpace(rawPaymentMethod) == ""
}
