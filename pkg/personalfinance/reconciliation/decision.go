package reconciliation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

const (
	minimumDecisionIdempotencyKeyBytes = 8
	maximumDecisionIdempotencyKeyBytes = 128
	maximumDecisionMemberRows          = 500
	maximumDecisionEvidenceLinks       = 2000
	maximumDecisionLedgerEvents        = 8
)

var (
	ErrDecisionRequestInvalid         = errors.New("personal finance reconciliation decision request is invalid")
	ErrDecisionCaseNotFound           = errors.New("personal finance reconciliation decision case is not found")
	ErrDecisionIdempotencyConflict    = errors.New("personal finance reconciliation decision idempotency conflict")
	ErrDecisionCaseVersionConflict    = errors.New("personal finance reconciliation decision case version conflict")
	ErrDecisionNotAvailable           = errors.New("personal finance reconciliation decision is not available")
	ErrDecisionAuthorizationFailed    = errors.New("personal finance reconciliation decision authorization failed")
	ErrDecisionLedgerRejected         = errors.New("personal finance reconciliation ledger operation was rejected")
	ErrDecisionPersistenceUnavailable = errors.New("personal finance reconciliation decision persistence is unavailable")
)

// DecisionFieldSelection 记录用户从两个成员中选择字段来源的稳定序号。
// 0 表示由用户提供或无需指定，1/2 表示对应 member_order。
type DecisionFieldSelection struct {
	AccountAmountMemberOrder  int64 `json:"accountAmountMemberOrder"`
	MerchantItemMemberOrder   int64 `json:"merchantItemMemberOrder"`
	RefundOriginalMemberOrder int64 `json:"refundOriginalMemberOrder"`
}

// DecideCaseRequest 是持久幂等人工决定命令；草稿只在没有完整既有事件时使用。
type DecideCaseRequest struct {
	Uid                    int64
	CaseId                 int64
	ExpectedCaseVersion    int64
	DecisionType           DecisionType
	IdempotencyKey         string
	CreatedIp              string
	FieldSelection         DecisionFieldSelection
	PrimaryDraft           *importing.LedgerTransactionDraft
	RefundOriginalDraft    *importing.LedgerTransactionDraft
	RefundTransactionDraft *importing.LedgerTransactionDraft
}

// UndoCaseRequest 通过新 reopen revision 撤销当前活动决定。
type UndoCaseRequest struct {
	Uid                 int64
	CaseId              int64
	ExpectedCaseVersion int64
	IdempotencyKey      string
}

// DecisionResult 是不含幂等摘要、请求摘要和持久化 JSON 的稳定结果。
type DecisionResult struct {
	DecisionId          int64
	CaseId              int64
	ExpectedCaseVersion int64
	AppliedCaseVersion  int64
	DecisionType        DecisionType
	PreviousDecisionId  *int64
	Status              DecisionStatus
	ReasonCodes         []string
	ErrorCode           string
	CreatedUnixTime     int64
	StartedUnixTime     *int64
	CompletedUnixTime   *int64
	FailedUnixTime      *int64
	UpdatedUnixTime     int64
	Replayed            bool
}

// UndoImpactReason 是安全撤销的稳定、脱敏原因码。
type UndoImpactReason string

const (
	UNDO_REASON_NO_CURRENT_DECISION      UndoImpactReason = "no_current_decision"
	UNDO_REASON_TRANSACTION_MISSING      UndoImpactReason = "transaction_missing_or_deleted"
	UNDO_REASON_TRANSACTION_MODIFIED     UndoImpactReason = "transaction_modified"
	UNDO_REASON_TRANSACTION_SHARED       UndoImpactReason = "transaction_shared"
	UNDO_REASON_BATCH_RELATION_PRESENT   UndoImpactReason = "batch_relation_present"
	UNDO_REASON_LOAN_RELATION_PRESENT    UndoImpactReason = "loan_relation_present"
	UNDO_REASON_TRANSFER_PAIR_INCOMPLETE UndoImpactReason = "transfer_pair_incomplete"
	UNDO_REASON_EVIDENCE_LIMIT_REACHED   UndoImpactReason = "evidence_limit_reached"
)

// UndoImpact 只读描述当前决定的账本影响，不暴露交易明细或来源标识。
type UndoImpact struct {
	CaseId                      int64
	DecisionId                  int64
	AttachedExistingCount       int64
	ReconciliationCreatedCount  int64
	TransactionCount            int64
	MissingTransactionCount     int64
	ModifiedTransactionCount    int64
	SharedTransactionCount      int64
	BatchRelationCount          int64
	LoanRelationCount           int64
	IncompleteTransferPairCount int64
	CanReopen                   bool
	CanAutomaticallyDelete      bool
	ReasonCodes                 []UndoImpactReason
}

// DecisionLedger 在调用方隐私事务中创建或条件软删核心账本事件。
type DecisionLedger interface {
	CreateTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, draft *models.Transaction, tagIds []int64) (*models.Transaction, *models.Transaction, error)
	DeleteTransactionInSession(c core.Context, database *datastore.Database, sess *xorm.Session, uid int64, transactionId int64, expectedUpdatedUnixTime int64, relatedTransactionId int64, expectedRelatedUpdatedUnixTime int64, deletedUnixTime int64) (*models.Transaction, *models.Transaction, error)
}

type decisionDraft struct {
	transaction *models.Transaction
	tagIds      []int64
}

type decisionExecution struct {
	uid                    int64
	caseId                 int64
	expectedCaseVersion    int64
	decisionId             int64
	decisionType           DecisionType
	previousDecisionId     *int64
	fieldSelection         DecisionFieldSelection
	primaryDraft           *decisionDraft
	refundOriginalDraft    *decisionDraft
	refundTransactionDraft *decisionDraft
	undo                   bool
}

// DecisionService 编排持久幂等、预授权和单库原子账本决定。
type DecisionService struct {
	repository *decisionRepository
	authorizer importing.PostingAuthorization
	ledger     DecisionLedger
	generateId func() int64
	now        func() time.Time
}

// NewDecisionService 创建人工决定与安全 reopen 服务。
func NewDecisionService(store *datastore.DataStore, authorizer importing.PostingAuthorization, ledger DecisionLedger, generateId func() int64) (*DecisionService, error) {
	repository, err := newDecisionRepository(store)
	if err != nil {
		return nil, err
	}
	if authorizer == nil || ledger == nil || generateId == nil {
		return nil, ErrDecisionRequestInvalid
	}
	return &DecisionService{repository: repository, authorizer: authorizer, ledger: ledger, generateId: generateId, now: time.Now}, nil
}

// DecideCase 持久化并原子执行一个非 reopen 人工决定。
func (s *DecisionService) DecideCase(c core.Context, request DecideCaseRequest, clientTimezone *time.Location) (*DecisionResult, error) {
	execution, keyDigest, requestDigest, fieldSelectionJSON, drafts, err := normalizeDecideCaseRequest(request)
	if err != nil || clientTimezone == nil {
		return nil, ErrDecisionRequestInvalid
	}
	return s.submitDecision(c, execution, keyDigest, requestDigest, fieldSelectionJSON, drafts, clientTimezone)
}

// GetUndoImpact 返回当前活动决定的只读影响。
func (s *DecisionService) GetUndoImpact(c core.Context, uid int64, caseId int64) (*UndoImpact, error) {
	if s == nil || s.repository == nil || uid < 1 || caseId < 1 {
		return nil, ErrDecisionRequestInvalid
	}
	impact, err := s.repository.getUndoImpact(c, uid, caseId)
	if errors.Is(err, errDecisionCaseNotFound) {
		return nil, ErrDecisionCaseNotFound
	}
	if err != nil {
		return nil, ErrDecisionPersistenceUnavailable
	}
	return impact, nil
}

// UndoCase 以新 reopen revision 留痕并在满足窄条件时撤销账本效果。
func (s *DecisionService) UndoCase(c core.Context, request UndoCaseRequest, clientTimezone *time.Location) (*DecisionResult, error) {
	execution, keyDigest, requestDigest, err := normalizeUndoCaseRequest(request)
	if err != nil || clientTimezone == nil {
		return nil, ErrDecisionRequestInvalid
	}
	return s.submitDecision(c, execution, keyDigest, requestDigest, "{}", nil, clientTimezone)
}

func (s *DecisionService) submitDecision(c core.Context, execution *decisionExecution, keyDigest string, requestDigest string, fieldSelectionJSON string, drafts []*models.Transaction, clientTimezone *time.Location) (*DecisionResult, error) {
	if s == nil || s.repository == nil || s.authorizer == nil || s.ledger == nil || s.generateId == nil || s.now == nil {
		return nil, ErrDecisionRequestInvalid
	}
	prepared, err := s.repository.prepareCase(c, execution.uid, execution.caseId)
	if errors.Is(err, errDecisionCaseNotFound) {
		return nil, ErrDecisionCaseNotFound
	}
	if err != nil {
		return nil, ErrDecisionPersistenceUnavailable
	}
	execution.previousDecisionId = cloneInt64(prepared.caseRecord.CurrentDecisionId)

	decisionId := s.generateId()
	now := s.now().Unix()
	if decisionId < 1 || now < 1 {
		return nil, ErrDecisionPersistenceUnavailable
	}
	candidate := &Decision{
		Uid: execution.uid, CaseId: execution.caseId, ExpectedCaseVersion: execution.expectedCaseVersion,
		DecisionType: execution.decisionType, PreviousDecisionId: cloneInt64(execution.previousDecisionId),
		IdempotencyKeyDigest: keyDigest, IdempotencyKeyVersion: IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest: requestDigest, RequestDigestVersion: DECISION_REQUEST_VERSION_V1,
		Status: DECISION_STATUS_READY, FieldSelectionJson: fieldSelectionJSON, ReasonCodesJson: "[]",
		CreatedUnixTime: now, UpdatedUnixTime: now, DecisionId: decisionId,
	}
	persisted, created, err := s.repository.createOrFindDecision(c, candidate)
	if err != nil {
		return nil, ErrDecisionPersistenceUnavailable
	}
	if err = validatePersistedDecision(persisted, candidate); err != nil {
		return nil, err
	}
	execution.decisionId = persisted.DecisionId
	if !created && isTerminalDecisionStatus(persisted.Status) {
		return replayDecisionResult(persisted)
	}

	if err = s.authorizer.AuthorizeTransactionCreation(c, execution.uid, clientTimezone, drafts); err != nil {
		if markErr := s.repository.markDecisionFailed(c, execution.uid, persisted.DecisionId, "authorization_failed", now); markErr != nil {
			return nil, ErrDecisionPersistenceUnavailable
		}
		return nil, ErrDecisionAuthorizationFailed
	}

	completed, err := s.repository.executeDecision(c, execution, s.ledger, s.generateId, now)
	if err == nil {
		return newDecisionResult(completed, false)
	}
	publicError, failureCode := classifyDecisionExecutionError(err)
	if markErr := s.repository.markDecisionFailed(c, execution.uid, persisted.DecisionId, failureCode, now); markErr != nil {
		return nil, ErrDecisionPersistenceUnavailable
	}
	return nil, publicError
}

func normalizeDecideCaseRequest(request DecideCaseRequest) (*decisionExecution, string, string, string, []*models.Transaction, error) {
	if request.Uid < 1 || request.CaseId < 1 || request.ExpectedCaseVersion < 1 ||
		!isDecisionType(request.DecisionType, false) || !isDecisionIdempotencyKey(request.IdempotencyKey) || net.ParseIP(request.CreatedIp) == nil ||
		!isFieldSelection(request.FieldSelection) {
		return nil, "", "", "", nil, ErrDecisionRequestInvalid
	}
	execution := &decisionExecution{uid: request.Uid, caseId: request.CaseId, expectedCaseVersion: request.ExpectedCaseVersion, decisionType: request.DecisionType, fieldSelection: request.FieldSelection}
	var err error
	if request.PrimaryDraft != nil {
		execution.primaryDraft, err = buildDecisionDraft(request.Uid, request.CreatedIp, request.PrimaryDraft)
	}
	if err == nil && request.RefundOriginalDraft != nil {
		execution.refundOriginalDraft, err = buildDecisionDraft(request.Uid, request.CreatedIp, request.RefundOriginalDraft)
	}
	if err == nil && request.RefundTransactionDraft != nil {
		execution.refundTransactionDraft, err = buildDecisionDraft(request.Uid, request.CreatedIp, request.RefundTransactionDraft)
	}
	if err != nil || !validDraftCombination(execution) {
		return nil, "", "", "", nil, ErrDecisionRequestInvalid
	}
	fieldJSON, err := json.Marshal(request.FieldSelection)
	if err != nil {
		return nil, "", "", "", nil, ErrDecisionRequestInvalid
	}
	keyDigest := decisionIdempotencyDigest(request.IdempotencyKey)
	requestDigest := decisionRequestDigest(execution)
	drafts := make([]*models.Transaction, 0, 2)
	for _, draft := range []*decisionDraft{execution.primaryDraft, execution.refundOriginalDraft, execution.refundTransactionDraft} {
		if draft != nil {
			drafts = append(drafts, draft.transaction)
		}
	}
	return execution, keyDigest, requestDigest, string(fieldJSON), drafts, nil
}

func normalizeUndoCaseRequest(request UndoCaseRequest) (*decisionExecution, string, string, error) {
	if request.Uid < 1 || request.CaseId < 1 || request.ExpectedCaseVersion < 1 || !isDecisionIdempotencyKey(request.IdempotencyKey) {
		return nil, "", "", ErrDecisionRequestInvalid
	}
	execution := &decisionExecution{uid: request.Uid, caseId: request.CaseId, expectedCaseVersion: request.ExpectedCaseVersion, decisionType: DECISION_TYPE_REOPEN, undo: true}
	return execution, decisionIdempotencyDigest(request.IdempotencyKey), decisionRequestDigest(execution), nil
}

func buildDecisionDraft(uid int64, createdIp string, draft *importing.LedgerTransactionDraft) (*decisionDraft, error) {
	if draft == nil || draft.UnixTime < 1 || draft.UnixTime > math.MaxInt64/1000 || draft.TimezoneUtcOffset < -720 || draft.TimezoneUtcOffset > 840 ||
		draft.SourceAccountId < 1 || draft.CategoryId < 1 || draft.SourceAmount < 0 || draft.SourceAmount > models.MaximumTransactionAmount ||
		!utf8.ValidString(draft.Comment) || utf8.RuneCountInString(draft.Comment) > 255 || len(draft.TagIds) > models.MaximumTagsCountOfTransaction {
		return nil, ErrDecisionRequestInvalid
	}
	dbType, err := draft.Type.ToTransactionDbType()
	if err != nil || draft.Type == models.TRANSACTION_TYPE_MODIFY_BALANCE {
		return nil, ErrDecisionRequestInvalid
	}
	if draft.Type == models.TRANSACTION_TYPE_TRANSFER {
		if draft.DestinationAccountId < 1 || draft.DestinationAccountId == draft.SourceAccountId || draft.DestinationAmount < 0 || draft.DestinationAmount > models.MaximumTransactionAmount {
			return nil, ErrDecisionRequestInvalid
		}
	} else if draft.DestinationAccountId != 0 || draft.DestinationAmount != 0 {
		return nil, ErrDecisionRequestInvalid
	}
	tagIds := append([]int64(nil), draft.TagIds...)
	sort.Slice(tagIds, func(i, j int) bool { return tagIds[i] < tagIds[j] })
	for index, tagId := range tagIds {
		if tagId < 1 || (index > 0 && tagIds[index-1] == tagId) {
			return nil, ErrDecisionRequestInvalid
		}
	}
	return &decisionDraft{transaction: &models.Transaction{
		Uid: uid, Type: dbType, CategoryId: draft.CategoryId, AccountId: draft.SourceAccountId,
		TransactionTime: utils.GetMinTransactionTimeFromUnixTime(draft.UnixTime), TimezoneUtcOffset: draft.TimezoneUtcOffset,
		Amount: draft.SourceAmount, RelatedAccountId: draft.DestinationAccountId, RelatedAccountAmount: draft.DestinationAmount,
		HideAmount: draft.HideAmount, Comment: draft.Comment, CreatedIp: createdIp,
	}, tagIds: tagIds}, nil
}

func validDraftCombination(execution *decisionExecution) bool {
	switch execution.decisionType {
	case DECISION_TYPE_SAME_EVENT:
		return execution.refundOriginalDraft == nil && execution.refundTransactionDraft == nil
	case DECISION_TYPE_INTERNAL_TRANSFER:
		return execution.refundOriginalDraft == nil && execution.refundTransactionDraft == nil &&
			(execution.primaryDraft == nil || execution.primaryDraft.transaction.Type == models.TRANSACTION_DB_TYPE_TRANSFER_OUT)
	case DECISION_TYPE_REFUND_REVERSAL:
		return execution.primaryDraft == nil &&
			(execution.refundOriginalDraft == nil || isOrdinaryTransaction(execution.refundOriginalDraft.transaction)) &&
			(execution.refundTransactionDraft == nil || isOrdinaryTransaction(execution.refundTransactionDraft.transaction))
	case DECISION_TYPE_INDEPENDENT, DECISION_TYPE_DEFER:
		return execution.primaryDraft == nil && execution.refundOriginalDraft == nil && execution.refundTransactionDraft == nil
	default:
		return false
	}
}

func decisionIdempotencyDigest(key string) string {
	hash := sha256.Sum256(encodeDecisionParts(string(IDEMPOTENCY_KEY_VERSION_V1), key))
	return hex.EncodeToString(hash[:])
}

func decisionRequestDigest(execution *decisionExecution) string {
	parts := []string{string(DECISION_REQUEST_VERSION_V1), strconv.FormatInt(execution.caseId, 10), strconv.FormatInt(execution.expectedCaseVersion, 10), string(execution.decisionType),
		strconv.FormatInt(execution.fieldSelection.AccountAmountMemberOrder, 10), strconv.FormatInt(execution.fieldSelection.MerchantItemMemberOrder, 10), strconv.FormatInt(execution.fieldSelection.RefundOriginalMemberOrder, 10)}
	for _, item := range []struct {
		name  string
		draft *decisionDraft
	}{{"primary", execution.primaryDraft}, {"refund_original", execution.refundOriginalDraft}, {"refund_transaction", execution.refundTransactionDraft}} {
		parts = append(parts, item.name)
		if item.draft == nil {
			parts = append(parts, "absent")
			continue
		}
		tx := item.draft.transaction
		parts = append(parts, "present", strconv.FormatUint(uint64(tx.Type), 10), strconv.FormatInt(tx.CategoryId, 10), strconv.FormatInt(tx.TransactionTime, 10), strconv.FormatInt(int64(tx.TimezoneUtcOffset), 10), strconv.FormatInt(tx.AccountId, 10), strconv.FormatInt(tx.RelatedAccountId, 10), strconv.FormatInt(tx.Amount, 10), strconv.FormatInt(tx.RelatedAccountAmount, 10), strconv.FormatBool(tx.HideAmount), tx.Comment)
		for _, tagId := range item.draft.tagIds {
			parts = append(parts, "tag", strconv.FormatInt(tagId, 10))
		}
	}
	hash := sha256.Sum256(encodeDecisionParts(parts...))
	return hex.EncodeToString(hash[:])
}

func encodeDecisionParts(parts ...string) []byte {
	result := make([]byte, 0)
	var length [8]byte
	for _, part := range parts {
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		result = append(result, length[:]...)
		result = append(result, part...)
	}
	return result
}

func isDecisionIdempotencyKey(value string) bool {
	if len(value) < minimumDecisionIdempotencyKeyBytes || len(value) > maximumDecisionIdempotencyKeyBytes {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return false
		}
	}
	return true
}

func isDecisionType(value DecisionType, allowReopen bool) bool {
	return value == DECISION_TYPE_SAME_EVENT || value == DECISION_TYPE_INTERNAL_TRANSFER || value == DECISION_TYPE_REFUND_REVERSAL ||
		value == DECISION_TYPE_INDEPENDENT || value == DECISION_TYPE_DEFER || (allowReopen && value == DECISION_TYPE_REOPEN)
}

func isFieldSelection(value DecisionFieldSelection) bool {
	for _, order := range []int64{value.AccountAmountMemberOrder, value.MerchantItemMemberOrder, value.RefundOriginalMemberOrder} {
		if order < 0 || order > 2 {
			return false
		}
	}
	return true
}

func isTerminalDecisionStatus(status DecisionStatus) bool {
	return status == DECISION_STATUS_APPLIED || status == DECISION_STATUS_ACTION_REQUIRED || status == DECISION_STATUS_DEFERRED || status == DECISION_STATUS_FAILED
}

func validatePersistedDecision(persisted *Decision, candidate *Decision) error {
	if persisted == nil || candidate == nil || persisted.Uid != candidate.Uid || persisted.DecisionId < 1 || persisted.IdempotencyKeyDigest != candidate.IdempotencyKeyDigest ||
		persisted.IdempotencyKeyVersion != IDEMPOTENCY_KEY_VERSION_V1 || persisted.RequestDigestVersion != DECISION_REQUEST_VERSION_V1 {
		return ErrDecisionPersistenceUnavailable
	}
	if persisted.RequestDigest != candidate.RequestDigest {
		return ErrDecisionIdempotencyConflict
	}
	if persisted.CaseId != candidate.CaseId || persisted.ExpectedCaseVersion != candidate.ExpectedCaseVersion || persisted.DecisionType != candidate.DecisionType {
		return ErrDecisionPersistenceUnavailable
	}
	return nil
}

func newDecisionResult(value *Decision, replayed bool) (*DecisionResult, error) {
	if value == nil || value.DecisionId < 1 || value.CaseId < 1 || !isDecisionType(value.DecisionType, true) || !isTerminalDecisionStatus(value.Status) {
		return nil, ErrDecisionPersistenceUnavailable
	}
	reasons := make([]string, 0)
	if len(value.ReasonCodesJson) > 4096 || json.Unmarshal([]byte(value.ReasonCodesJson), &reasons) != nil {
		return nil, ErrDecisionPersistenceUnavailable
	}
	for _, reason := range reasons {
		if validateSafeReasonCode(reason) != nil {
			return nil, ErrDecisionPersistenceUnavailable
		}
	}
	return &DecisionResult{
		DecisionId: value.DecisionId, CaseId: value.CaseId, ExpectedCaseVersion: value.ExpectedCaseVersion, AppliedCaseVersion: value.AppliedCaseVersion,
		DecisionType: value.DecisionType, PreviousDecisionId: cloneInt64(value.PreviousDecisionId), Status: value.Status, ReasonCodes: reasons, ErrorCode: value.ErrorCode,
		CreatedUnixTime: value.CreatedUnixTime, StartedUnixTime: cloneInt64(value.StartedUnixTime), CompletedUnixTime: cloneInt64(value.CompletedUnixTime), FailedUnixTime: cloneInt64(value.FailedUnixTime), UpdatedUnixTime: value.UpdatedUnixTime, Replayed: replayed,
	}, nil
}

func replayDecisionResult(value *Decision) (*DecisionResult, error) {
	result, err := newDecisionResult(value, true)
	if err != nil {
		return nil, err
	}
	if value.Status != DECISION_STATUS_FAILED {
		return result, nil
	}
	return result, publicDecisionFailure(value.ErrorCode)
}

func publicDecisionFailure(code string) error {
	switch code {
	case "case_not_found":
		return ErrDecisionCaseNotFound
	case "authorization_failed":
		return ErrDecisionAuthorizationFailed
	case "case_version_conflict":
		return ErrDecisionCaseVersionConflict
	case "case_not_available":
		return ErrDecisionNotAvailable
	case "ledger_rejected":
		return ErrDecisionLedgerRejected
	default:
		return ErrDecisionPersistenceUnavailable
	}
}

func classifyDecisionExecutionError(err error) (error, string) {
	switch {
	case errors.Is(err, errDecisionCaseNotFound):
		return ErrDecisionCaseNotFound, "case_not_found"
	case errors.Is(err, errDecisionCaseVersionConflict):
		return ErrDecisionCaseVersionConflict, "case_version_conflict"
	case errors.Is(err, errDecisionNotAvailable):
		return ErrDecisionNotAvailable, "case_not_available"
	case errors.Is(err, errDecisionLedgerRejected):
		return ErrDecisionLedgerRejected, "ledger_rejected"
	default:
		return ErrDecisionPersistenceUnavailable, "persistence_unavailable"
	}
}

func isOrdinaryTransaction(transaction *models.Transaction) bool {
	return transaction != nil && (transaction.Type == models.TRANSACTION_DB_TYPE_INCOME || transaction.Type == models.TRANSACTION_DB_TYPE_EXPENSE)
}
