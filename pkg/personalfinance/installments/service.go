package installments

import (
	"errors"
	"time"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
)

var (
	ErrServiceInvalidRequest    = errors.New("installment service request is invalid")
	ErrServiceCandidateNotFound = errors.New("installment candidate is not found")
	ErrServiceVersionConflict   = errors.New("installment candidate version conflict")
	ErrServiceStateConflict     = errors.New("installment candidate state conflict")
	ErrServiceAccountRejected   = errors.New("installment liability account is rejected")
	ErrServiceContractRejected  = errors.New("installment contract is rejected")
	ErrServicePersistenceFailed = errors.New("installment persistence is unavailable")
)

type ServiceErrorCode string

const (
	SERVICE_ERROR_INVALID_REQUEST     ServiceErrorCode = "invalid_request"
	SERVICE_ERROR_CANDIDATE_NOT_FOUND ServiceErrorCode = "candidate_not_found"
	SERVICE_ERROR_VERSION_CONFLICT    ServiceErrorCode = "candidate_version_conflict"
	SERVICE_ERROR_STATE_CONFLICT      ServiceErrorCode = "candidate_state_conflict"
	SERVICE_ERROR_ACCOUNT_REJECTED    ServiceErrorCode = "liability_account_rejected"
	SERVICE_ERROR_CONTRACT_REJECTED   ServiceErrorCode = "contract_rejected"
	SERVICE_ERROR_PERSISTENCE         ServiceErrorCode = "persistence_unavailable"
	SERVICE_ERROR_UNKNOWN_ZERO        ServiceErrorCode = "unknown_value_must_not_be_zero"
)

type ServiceError struct {
	Code  ServiceErrorCode
	kind  error
	cause error
}

func (err *ServiceError) Error() string {
	return "installment service: " + string(err.Code)
}

func (err *ServiceError) Unwrap() error {
	return err.kind
}

func serviceError(kind error, code ServiceErrorCode) error {
	return &ServiceError{Code: code, kind: kind}
}

func ServiceErrorCodeOf(err error) ServiceErrorCode {
	var typed *ServiceError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return SERVICE_ERROR_PERSISTENCE
}

// EvidenceReader 只读取当前 uid 的原始行，不写导入表。
type EvidenceReader interface {
	ListRawImportRows(c core.Context, uid int64, batchId int64) ([]*importing.RawImportRow, error)
}

// ContractGateway 仅在用户确认创建或关联合同时调用贷款服务。
type ContractGateway interface {
	Calculate(request loans.CalculateRequest) (*loans.CalculationResult, error)
	CreateContract(c core.Context, request loans.CreateContractRequest) (*loans.CommandResult, error)
	GetContract(c core.Context, uid int64, contractId int64, asOfDate string) (*loans.ContractDetail, error)
}

// Service 编排分期识别、待完善候选和三种确认结果。
type Service struct {
	repository *Repository
	evidence   EvidenceReader
	contracts  ContractGateway
	accounts   loans.AccountSnapshotReader
	generateId func() int64
	now        func() time.Time
}

func NewService(repository *Repository, evidence EvidenceReader, contracts ContractGateway, accounts loans.AccountSnapshotReader, generateId func() int64) (*Service, error) {
	if repository == nil || evidence == nil || generateId == nil {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	return &Service{repository: repository, evidence: evidence, contracts: contracts, accounts: accounts, generateId: generateId, now: time.Now}, nil
}

type IngestRequest struct {
	Uid      int64
	BatchIds []int64
}

type IngestResult struct {
	CandidateCount int64
	MemberCount    int64
	SkippedCount   int64
}

// PromoteRequest 在整批账单成功入账后生效已确认的分期本金决定。
// 有完整草稿时创建正式合同；没有草稿时保留为待完善候选。它不改变正式账本交易。
type PromoteRequest struct {
	Uid          int64
	CandidateIds []int64
}

type CandidateView struct {
	CandidateId                 int64
	Status                      CandidateStatus
	Version                     int64
	LiabilityAccountId          *int64
	TermCount                   *int64
	LinkedContractId            *int64
	PurchaseRelation            PurchaseRelation
	LinkedPurchaseTransactionId *int64
	PrincipalAmount             *int64
	PaymentAmount               *int64
	InterestAmount              *int64
	FeeAmount                   *int64
	RepaymentMethod             RepaymentMethod
	FirstDueDate                string
	CurrentPeriod               *int64
	CreatedUnixTime             int64
	UpdatedUnixTime             int64
	Members                     []*MemberView
}

type MemberView struct {
	MemberId        int64
	MemberKind      MemberKind
	MemberRefId     int64
	MemberRole      MemberRole
	PeriodNumber    *int64
	CreatedUnixTime int64
}

type CandidateListResult struct {
	Items      []*CandidateView
	NextCursor *CandidateCursor
}

type ConfirmRequest struct {
	Uid                         int64
	CandidateId                 int64
	ExpectedVersion             int64
	TreatAsInstallment          bool
	LiabilityAccountId          *int64
	TermCount                   *int64
	PurchaseRelation            PurchaseRelation
	LinkedPurchaseTransactionId *int64
	LinkedContractId            *int64
	Contract                    *loans.ContractSpec
}

func candidateView(value *Candidate, members []*CandidateMember) *CandidateView {
	if value == nil {
		return nil
	}
	view := &CandidateView{
		CandidateId: value.CandidateId, Status: value.Status, Version: value.Version,
		LiabilityAccountId: value.LiabilityAccountId, TermCount: value.TermCount, LinkedContractId: value.LinkedContractId,
		PurchaseRelation: value.PurchaseRelation, LinkedPurchaseTransactionId: value.LinkedPurchaseTransactionId,
		PrincipalAmount: value.PrincipalAmount, PaymentAmount: value.PaymentAmount, InterestAmount: value.InterestAmount,
		FeeAmount: value.FeeAmount, RepaymentMethod: value.RepaymentMethod, FirstDueDate: value.FirstDueDate,
		CurrentPeriod: value.CurrentPeriod, CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}
	for _, member := range members {
		if member == nil {
			continue
		}
		view.Members = append(view.Members, &MemberView{
			MemberId: member.MemberId, MemberKind: member.MemberKind, MemberRefId: member.MemberRefId,
			MemberRole: member.MemberRole, PeriodNumber: cloneInt64(member.PeriodNumber), CreatedUnixTime: member.CreatedUnixTime,
		})
	}
	return view
}

func cloneCandidateForUpdate(value *Candidate) *Candidate {
	return cloneCandidate(value)
}
