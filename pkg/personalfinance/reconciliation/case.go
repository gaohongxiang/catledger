package reconciliation

import (
	"errors"
	"fmt"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	defaultCasePageSize          = 50
	maximumCasePageSize          = 100
	maximumTaskCaseRows          = 2000
	maximumTaskCases             = 500
	caseDetailRowsPerMemberLimit = 50
	caseDetailRelationshipLimit  = 200
)

var (
	ErrCaseRequestInvalid         = errors.New("personal finance reconciliation case request is invalid")
	ErrCaseNotFound               = errors.New("personal finance reconciliation case is not found")
	ErrCasePersistenceUnavailable = errors.New("personal finance reconciliation case persistence is unavailable")
)

// CaseCursor 是按 updated_unix_time、case_id 倒序分页的排他游标。
type CaseCursor struct {
	UpdatedUnixTime int64
	CaseId          int64
}

// ListCasesRequest 只允许按一个稳定状态读取固定上限的 case。
type ListCasesRequest struct {
	Uid    int64
	Status CaseStatus
	Cursor *CaseCursor
	Limit  int
}

// CaseReason 是候选生成已脱敏的稳定原因码和值。
type CaseReason struct {
	Code  string
	Value int64
}

// CaseSummary 不包含 case key、摘要或持久化 JSON。
type CaseSummary struct {
	CaseId                int64
	Status                CaseStatus
	Version               int64
	MemberCount           int64
	SuggestedRelationType DecisionType
	CandidateScore        int64
	CandidateRuleVersion  RuleVersion
	ExplanationVersion    RuleVersion
	ReasonCodes           []CaseReason
	CurrentDecisionId     *int64
	CurrentDecisionType   *DecisionType
	CurrentDecisionStatus *DecisionStatus
	CreatedUnixTime       int64
	LastEvaluatedUnixTime int64
	UpdatedUnixTime       int64
}

// CasePage 返回稳定游标分页结果。
type CasePage struct {
	Items      []*CaseSummary
	NextCursor *CaseCursor
}

// CaseTransactionReference 是某条证据当前可见的正式交易关系摘要。
type CaseTransactionReference struct {
	TransactionId              int64
	RelationRole               string
	CreationMethod             string
	RuleVersion                string
	TransactionUpdatedUnixTime int64
}

// CaseEvidenceSummary 只返回规范化字段和内部 ID，不返回原始字段或来源标识。
type CaseEvidenceSummary struct {
	RowId                       int64
	BatchId                     int64
	RowNumber                   int64
	SourceType                  importing.SourceType
	FileExtension               string
	NormalizedUnixTime          *int64
	NormalizedTimezoneUtcOffset *int16
	NormalizedAmount            *int64
	Currency                    string
	NormalizedDirection         importing.NormalizedDirection
	NormalizedTransactionType   importing.SourceTransactionType
	EconomicEffect              importing.EconomicEffect
	ParseState                  importing.ParseState
	IdentityState               importing.IdentityState
	Disposition                 importing.ImportDisposition
	ProcessingState             importing.ProcessingState
	Transactions                []*CaseTransactionReference
}

// CaseMemberDetail 是一个稳定成员的脱敏证据集合。
type CaseMemberDetail struct {
	MemberId             int64
	MemberOrder          int64
	MemberKind           MemberKind
	MemberRole           MemberRole
	SourceType           importing.SourceType
	MaskedSourceAccount  string
	Evidence             []*CaseEvidenceSummary
	EvidenceLimitReached bool
}

// CaseDetail 是 list 摘要加两个成员的脱敏详情。
type CaseDetail struct {
	*CaseSummary
	Members                  []*CaseMemberDetail
	RelationshipLimitReached bool
}

// CaseService 提供对账 case 的只读边界。
type CaseService struct {
	repository *caseRepository
}

// NewCaseService 创建稳定分页和脱敏详情服务。
func NewCaseService(store *datastore.DataStore) (*CaseService, error) {
	repository, err := newCaseRepository(store)
	if err != nil {
		return nil, err
	}

	return &CaseService{repository: repository}, nil
}

// ListCases 按 uid、状态和排他游标倒序读取 case。
func (s *CaseService) ListCases(c core.Context, request ListCasesRequest) (*CasePage, error) {
	if s == nil || s.repository == nil || request.Uid < 1 || !isCaseStatus(request.Status) {
		return nil, ErrCaseRequestInvalid
	}

	limit := request.Limit
	if limit == 0 {
		limit = defaultCasePageSize
	}
	if limit < 1 || limit > maximumCasePageSize || !isCaseCursor(request.Cursor) {
		return nil, ErrCaseRequestInvalid
	}

	page, err := s.repository.listCases(c, request.Uid, request.Status, request.Cursor, limit)
	if err != nil {
		return nil, ErrCasePersistenceUnavailable
	}
	return page, nil
}

// GetCase 按 uid 返回一个不含内部摘要和原始证据的 case 详情。
func (s *CaseService) GetCase(c core.Context, uid int64, caseId int64) (*CaseDetail, error) {
	if s == nil || s.repository == nil || uid < 1 || caseId < 1 {
		return nil, ErrCaseRequestInvalid
	}

	detail, err := s.repository.getCase(c, uid, caseId)
	if err != nil {
		return nil, ErrCasePersistenceUnavailable
	}
	if detail == nil {
		return nil, ErrCaseNotFound
	}
	return detail, nil
}

// ListCasesForRows 返回与任务证据行相关的有界 case；open case 只接受当前候选规则版本。
func (s *CaseService) ListCasesForRows(c core.Context, uid int64, rowIds []int64) ([]*CaseDetail, error) {
	if s == nil || s.repository == nil || uid < 1 || len(rowIds) < 1 || len(rowIds) > maximumTaskCaseRows {
		return nil, ErrCaseRequestInvalid
	}
	caseIds, err := s.repository.findCaseIdsForRows(c, uid, rowIds, maximumTaskCases)
	if err != nil {
		return nil, ErrCasePersistenceUnavailable
	}
	items := make([]*CaseDetail, 0, len(caseIds))
	for _, caseId := range caseIds {
		detail, getErr := s.repository.getCase(c, uid, caseId)
		if getErr != nil {
			return nil, ErrCasePersistenceUnavailable
		}
		if detail == nil || (detail.Status == CASE_STATUS_OPEN && detail.CandidateRuleVersion != CANDIDATE_RULE_VERSION_V3) {
			continue
		}
		items = append(items, detail)
	}
	return items, nil
}

func isCaseStatus(status CaseStatus) bool {
	return status == CASE_STATUS_OPEN || status == CASE_STATUS_RESOLVED ||
		status == CASE_STATUS_ACTION_REQUIRED || status == CASE_STATUS_DEFERRED
}

func isCaseCursor(cursor *CaseCursor) bool {
	return cursor == nil || (cursor.UpdatedUnixTime > 0 && cursor.CaseId > 0)
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt16(value *int16) *int16 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func validateSafeReasonCode(value string) error {
	if value == "" || len(value) > 64 {
		return fmt.Errorf("invalid reconciliation reason code")
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return fmt.Errorf("invalid reconciliation reason code")
		}
	}
	return nil
}
