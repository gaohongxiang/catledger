package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

// PersonalFinanceReconciliationCaseService 是 case 查询处理器需要的最小服务契约。
type PersonalFinanceReconciliationCaseService interface {
	ListCases(c core.Context, request reconciliation.ListCasesRequest) (*reconciliation.CasePage, error)
	GetCase(c core.Context, uid int64, caseId int64) (*reconciliation.CaseDetail, error)
}

// PersonalFinanceReconciliationDecisionService 是人工决定和安全撤销处理器需要的最小服务契约。
type PersonalFinanceReconciliationDecisionService interface {
	DecideCase(c core.Context, request reconciliation.DecideCaseRequest, clientTimezone *time.Location) (*reconciliation.DecisionResult, error)
	GetUndoImpact(c core.Context, uid int64, caseId int64) (*reconciliation.UndoImpact, error)
	UndoCase(c core.Context, request reconciliation.UndoCaseRequest, clientTimezone *time.Location) (*reconciliation.DecisionResult, error)
}

// PersonalFinanceReconciliationApi 提供可独立注入和接线的对账 case/决定 API。
type PersonalFinanceReconciliationApi struct {
	cases              PersonalFinanceReconciliationCaseService
	decisions          PersonalFinanceReconciliationDecisionService
	ensureWriteAllowed func(c *core.WebContext) *errs.Error
}

// NewPersonalFinanceReconciliationApi 创建尚未注册路由的对账 API。
func NewPersonalFinanceReconciliationApi(cases PersonalFinanceReconciliationCaseService, decisions PersonalFinanceReconciliationDecisionService) (*PersonalFinanceReconciliationApi, error) {
	if cases == nil || decisions == nil {
		return nil, errors.New("personal finance reconciliation services are required")
	}
	if PersonalFinanceImports == nil {
		return nil, errors.New("personal finance import access controller is required")
	}
	return &PersonalFinanceReconciliationApi{
		cases:              cases,
		decisions:          decisions,
		ensureWriteAllowed: PersonalFinanceImports.ensurePersonalFinanceImportWriteAllowed,
	}, nil
}

type personalFinanceReconciliationCaseListRequest struct {
	Status reconciliation.CaseStatus
	Cursor *reconciliation.CaseCursor
	Limit  int
}

type personalFinanceReconciliationCaseRequest struct {
	CaseId int64
}

type personalFinanceReconciliationCaseReasonResponse struct {
	Code  string `json:"code"`
	Value int64  `json:"value"`
}

type personalFinanceReconciliationCaseResponse struct {
	Id                    int64                                              `json:"id,string"`
	Status                reconciliation.CaseStatus                          `json:"status"`
	Version               int64                                              `json:"version"`
	MemberCount           int64                                              `json:"memberCount"`
	SuggestedRelationType reconciliation.DecisionType                        `json:"suggestedRelationType"`
	CandidateScore        int64                                              `json:"candidateScore"`
	ReasonCodes           []*personalFinanceReconciliationCaseReasonResponse `json:"reasonCodes"`
	CurrentDecisionId     *int64                                             `json:"currentDecisionId,string,omitempty"`
	CreatedUnixTime       int64                                              `json:"createdUnixTime"`
	LastEvaluatedUnixTime int64                                              `json:"lastEvaluatedUnixTime"`
	UpdatedUnixTime       int64                                              `json:"updatedUnixTime"`
}

type personalFinanceReconciliationCaseCursorResponse struct {
	UpdatedUnixTime int64 `json:"updatedUnixTime"`
	CaseId          int64 `json:"caseId,string"`
}

type personalFinanceReconciliationCasePageResponse struct {
	Items      []*personalFinanceReconciliationCaseResponse     `json:"items"`
	NextCursor *personalFinanceReconciliationCaseCursorResponse `json:"nextCursor,omitempty"`
}

type personalFinanceReconciliationTransactionReferenceResponse struct {
	RelationRole               string `json:"relationRole"`
	CreationMethod             string `json:"creationMethod"`
	TransactionUpdatedUnixTime int64  `json:"transactionUpdatedUnixTime"`
}

type personalFinanceReconciliationEvidenceResponse struct {
	NormalizedUnixTime          *int64                                                       `json:"normalizedUnixTime,omitempty"`
	NormalizedTimezoneUtcOffset *int16                                                       `json:"normalizedTimezoneUtcOffset,omitempty"`
	NormalizedAmount            *int64                                                       `json:"normalizedAmount,string,omitempty"`
	Currency                    string                                                       `json:"currency"`
	NormalizedDirection         importing.NormalizedDirection                                `json:"normalizedDirection"`
	NormalizedTransactionType   importing.SourceTransactionType                              `json:"normalizedTransactionType"`
	EconomicEffect              importing.EconomicEffect                                     `json:"economicEffect"`
	ParseState                  importing.ParseState                                         `json:"parseState"`
	IdentityState               importing.IdentityState                                      `json:"identityState"`
	Disposition                 importing.ImportDisposition                                  `json:"disposition"`
	ProcessingState             importing.ProcessingState                                    `json:"processingState"`
	Transactions                []*personalFinanceReconciliationTransactionReferenceResponse `json:"transactions"`
}

type personalFinanceReconciliationMemberResponse struct {
	Order                int64                                            `json:"order"`
	Kind                 reconciliation.MemberKind                        `json:"kind"`
	Role                 reconciliation.MemberRole                        `json:"role"`
	SourceType           importing.SourceType                             `json:"sourceType"`
	MaskedSourceAccount  string                                           `json:"maskedSourceAccount"`
	Evidence             []*personalFinanceReconciliationEvidenceResponse `json:"evidence"`
	EvidenceLimitReached bool                                             `json:"evidenceLimitReached"`
}

type personalFinanceReconciliationCaseDetailResponse struct {
	*personalFinanceReconciliationCaseResponse
	Members                  []*personalFinanceReconciliationMemberResponse `json:"members"`
	RelationshipLimitReached bool                                           `json:"relationshipLimitReached"`
}

type personalFinanceReconciliationDecideRequest struct {
	CaseId                 int64                                      `json:"caseId,string"`
	ExpectedCaseVersion    int64                                      `json:"expectedCaseVersion"`
	DecisionType           reconciliation.DecisionType                `json:"decisionType"`
	IdempotencyKey         string                                     `json:"idempotencyKey"`
	FieldSelection         reconciliation.DecisionFieldSelection      `json:"fieldSelection"`
	PrimaryDraft           *personalFinanceReconciliationDraftRequest `json:"primaryDraft"`
	RefundOriginalDraft    *personalFinanceReconciliationDraftRequest `json:"refundOriginalDraft"`
	RefundTransactionDraft *personalFinanceReconciliationDraftRequest `json:"refundTransactionDraft"`
}

type personalFinanceReconciliationUndoRequest struct {
	CaseId              int64  `json:"caseId,string"`
	ExpectedCaseVersion int64  `json:"expectedCaseVersion"`
	IdempotencyKey      string `json:"idempotencyKey"`
}

type personalFinanceReconciliationDraftRequest struct {
	Type                 models.TransactionType `json:"type"`
	CategoryId           int64                  `json:"categoryId,string"`
	Time                 int64                  `json:"time"`
	UtcOffset            int16                  `json:"utcOffset"`
	SourceAccountId      int64                  `json:"sourceAccountId,string"`
	DestinationAccountId int64                  `json:"destinationAccountId,string"`
	SourceAmount         int64                  `json:"sourceAmount"`
	DestinationAmount    int64                  `json:"destinationAmount"`
	HideAmount           bool                   `json:"hideAmount"`
	TagIds               []string               `json:"tagIds"`
	Comment              string                 `json:"comment"`
}

type personalFinanceReconciliationDecisionResponse struct {
	Id                  int64                         `json:"id,string"`
	CaseId              int64                         `json:"caseId,string"`
	ExpectedCaseVersion int64                         `json:"expectedCaseVersion"`
	AppliedCaseVersion  int64                         `json:"appliedCaseVersion"`
	DecisionType        reconciliation.DecisionType   `json:"decisionType"`
	PreviousDecisionId  *int64                        `json:"previousDecisionId,string,omitempty"`
	Status              reconciliation.DecisionStatus `json:"status"`
	ReasonCodes         []string                      `json:"reasonCodes"`
	CreatedUnixTime     int64                         `json:"createdUnixTime"`
	StartedUnixTime     *int64                        `json:"startedUnixTime,omitempty"`
	CompletedUnixTime   *int64                        `json:"completedUnixTime,omitempty"`
	FailedUnixTime      *int64                        `json:"failedUnixTime,omitempty"`
	UpdatedUnixTime     int64                         `json:"updatedUnixTime"`
	Replayed            bool                          `json:"replayed"`
}

type personalFinanceReconciliationUndoImpactResponse struct {
	CaseId                      int64                             `json:"caseId,string"`
	DecisionId                  *int64                            `json:"decisionId,string,omitempty"`
	AttachedExistingCount       int64                             `json:"attachedExistingCount"`
	ReconciliationCreatedCount  int64                             `json:"reconciliationCreatedCount"`
	TransactionCount            int64                             `json:"transactionCount"`
	MissingTransactionCount     int64                             `json:"missingTransactionCount"`
	ModifiedTransactionCount    int64                             `json:"modifiedTransactionCount"`
	SharedTransactionCount      int64                             `json:"sharedTransactionCount"`
	BatchRelationCount          int64                             `json:"batchRelationCount"`
	IncompleteTransferPairCount int64                             `json:"incompleteTransferPairCount"`
	CanReopen                   bool                              `json:"canReopen"`
	CanAutomaticallyDelete      bool                              `json:"canAutomaticallyDelete"`
	ReasonCodes                 []reconciliation.UndoImpactReason `json:"reasonCodes"`
}

var personalFinanceReconciliationDecisionReasonCodes = map[string]struct{}{
	"decision_execution_not_implemented": {},
	"evidence_limit_reached":             {},
	"undo_requires_ledger_validation":    {},
}

var personalFinanceReconciliationUndoReasonCodes = map[reconciliation.UndoImpactReason]struct{}{
	reconciliation.UNDO_REASON_NO_CURRENT_DECISION:      {},
	reconciliation.UNDO_REASON_TRANSACTION_MISSING:      {},
	reconciliation.UNDO_REASON_TRANSACTION_MODIFIED:     {},
	reconciliation.UNDO_REASON_TRANSACTION_SHARED:       {},
	reconciliation.UNDO_REASON_BATCH_RELATION_PRESENT:   {},
	reconciliation.UNDO_REASON_TRANSFER_PAIR_INCOMPLETE: {},
	reconciliation.UNDO_REASON_EVIDENCE_LIMIT_REACHED:   {},
}

// ReconciliationCaseListHandler 返回当前用户的稳定状态分页。
func (a *PersonalFinanceReconciliationApi) ReconciliationCaseListHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceReconciliationCaseListRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.cases == nil {
		return nil, errs.ErrOperationFailed
	}
	page, err := a.cases.ListCases(c, reconciliation.ListCasesRequest{Uid: c.GetCurrentUid(), Status: request.Status, Cursor: request.Cursor, Limit: request.Limit})
	if err != nil {
		return nil, personalFinanceReconciliationCaseError(err)
	}
	response, err := newPersonalFinanceReconciliationCasePageResponse(page)
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// ReconciliationCaseGetHandler 返回当前用户的脱敏 case 详情。
func (a *PersonalFinanceReconciliationApi) ReconciliationCaseGetHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceReconciliationCaseRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.cases == nil {
		return nil, errs.ErrOperationFailed
	}
	detail, err := a.cases.GetCase(c, c.GetCurrentUid(), request.CaseId)
	if err != nil {
		return nil, personalFinanceReconciliationCaseError(err)
	}
	response, err := newPersonalFinanceReconciliationCaseDetailResponse(detail)
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// ReconciliationCaseDecideHandler 持久化当前用户的人工决定。
func (a *PersonalFinanceReconciliationApi) ReconciliationCaseDecideHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.reconciliationWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}
	request := new(personalFinanceReconciliationDecideRequest)
	if err := decodeStrictJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	primaryDraft, err := newPersonalFinanceReconciliationDraft(request.PrimaryDraft)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	refundOriginalDraft, err := newPersonalFinanceReconciliationDraft(request.RefundOriginalDraft)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	refundTransactionDraft, err := newPersonalFinanceReconciliationDraft(request.RefundTransactionDraft)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if err := validatePersonalFinanceReconciliationDecideRequest(request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	clientTimezone, err := c.GetClientTimezone()
	if err != nil {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}
	result, err := a.decisions.DecideCase(c, reconciliation.DecideCaseRequest{
		Uid: c.GetCurrentUid(), CaseId: request.CaseId, ExpectedCaseVersion: request.ExpectedCaseVersion,
		DecisionType: request.DecisionType, IdempotencyKey: request.IdempotencyKey, CreatedIp: c.ClientIP(),
		FieldSelection: request.FieldSelection, PrimaryDraft: primaryDraft, RefundOriginalDraft: refundOriginalDraft,
		RefundTransactionDraft: refundTransactionDraft,
	}, clientTimezone)
	if err != nil {
		log.Warnf(c, "[personal_finance_reconciliation.decide] decision failed for user \"uid:%d\" and case \"id:%d\"", c.GetCurrentUid(), request.CaseId)
		return nil, personalFinanceReconciliationDecisionError(err)
	}
	response, err := newPersonalFinanceReconciliationDecisionResponse(result)
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// ReconciliationCaseUndoImpactHandler 返回当前决定的聚合撤销影响。
func (a *PersonalFinanceReconciliationApi) ReconciliationCaseUndoImpactHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceReconciliationCaseRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.decisions == nil {
		return nil, errs.ErrOperationFailed
	}
	impact, err := a.decisions.GetUndoImpact(c, c.GetCurrentUid(), request.CaseId)
	if err != nil {
		return nil, personalFinanceReconciliationDecisionError(err)
	}
	response, err := newPersonalFinanceReconciliationUndoImpactResponse(impact)
	if err != nil {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// ReconciliationCaseUndoHandler 以追加式 reopen revision 安全撤销当前决定。
func (a *PersonalFinanceReconciliationApi) ReconciliationCaseUndoHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.reconciliationWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}
	request := new(personalFinanceReconciliationUndoRequest)
	if err := decodeStrictJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if request.CaseId < 1 || request.ExpectedCaseVersion < 1 || !isPersonalFinanceReconciliationIdempotencyKey(request.IdempotencyKey) {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(errors.New("reconciliation undo request is invalid"))
	}
	clientTimezone, err := c.GetClientTimezone()
	if err != nil {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}
	result, err := a.decisions.UndoCase(c, reconciliation.UndoCaseRequest{
		Uid: c.GetCurrentUid(), CaseId: request.CaseId, ExpectedCaseVersion: request.ExpectedCaseVersion, IdempotencyKey: request.IdempotencyKey,
	}, clientTimezone)
	if err != nil {
		log.Warnf(c, "[personal_finance_reconciliation.undo] undo failed for user \"uid:%d\" and case \"id:%d\"", c.GetCurrentUid(), request.CaseId)
		return nil, personalFinanceReconciliationDecisionError(err)
	}
	response, err := newPersonalFinanceReconciliationDecisionResponse(result)
	if err != nil || response.DecisionType != reconciliation.DECISION_TYPE_REOPEN {
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

func (a *PersonalFinanceReconciliationApi) reconciliationWriteAllowed(c *core.WebContext) *errs.Error {
	if a == nil || a.decisions == nil || a.ensureWriteAllowed == nil {
		return errs.ErrOperationFailed
	}
	return a.ensureWriteAllowed(c)
}

func parsePersonalFinanceReconciliationCaseListRequest(c *core.WebContext) (*personalFinanceReconciliationCaseListRequest, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return nil, errors.New("reconciliation case list request is required")
	}
	values := c.Request.URL.Query()
	if err := validateQueryKeys(values, "status", "cursor_updated_unix_time", "cursor_case_id", "limit"); err != nil {
		return nil, err
	}
	request := &personalFinanceReconciliationCaseListRequest{Status: reconciliation.CaseStatus(values.Get("status"))}
	if !isPersonalFinanceReconciliationCaseStatus(request.Status) {
		return nil, errors.New("reconciliation case status is invalid")
	}
	updatedText, caseText := values.Get("cursor_updated_unix_time"), values.Get("cursor_case_id")
	if (updatedText == "") != (caseText == "") {
		return nil, errors.New("reconciliation case cursor is incomplete")
	}
	if updatedText != "" {
		updated, err := parsePositiveInt64(updatedText)
		if err != nil {
			return nil, err
		}
		caseId, err := parsePositiveInt64(caseText)
		if err != nil {
			return nil, err
		}
		request.Cursor = &reconciliation.CaseCursor{UpdatedUnixTime: updated, CaseId: caseId}
	}
	if limitText := values.Get("limit"); limitText != "" {
		limit, err := strconv.Atoi(limitText)
		if err != nil || limit < 1 || limit > 100 {
			return nil, errors.New("reconciliation case limit is invalid")
		}
		request.Limit = limit
	}
	return request, nil
}

func parsePersonalFinanceReconciliationCaseRequest(c *core.WebContext) (*personalFinanceReconciliationCaseRequest, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return nil, errors.New("reconciliation case request is required")
	}
	values := c.Request.URL.Query()
	if err := validateQueryKeys(values, "case_id"); err != nil {
		return nil, err
	}
	caseId, err := parsePositiveInt64(values.Get("case_id"))
	if err != nil {
		return nil, err
	}
	return &personalFinanceReconciliationCaseRequest{CaseId: caseId}, nil
}

func validateQueryKeys(values url.Values, allowed ...string) error {
	allow := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allow[key] = struct{}{}
	}
	for key, entries := range values {
		if _, ok := allow[key]; !ok || len(entries) != 1 {
			return fmt.Errorf("query parameter %q is invalid", key)
		}
	}
	return nil
}

func parsePositiveInt64(value string) (int64, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		return 0, errors.New("positive identifier is required")
	}
	return parsed, nil
}

func decodeStrictJSON(c *core.WebContext, destination any) error {
	if c == nil || c.Request == nil || c.Request.Body == nil || destination == nil {
		return errors.New("reconciliation request is required")
	}
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("reconciliation request contains multiple JSON values")
		}
		return err
	}
	return nil
}

func newPersonalFinanceReconciliationDraft(request *personalFinanceReconciliationDraftRequest) (*importing.LedgerTransactionDraft, error) {
	if request == nil {
		return nil, nil
	}
	tagIds, err := utils.StringArrayToInt64Array(request.TagIds)
	if err != nil || len(tagIds) > models.MaximumTagsCountOfTransaction {
		return nil, errors.New("reconciliation draft tag ids are invalid")
	}
	sort.Slice(tagIds, func(i, j int) bool { return tagIds[i] < tagIds[j] })
	for index, tagId := range tagIds {
		if tagId < 1 || (index > 0 && tagIds[index-1] == tagId) {
			return nil, errors.New("reconciliation draft tag ids are invalid")
		}
	}
	if (request.Type != models.TRANSACTION_TYPE_INCOME && request.Type != models.TRANSACTION_TYPE_EXPENSE && request.Type != models.TRANSACTION_TYPE_TRANSFER) ||
		request.CategoryId < 1 || request.Time < 1 || request.UtcOffset < -720 || request.UtcOffset > 840 || request.SourceAccountId < 1 ||
		request.SourceAmount < 0 || request.SourceAmount > models.MaximumTransactionAmount || !utf8.ValidString(request.Comment) || utf8.RuneCountInString(request.Comment) > 255 {
		return nil, errors.New("reconciliation draft is invalid")
	}
	if request.Type == models.TRANSACTION_TYPE_TRANSFER {
		if request.DestinationAccountId < 1 || request.DestinationAccountId == request.SourceAccountId || request.DestinationAmount < 0 || request.DestinationAmount > models.MaximumTransactionAmount {
			return nil, errors.New("reconciliation transfer draft is invalid")
		}
	} else if request.DestinationAccountId != 0 || request.DestinationAmount != 0 {
		return nil, errors.New("reconciliation ordinary draft is invalid")
	}
	return &importing.LedgerTransactionDraft{
		Type: request.Type, CategoryId: request.CategoryId, UnixTime: request.Time, TimezoneUtcOffset: request.UtcOffset,
		SourceAccountId: request.SourceAccountId, DestinationAccountId: request.DestinationAccountId,
		SourceAmount: request.SourceAmount, DestinationAmount: request.DestinationAmount, HideAmount: request.HideAmount,
		TagIds: tagIds, Comment: request.Comment,
	}, nil
}

func validatePersonalFinanceReconciliationDecideRequest(request *personalFinanceReconciliationDecideRequest) error {
	if request == nil || request.CaseId < 1 || request.ExpectedCaseVersion < 1 || !isPersonalFinanceReconciliationDecisionType(request.DecisionType, false) ||
		!isPersonalFinanceReconciliationIdempotencyKey(request.IdempotencyKey) {
		return errors.New("reconciliation decision request is invalid")
	}
	for _, order := range []int64{request.FieldSelection.AccountAmountMemberOrder, request.FieldSelection.MerchantItemMemberOrder, request.FieldSelection.RefundOriginalMemberOrder} {
		if order < 0 || order > 2 {
			return errors.New("reconciliation field selection is invalid")
		}
	}
	switch request.DecisionType {
	case reconciliation.DECISION_TYPE_SAME_EVENT:
		if request.RefundOriginalDraft != nil || request.RefundTransactionDraft != nil {
			return errors.New("same-event decision drafts are invalid")
		}
	case reconciliation.DECISION_TYPE_INTERNAL_TRANSFER:
		if request.RefundOriginalDraft != nil || request.RefundTransactionDraft != nil ||
			(request.PrimaryDraft != nil && request.PrimaryDraft.Type != models.TRANSACTION_TYPE_TRANSFER) {
			return errors.New("internal-transfer decision drafts are invalid")
		}
	case reconciliation.DECISION_TYPE_REFUND_REVERSAL:
		if request.PrimaryDraft != nil || !isPersonalFinanceOrdinaryDraft(request.RefundOriginalDraft) || !isPersonalFinanceOrdinaryDraft(request.RefundTransactionDraft) {
			return errors.New("refund-reversal decision drafts are invalid")
		}
	case reconciliation.DECISION_TYPE_INDEPENDENT, reconciliation.DECISION_TYPE_DEFER:
		if request.PrimaryDraft != nil || request.RefundOriginalDraft != nil || request.RefundTransactionDraft != nil {
			return errors.New("non-ledger decision drafts are invalid")
		}
	}
	return nil
}

func isPersonalFinanceOrdinaryDraft(request *personalFinanceReconciliationDraftRequest) bool {
	return request == nil || request.Type == models.TRANSACTION_TYPE_INCOME || request.Type == models.TRANSACTION_TYPE_EXPENSE
}

func isPersonalFinanceReconciliationIdempotencyKey(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return false
		}
	}
	return true
}

func newPersonalFinanceReconciliationCasePageResponse(page *reconciliation.CasePage) (*personalFinanceReconciliationCasePageResponse, error) {
	if page == nil {
		return nil, errors.New("reconciliation case page is required")
	}
	response := &personalFinanceReconciliationCasePageResponse{Items: make([]*personalFinanceReconciliationCaseResponse, 0, len(page.Items))}
	for _, item := range page.Items {
		converted, err := newPersonalFinanceReconciliationCaseResponse(item)
		if err != nil {
			return nil, err
		}
		response.Items = append(response.Items, converted)
	}
	if page.NextCursor != nil {
		if page.NextCursor.UpdatedUnixTime < 1 || page.NextCursor.CaseId < 1 {
			return nil, errors.New("reconciliation case cursor is invalid")
		}
		response.NextCursor = &personalFinanceReconciliationCaseCursorResponse{UpdatedUnixTime: page.NextCursor.UpdatedUnixTime, CaseId: page.NextCursor.CaseId}
	}
	return response, nil
}

func newPersonalFinanceReconciliationCaseResponse(value *reconciliation.CaseSummary) (*personalFinanceReconciliationCaseResponse, error) {
	if value == nil || value.CaseId < 1 || value.Version < 1 || value.MemberCount != 2 || value.CreatedUnixTime < 1 || value.LastEvaluatedUnixTime < 1 || value.UpdatedUnixTime < 1 ||
		!isPersonalFinanceReconciliationCaseStatus(value.Status) || !isPersonalFinanceReconciliationDecisionType(value.SuggestedRelationType, false) ||
		(value.CurrentDecisionId != nil && *value.CurrentDecisionId < 1) {
		return nil, errors.New("reconciliation case response is invalid")
	}
	reasons := make([]*personalFinanceReconciliationCaseReasonResponse, 0, len(value.ReasonCodes))
	seen := make(map[string]struct{}, len(value.ReasonCodes))
	for _, reason := range value.ReasonCodes {
		if _, ok := personalFinanceCandidateReasonCodes[reason.Code]; !ok {
			return nil, errors.New("reconciliation case reason is not stable")
		}
		if _, duplicate := seen[reason.Code]; duplicate {
			return nil, errors.New("reconciliation case reason is duplicated")
		}
		seen[reason.Code] = struct{}{}
		reasons = append(reasons, &personalFinanceReconciliationCaseReasonResponse{Code: reason.Code, Value: reason.Value})
	}
	return &personalFinanceReconciliationCaseResponse{
		Id: value.CaseId, Status: value.Status, Version: value.Version, MemberCount: value.MemberCount,
		SuggestedRelationType: value.SuggestedRelationType, CandidateScore: value.CandidateScore, ReasonCodes: reasons,
		CurrentDecisionId: clonePersonalFinanceInt64(value.CurrentDecisionId), CreatedUnixTime: value.CreatedUnixTime,
		LastEvaluatedUnixTime: value.LastEvaluatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}, nil
}

func newPersonalFinanceReconciliationCaseDetailResponse(value *reconciliation.CaseDetail) (*personalFinanceReconciliationCaseDetailResponse, error) {
	if value == nil || len(value.Members) != 2 {
		return nil, errors.New("reconciliation case detail is invalid")
	}
	summary, err := newPersonalFinanceReconciliationCaseResponse(value.CaseSummary)
	if err != nil {
		return nil, err
	}
	response := &personalFinanceReconciliationCaseDetailResponse{personalFinanceReconciliationCaseResponse: summary, Members: make([]*personalFinanceReconciliationMemberResponse, 0, 2), RelationshipLimitReached: value.RelationshipLimitReached}
	for _, member := range value.Members {
		converted, err := newPersonalFinanceReconciliationMemberResponse(member)
		if err != nil {
			return nil, err
		}
		response.Members = append(response.Members, converted)
	}
	return response, nil
}

func newPersonalFinanceReconciliationMemberResponse(value *reconciliation.CaseMemberDetail) (*personalFinanceReconciliationMemberResponse, error) {
	if value == nil || value.MemberOrder < 1 || value.MemberOrder > 2 || !isPersonalFinanceMemberKind(value.MemberKind) || value.MemberRole != reconciliation.MemberRole("evidence") ||
		!isPersonalFinanceSourceType(value.SourceType) || !isSafePersonalFinanceMaskedSourceAccount(value.MaskedSourceAccount) {
		return nil, errors.New("reconciliation member response is invalid")
	}
	response := &personalFinanceReconciliationMemberResponse{Order: value.MemberOrder, Kind: value.MemberKind, Role: value.MemberRole, SourceType: value.SourceType,
		MaskedSourceAccount: value.MaskedSourceAccount, Evidence: make([]*personalFinanceReconciliationEvidenceResponse, 0, len(value.Evidence)), EvidenceLimitReached: value.EvidenceLimitReached}
	for _, evidence := range value.Evidence {
		converted, err := newPersonalFinanceReconciliationEvidenceResponse(evidence)
		if err != nil {
			return nil, err
		}
		response.Evidence = append(response.Evidence, converted)
	}
	return response, nil
}

func newPersonalFinanceReconciliationEvidenceResponse(value *reconciliation.CaseEvidenceSummary) (*personalFinanceReconciliationEvidenceResponse, error) {
	if value == nil || !isPersonalFinanceSourceType(value.SourceType) || !isPersonalFinanceCurrency(value.Currency) || !isPersonalFinanceDirection(value.NormalizedDirection) ||
		!isPersonalFinanceTransactionType(value.NormalizedTransactionType) || !isPersonalFinanceEconomicEffect(value.EconomicEffect) || !isPersonalFinanceParseState(value.ParseState) ||
		!isPersonalFinanceIdentityState(value.IdentityState) || !isPersonalFinanceDisposition(value.Disposition) || !isPersonalFinanceProcessingState(value.ProcessingState) ||
		(value.NormalizedUnixTime != nil && *value.NormalizedUnixTime < 1) || (value.NormalizedAmount != nil && *value.NormalizedAmount < 0) ||
		(value.NormalizedTimezoneUtcOffset != nil && (*value.NormalizedTimezoneUtcOffset < -720 || *value.NormalizedTimezoneUtcOffset > 840)) {
		return nil, errors.New("reconciliation evidence response is invalid")
	}
	response := &personalFinanceReconciliationEvidenceResponse{
		NormalizedUnixTime: clonePersonalFinanceInt64(value.NormalizedUnixTime), NormalizedTimezoneUtcOffset: clonePersonalFinanceInt16(value.NormalizedTimezoneUtcOffset),
		NormalizedAmount: clonePersonalFinanceInt64(value.NormalizedAmount), Currency: value.Currency, NormalizedDirection: value.NormalizedDirection,
		NormalizedTransactionType: value.NormalizedTransactionType, EconomicEffect: value.EconomicEffect, ParseState: value.ParseState,
		IdentityState: value.IdentityState, Disposition: value.Disposition, ProcessingState: value.ProcessingState,
		Transactions: make([]*personalFinanceReconciliationTransactionReferenceResponse, 0, len(value.Transactions)),
	}
	for _, transaction := range value.Transactions {
		if transaction == nil || transaction.TransactionUpdatedUnixTime < 1 || !isPersonalFinanceRelationRole(transaction.RelationRole) || !isPersonalFinanceCreationMethod(transaction.CreationMethod) {
			return nil, errors.New("reconciliation transaction reference is invalid")
		}
		response.Transactions = append(response.Transactions, &personalFinanceReconciliationTransactionReferenceResponse{
			RelationRole: transaction.RelationRole, CreationMethod: transaction.CreationMethod, TransactionUpdatedUnixTime: transaction.TransactionUpdatedUnixTime,
		})
	}
	return response, nil
}

func newPersonalFinanceReconciliationDecisionResponse(value *reconciliation.DecisionResult) (*personalFinanceReconciliationDecisionResponse, error) {
	if value == nil || value.DecisionId < 1 || value.CaseId < 1 || value.ExpectedCaseVersion < 1 || value.AppliedCaseVersion < 1 || value.CreatedUnixTime < 1 || value.UpdatedUnixTime < 1 ||
		!isPersonalFinanceReconciliationDecisionType(value.DecisionType, true) || !isPersonalFinanceDecisionStatus(value.Status) ||
		(value.PreviousDecisionId != nil && *value.PreviousDecisionId < 1) {
		return nil, errors.New("reconciliation decision response is invalid")
	}
	reasons := append([]string(nil), value.ReasonCodes...)
	seen := make(map[string]struct{}, len(reasons))
	for _, reason := range reasons {
		if _, ok := personalFinanceReconciliationDecisionReasonCodes[reason]; !ok {
			return nil, errors.New("reconciliation decision reason is not stable")
		}
		if _, duplicate := seen[reason]; duplicate {
			return nil, errors.New("reconciliation decision reason is duplicated")
		}
		seen[reason] = struct{}{}
	}
	if value.ErrorCode != "" {
		if _, ok := personalFinanceReconciliationDecisionReasonCodes[value.ErrorCode]; !ok {
			return nil, errors.New("reconciliation decision error code is not stable")
		}
	}
	return &personalFinanceReconciliationDecisionResponse{
		Id: value.DecisionId, CaseId: value.CaseId, ExpectedCaseVersion: value.ExpectedCaseVersion, AppliedCaseVersion: value.AppliedCaseVersion,
		DecisionType: value.DecisionType, PreviousDecisionId: clonePersonalFinanceInt64(value.PreviousDecisionId), Status: value.Status,
		ReasonCodes: reasons, CreatedUnixTime: value.CreatedUnixTime, StartedUnixTime: clonePersonalFinanceInt64(value.StartedUnixTime),
		CompletedUnixTime: clonePersonalFinanceInt64(value.CompletedUnixTime), FailedUnixTime: clonePersonalFinanceInt64(value.FailedUnixTime),
		UpdatedUnixTime: value.UpdatedUnixTime, Replayed: value.Replayed,
	}, nil
}

func newPersonalFinanceReconciliationUndoImpactResponse(value *reconciliation.UndoImpact) (*personalFinanceReconciliationUndoImpactResponse, error) {
	if value == nil || value.CaseId < 1 || value.DecisionId < 0 {
		return nil, errors.New("reconciliation undo impact is invalid")
	}
	for _, count := range []int64{value.AttachedExistingCount, value.ReconciliationCreatedCount, value.TransactionCount, value.MissingTransactionCount,
		value.ModifiedTransactionCount, value.SharedTransactionCount, value.BatchRelationCount, value.IncompleteTransferPairCount} {
		if count < 0 {
			return nil, errors.New("reconciliation undo impact count is invalid")
		}
	}
	reasons := append([]reconciliation.UndoImpactReason(nil), value.ReasonCodes...)
	seen := make(map[reconciliation.UndoImpactReason]struct{}, len(reasons))
	for _, reason := range reasons {
		if _, ok := personalFinanceReconciliationUndoReasonCodes[reason]; !ok {
			return nil, errors.New("reconciliation undo reason is not stable")
		}
		if _, duplicate := seen[reason]; duplicate {
			return nil, errors.New("reconciliation undo reason is duplicated")
		}
		seen[reason] = struct{}{}
	}
	var decisionId *int64
	if value.DecisionId > 0 {
		decisionId = &value.DecisionId
	}
	return &personalFinanceReconciliationUndoImpactResponse{
		CaseId: value.CaseId, DecisionId: decisionId, AttachedExistingCount: value.AttachedExistingCount,
		ReconciliationCreatedCount: value.ReconciliationCreatedCount, TransactionCount: value.TransactionCount,
		MissingTransactionCount: value.MissingTransactionCount, ModifiedTransactionCount: value.ModifiedTransactionCount,
		SharedTransactionCount: value.SharedTransactionCount, BatchRelationCount: value.BatchRelationCount,
		IncompleteTransferPairCount: value.IncompleteTransferPairCount, CanReopen: value.CanReopen,
		CanAutomaticallyDelete: value.CanAutomaticallyDelete, ReasonCodes: reasons,
	}, nil
}

func personalFinanceReconciliationCaseError(err error) *errs.Error {
	switch {
	case errors.Is(err, reconciliation.ErrCaseRequestInvalid), errors.Is(err, reconciliation.ErrCaseNotFound):
		return errs.ErrParameterInvalid
	default:
		return errs.ErrOperationFailed
	}
}

func personalFinanceReconciliationDecisionError(err error) *errs.Error {
	switch {
	case errors.Is(err, reconciliation.ErrDecisionRequestInvalid), errors.Is(err, reconciliation.ErrDecisionCaseNotFound), errors.Is(err, reconciliation.ErrDecisionLedgerRejected):
		return errs.ErrParameterInvalid
	case errors.Is(err, reconciliation.ErrDecisionIdempotencyConflict), errors.Is(err, reconciliation.ErrDecisionCaseVersionConflict), errors.Is(err, reconciliation.ErrDecisionNotAvailable):
		return errs.ErrRepeatedRequest
	case errors.Is(err, reconciliation.ErrDecisionAuthorizationFailed):
		return errs.ErrNotPermittedToPerformThisAction
	default:
		return errs.ErrOperationFailed
	}
}

func isPersonalFinanceReconciliationCaseStatus(value reconciliation.CaseStatus) bool {
	return value == reconciliation.CASE_STATUS_OPEN || value == reconciliation.CASE_STATUS_RESOLVED || value == reconciliation.CASE_STATUS_ACTION_REQUIRED || value == reconciliation.CASE_STATUS_DEFERRED
}

func isPersonalFinanceReconciliationDecisionType(value reconciliation.DecisionType, allowReopen bool) bool {
	return value == reconciliation.DECISION_TYPE_SAME_EVENT || value == reconciliation.DECISION_TYPE_INTERNAL_TRANSFER || value == reconciliation.DECISION_TYPE_REFUND_REVERSAL ||
		value == reconciliation.DECISION_TYPE_INDEPENDENT || value == reconciliation.DECISION_TYPE_DEFER || (allowReopen && value == reconciliation.DECISION_TYPE_REOPEN)
}

func isPersonalFinanceDecisionStatus(value reconciliation.DecisionStatus) bool {
	return value == reconciliation.DECISION_STATUS_APPLIED || value == reconciliation.DECISION_STATUS_ACTION_REQUIRED || value == reconciliation.DECISION_STATUS_DEFERRED || value == reconciliation.DECISION_STATUS_FAILED
}

func isPersonalFinanceMemberKind(value reconciliation.MemberKind) bool {
	return value == reconciliation.MEMBER_KIND_SOURCE_IDENTITY || value == reconciliation.MEMBER_KIND_RAW_ROW
}

func isPersonalFinanceSourceType(value importing.SourceType) bool {
	return value == importing.SOURCE_TYPE_ALIPAY || value == importing.SOURCE_TYPE_WECHAT || value == importing.SOURCE_TYPE_BANK
}

func isSafePersonalFinanceMaskedSourceAccount(value string) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 128 {
		return false
	}
	digitRun := 0
	for _, char := range value {
		if char >= '0' && char <= '9' {
			digitRun++
			if digitRun > 4 {
				return false
			}
		} else {
			digitRun = 0
		}
	}
	return true
}

func isPersonalFinanceCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}

func isPersonalFinanceDirection(value importing.NormalizedDirection) bool {
	return value == importing.NORMALIZED_DIRECTION_INCOME || value == importing.NORMALIZED_DIRECTION_EXPENSE || value == importing.NORMALIZED_DIRECTION_NEUTRAL || value == importing.NORMALIZED_DIRECTION_UNKNOWN
}

func isPersonalFinanceTransactionType(value importing.SourceTransactionType) bool {
	return value == importing.SOURCE_TRANSACTION_TYPE_PAYMENT || value == importing.SOURCE_TRANSACTION_TYPE_TRANSFER || value == importing.SOURCE_TRANSACTION_TYPE_TOP_UP ||
		value == importing.SOURCE_TRANSACTION_TYPE_WITHDRAWAL || value == importing.SOURCE_TRANSACTION_TYPE_FEE || value == importing.SOURCE_TRANSACTION_TYPE_OTHER || value == importing.SOURCE_TRANSACTION_TYPE_UNKNOWN
}

func isPersonalFinanceEconomicEffect(value importing.EconomicEffect) bool {
	return value == importing.ECONOMIC_EFFECT_NORMAL || value == importing.ECONOMIC_EFFECT_REFUND || value == importing.ECONOMIC_EFFECT_CLOSED || value == importing.ECONOMIC_EFFECT_FAILED || value == importing.ECONOMIC_EFFECT_UNKNOWN
}

func isPersonalFinanceParseState(value importing.ParseState) bool {
	return value == importing.PARSE_STATE_VALID || value == importing.PARSE_STATE_INVALID
}

func isPersonalFinanceIdentityState(value importing.IdentityState) bool {
	return value == importing.IDENTITY_STATE_NOT_EVALUATED || value == importing.IDENTITY_STATE_NEW || value == importing.IDENTITY_STATE_EXACT_DUPLICATE || value == importing.IDENTITY_STATE_IDENTITY_CONFLICT || value == importing.IDENTITY_STATE_BATCH_LOCAL
}

func isPersonalFinanceDisposition(value importing.ImportDisposition) bool {
	return value == importing.IMPORT_DISPOSITION_POSTABLE || value == importing.IMPORT_DISPOSITION_REVIEW_REQUIRED || value == importing.IMPORT_DISPOSITION_NON_POSTABLE
}

func isPersonalFinanceProcessingState(value importing.ProcessingState) bool {
	return value == importing.PROCESSING_STATE_PENDING || value == importing.PROCESSING_STATE_LINKED || value == importing.PROCESSING_STATE_IGNORED || value == importing.PROCESSING_STATE_FAILED
}

func isPersonalFinanceRelationRole(value string) bool {
	return value == string(reconciliation.TRANSACTION_RELATION_ROLE_PRIMARY) || value == string(reconciliation.TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART) ||
		value == string(reconciliation.TRANSACTION_RELATION_ROLE_REFUND_ORIGINAL) || value == string(reconciliation.TRANSACTION_RELATION_ROLE_REFUND_TRANSACTION)
}

func isPersonalFinanceCreationMethod(value string) bool {
	return value == string(reconciliation.TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING) || value == string(reconciliation.TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED)
}

func clonePersonalFinanceInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func clonePersonalFinanceInt16(value *int16) *int16 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
