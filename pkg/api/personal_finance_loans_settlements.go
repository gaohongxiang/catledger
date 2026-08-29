package api

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/loans/calculation"
)

const personalFinanceLoanMaximumSettlementCandidates = 50

// PersonalFinanceLoansApplication 是十二个贷款 HTTP 端点依赖的完整应用接口。
type PersonalFinanceLoansApplication interface {
	PersonalFinanceLoansContractsApplication
	GetSettlementCandidates(c core.Context, request loans.SettlementCandidateRequest) (*loans.SettlementCandidateResult, error)
	ApplySettlement(c core.Context, request loans.ApplySettlementRequest, clientTimezone *time.Location) (*loans.SettlementResult, error)
	GetSettlementUndoImpact(c core.Context, request loans.SettlementUndoImpactRequest) (*loans.SettlementUndoImpact, error)
	ReverseSettlement(c core.Context, request loans.ReverseSettlementRequest) (*loans.SettlementResult, error)
}

var _ PersonalFinanceLoansApplication = (*loans.Service)(nil)

// PersonalFinanceLoansApi 聚合合同与结算薄边界，供生产组合根一次构造后注册路由。
type PersonalFinanceLoansApi struct {
	*PersonalFinanceLoansContractsApi
	settlements PersonalFinanceLoansApplication
}

// NewPersonalFinanceLoansApi 创建完整贷款 API；应用依赖在启动期固定，handler 不创建请求期服务。
func NewPersonalFinanceLoansApi(application PersonalFinanceLoansApplication) (*PersonalFinanceLoansApi, error) {
	if application == nil {
		return nil, errors.New("personal finance loans application is required")
	}
	contracts, err := NewPersonalFinanceLoansContractsApi(application)
	if err != nil {
		return nil, err
	}
	return &PersonalFinanceLoansApi{PersonalFinanceLoansContractsApi: contracts, settlements: application}, nil
}

type personalFinanceLoanOptionalIdentifier struct {
	present bool
	null    bool
	value   int64
}

func (value *personalFinanceLoanOptionalIdentifier) UnmarshalJSON(encoded []byte) error {
	value.present = true
	if string(encoded) == "null" {
		value.null = true
		return nil
	}
	var text string
	if err := json.Unmarshal(encoded, &text); err != nil {
		return errors.New("loan identifier must be a decimal string")
	}
	parsed, err := parsePersonalFinanceLoanPositiveInt64(text)
	if err != nil {
		return err
	}
	value.value = parsed
	return nil
}

func (value personalFinanceLoanOptionalIdentifier) pointer() (*int64, error) {
	if !value.present {
		return nil, nil
	}
	if value.null || value.value < 1 {
		return nil, errors.New("loan identifier cannot be null")
	}
	parsed := value.value
	return &parsed, nil
}

type personalFinanceLoanOptionalPositiveInteger struct {
	present bool
	null    bool
	value   int64
}

func (value *personalFinanceLoanOptionalPositiveInteger) UnmarshalJSON(encoded []byte) error {
	value.present = true
	if string(encoded) == "null" {
		value.null = true
		return nil
	}
	if err := json.Unmarshal(encoded, &value.value); err != nil {
		return errors.New("loan snapshot time must be an integer")
	}
	return nil
}

func (value personalFinanceLoanOptionalPositiveInteger) pointer() (*int64, error) {
	if !value.present {
		return nil, nil
	}
	if value.null || value.value < 1 || !isPersonalFinanceLoanSafeNumber(value.value) {
		return nil, errors.New("loan snapshot time must be a positive safe integer")
	}
	parsed := value.value
	return &parsed, nil
}

type personalFinanceLoanSettlementApplyRequest struct {
	ContractId              int64                                    `json:"contractId,string"`
	ExpectedContractVersion int64                                    `json:"expectedContractVersion"`
	InstallmentId           personalFinanceLoanOptionalIdentifier    `json:"installmentId"`
	IdempotencyKey          string                                   `json:"idempotencyKey"`
	Components              []personalFinanceLoanSettlementComponent `json:"components"`
}

type personalFinanceLoanSettlementComponent struct {
	ComponentType                      loans.ComponentType                        `json:"componentType"`
	AllocatedAmount                    int64                                      `json:"allocatedAmount"`
	ExistingTransactionId              personalFinanceLoanOptionalIdentifier      `json:"existingTransactionId"`
	ExpectedUpdatedUnixTime            personalFinanceLoanOptionalPositiveInteger `json:"expectedUpdatedUnixTime"`
	ExpectedCounterpartUpdatedUnixTime personalFinanceLoanOptionalPositiveInteger `json:"expectedCounterpartUpdatedUnixTime"`
	LedgerDraft                        *personalFinanceLoanSettlementLedgerDraft  `json:"ledgerDraft"`
}

type personalFinanceLoanSettlementLedgerDraft struct {
	TransactionType      loans.LedgerEventKind                 `json:"transactionType"`
	TransactionDate      string                                `json:"transactionDate"`
	SourceAccountId      int64                                 `json:"sourceAccountId,string"`
	DestinationAccountId personalFinanceLoanOptionalIdentifier `json:"destinationAccountId"`
	CategoryId           int64                                 `json:"categoryId,string"`
	Amount               int64                                 `json:"amount"`
	Currency             string                                `json:"currency"`
}

type personalFinanceLoanSettlementUndoRequest struct {
	ContractId              int64  `json:"contractId,string"`
	ActionId                int64  `json:"actionId,string"`
	ExpectedContractVersion int64  `json:"expectedContractVersion"`
	IdempotencyKey          string `json:"idempotencyKey"`
}

type personalFinanceLoanSettlementCandidateResponse struct {
	TransactionId              int64                                `json:"transactionId,string"`
	TransactionType            loans.LedgerEventKind                `json:"transactionType"`
	TransactionDate            string                               `json:"transactionDate"`
	Amount                     int64                                `json:"amount"`
	Currency                   string                               `json:"currency"`
	MaskedSourceAccount        string                               `json:"maskedSourceAccount"`
	MaskedDestinationAccount   string                               `json:"maskedDestinationAccount,omitempty"`
	Eligible                   bool                                 `json:"eligible"`
	ReasonCodes                []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
	UpdatedUnixTime            int64                                `json:"updatedUnixTime"`
	CounterpartUpdatedUnixTime *int64                               `json:"counterpartUpdatedUnixTime,omitempty"`
}

type personalFinanceLoanSettlementCandidateGroupResponse struct {
	ComponentType     loans.ComponentType                               `json:"componentType"`
	ExpectedAmount    int64                                             `json:"expectedAmount"`
	OutstandingAmount int64                                             `json:"outstandingAmount"`
	Candidates        []*personalFinanceLoanSettlementCandidateResponse `json:"candidates"`
	LimitReached      bool                                              `json:"limitReached"`
}

type personalFinanceLoanSettlementCandidatesResponse struct {
	ContractId    int64                                                  `json:"contractId,string"`
	InstallmentId *int64                                                 `json:"installmentId,string,omitempty"`
	Groups        []*personalFinanceLoanSettlementCandidateGroupResponse `json:"groups"`
}

type personalFinanceLoanSettlementAllocationResponse struct {
	Id                         int64                                `json:"id,string"`
	InstallmentId              *int64                               `json:"installmentId,string,omitempty"`
	ComponentType              loans.ComponentType                  `json:"componentType"`
	AllocatedAmount            int64                                `json:"allocatedAmount"`
	CreationMethod             loans.AllocationCreationMethod       `json:"creationMethod"`
	Status                     loans.AllocationStatus               `json:"status"`
	TransactionId              int64                                `json:"transactionId,string"`
	CounterpartTransactionId   *int64                               `json:"counterpartTransactionId,string,omitempty"`
	TransactionUpdatedUnixTime int64                                `json:"transactionUpdatedUnixTime"`
	CounterpartUpdatedUnixTime *int64                               `json:"counterpartUpdatedUnixTime,omitempty"`
	ReasonCodes                []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
	CreatedUnixTime            int64                                `json:"createdUnixTime"`
	UpdatedUnixTime            int64                                `json:"updatedUnixTime"`
}

type personalFinanceLoanSettlementUndoImpactResponse struct {
	ContractId                  int64                                `json:"contractId,string"`
	ActionId                    int64                                `json:"actionId,string"`
	ActiveAllocationCount       int64                                `json:"activeAllocationCount"`
	RelationshipCount           int64                                `json:"relationshipCount"`
	AffectedTransactionCount    int64                                `json:"affectedTransactionCount"`
	LoanCreatedTransactionCount int64                                `json:"loanCreatedTransactionCount"`
	ModifiedTransactionCount    int64                                `json:"modifiedTransactionCount"`
	MissingTransactionCount     int64                                `json:"missingTransactionCount"`
	IncompleteTransferPairCount int64                                `json:"incompleteTransferPairCount"`
	CanUndoRelationships        bool                                 `json:"canUndoRelationships"`
	ReasonCodes                 []*personalFinanceLoanReasonResponse `json:"reasonCodes"`
}

// LoanSettlementCandidatesHandler 返回当前计划组件的有界正式交易候选。
func (a *PersonalFinanceLoansApi) LoanSettlementCandidatesHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceLoanSettlementCandidatesRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	location, apiErr := personalFinanceLoanClientTimezone(c)
	if apiErr != nil {
		return nil, apiErr
	}
	if a == nil || a.settlements == nil {
		return nil, errs.ErrOperationFailed
	}
	result, err := a.settlements.GetSettlementCandidates(c, *request)
	if err != nil {
		a.logSettlementServiceFailure(c, "settlement_candidates", request.ContractId, 0, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanSettlementCandidatesResponse(result, request, location)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.settlement_candidates] invalid result for user \"uid:%d\" and contract \"id:%d\"", c.GetCurrentUid(), request.ContractId)
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanSettlementApplyHandler 原子复用或创建正式账本事件并建立贷款分配关系。
func (a *PersonalFinanceLoansApi) LoanSettlementApplyHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanSettlementApplyRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	location, apiErr := personalFinanceLoanClientTimezone(c)
	if apiErr != nil {
		return nil, apiErr
	}
	domain, err := request.domain(c.GetCurrentUid(), c.ClientIP(), location)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.settlements == nil {
		return nil, errs.ErrOperationFailed
	}
	result, err := a.settlements.ApplySettlement(c, domain, location)
	if err != nil {
		a.logSettlementServiceFailure(c, "settlement_apply", domain.ContractId, 0, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanSettlementActionResponse(result, loans.ACTION_TYPE_APPLY_SETTLEMENT,
		domain.ContractId, domain.ExpectedContractVersion)
	if err != nil || !personalFinanceLoanSettlementApplyResponseMatchesRequest(response, domain) {
		log.Errorf(c, "[personal_finance_loans.settlement_apply] invalid result for user \"uid:%d\" and contract \"id:%d\"", c.GetCurrentUid(), domain.ContractId)
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanSettlementUndoImpactHandler 只返回撤销关系的冻结聚合影响。
func (a *PersonalFinanceLoansApi) LoanSettlementUndoImpactHandler(c *core.WebContext) (any, *errs.Error) {
	request, err := parsePersonalFinanceLoanSettlementUndoImpactRequest(c)
	if err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if a == nil || a.settlements == nil {
		return nil, errs.ErrOperationFailed
	}
	result, err := a.settlements.GetSettlementUndoImpact(c, *request)
	if err != nil {
		a.logSettlementServiceFailure(c, "settlement_undo_impact", request.ContractId, request.ApplyActionId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanSettlementUndoImpactResponse(result, request)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.settlement_undo_impact] invalid result for user \"uid:%d\", contract \"id:%d\" and action \"id:%d\"",
			c.GetCurrentUid(), request.ContractId, request.ApplyActionId)
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

// LoanSettlementUndoHandler 只撤销原 apply action 的全部活动关系，保留正式交易和历史。
func (a *PersonalFinanceLoansApi) LoanSettlementUndoHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceLoanSettlementUndoRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}
	if request.ContractId < 1 || request.ActionId < 1 || request.ExpectedContractVersion < 1 ||
		!isPersonalFinanceLoanSafeNumber(request.ExpectedContractVersion) || !isPersonalFinanceLoanIdempotencyKey(request.IdempotencyKey) {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(errors.New("loan settlement undo request is invalid"))
	}
	if a == nil || a.settlements == nil {
		return nil, errs.ErrOperationFailed
	}
	domain := loans.ReverseSettlementRequest{Uid: c.GetCurrentUid(), ContractId: request.ContractId, ApplyActionId: request.ActionId,
		ExpectedContractVersion: request.ExpectedContractVersion, IdempotencyKey: request.IdempotencyKey}
	result, err := a.settlements.ReverseSettlement(c, domain)
	if err != nil {
		a.logSettlementServiceFailure(c, "settlement_undo", domain.ContractId, domain.ApplyActionId, err)
		return nil, personalFinanceLoanServiceError(err)
	}
	response, err := newPersonalFinanceLoanSettlementActionResponse(result, loans.ACTION_TYPE_REVERSE_SETTLEMENT,
		domain.ContractId, domain.ExpectedContractVersion)
	if err != nil {
		log.Errorf(c, "[personal_finance_loans.settlement_undo] invalid result for user \"uid:%d\", contract \"id:%d\" and action \"id:%d\"",
			c.GetCurrentUid(), domain.ContractId, domain.ApplyActionId)
		return nil, errs.ErrOperationFailed
	}
	return response, nil
}

func parsePersonalFinanceLoanSettlementCandidatesRequest(c *core.WebContext) (*loans.SettlementCandidateRequest, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return nil, errors.New("loan settlement candidates request is required")
	}
	values := c.Request.URL.Query()
	if err := validatePersonalFinanceLoanQueryKeys(values, "contract_id", "installment_id", "component_type"); err != nil {
		return nil, err
	}
	contractId, err := parsePersonalFinanceLoanPositiveInt64(values.Get("contract_id"))
	if err != nil {
		return nil, err
	}
	component := loans.ComponentType(values.Get("component_type"))
	if !isPersonalFinanceLoanComponentType(component) {
		return nil, errors.New("loan settlement component is invalid")
	}
	var installmentId *int64
	if _, present := values["installment_id"]; present {
		parsed, parseErr := parsePersonalFinanceLoanPositiveInt64(values.Get("installment_id"))
		if parseErr != nil {
			return nil, parseErr
		}
		installmentId = &parsed
	}
	if (component == loans.COMPONENT_TYPE_DISBURSEMENT && installmentId != nil) ||
		((component == loans.COMPONENT_TYPE_PRINCIPAL || component == loans.COMPONENT_TYPE_INTEREST) && installmentId == nil) {
		return nil, errors.New("loan settlement installment is inconsistent")
	}
	return &loans.SettlementCandidateRequest{Uid: c.GetCurrentUid(), ContractId: contractId,
		InstallmentId: installmentId, ComponentType: component}, nil
}

func parsePersonalFinanceLoanSettlementUndoImpactRequest(c *core.WebContext) (*loans.SettlementUndoImpactRequest, error) {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return nil, errors.New("loan settlement undo impact request is required")
	}
	values := c.Request.URL.Query()
	if err := validatePersonalFinanceLoanQueryKeys(values, "contract_id", "action_id"); err != nil {
		return nil, err
	}
	contractId, err := parsePersonalFinanceLoanPositiveInt64(values.Get("contract_id"))
	if err != nil {
		return nil, err
	}
	actionId, err := parsePersonalFinanceLoanPositiveInt64(values.Get("action_id"))
	if err != nil {
		return nil, err
	}
	return &loans.SettlementUndoImpactRequest{Uid: c.GetCurrentUid(), ContractId: contractId, ApplyActionId: actionId}, nil
}

func (request *personalFinanceLoanSettlementApplyRequest) domain(uid int64, createdIp string, location *time.Location) (loans.ApplySettlementRequest, error) {
	if request == nil || uid < 1 || request.ContractId < 1 || request.ExpectedContractVersion < 1 ||
		!isPersonalFinanceLoanSafeNumber(request.ExpectedContractVersion) || !isPersonalFinanceLoanIdempotencyKey(request.IdempotencyKey) ||
		len(request.Components) < 1 || len(request.Components) > 3 || location == nil {
		return loans.ApplySettlementRequest{}, errors.New("loan settlement apply request is invalid")
	}
	installmentId, err := request.InstallmentId.pointer()
	if err != nil {
		return loans.ApplySettlementRequest{}, err
	}
	components := make([]loans.SettlementComponentCommand, 0, len(request.Components))
	seen := make(map[loans.ComponentType]struct{}, len(request.Components))
	for index := range request.Components {
		component, componentErr := request.Components[index].domain(installmentId, location)
		if componentErr != nil {
			return loans.ApplySettlementRequest{}, componentErr
		}
		if _, duplicate := seen[component.ComponentType]; duplicate {
			return loans.ApplySettlementRequest{}, errors.New("loan settlement component is duplicated")
		}
		seen[component.ComponentType] = struct{}{}
		components = append(components, component)
	}
	return loans.ApplySettlementRequest{Uid: uid, ContractId: request.ContractId, ExpectedContractVersion: request.ExpectedContractVersion,
		InstallmentId: installmentId, IdempotencyKey: request.IdempotencyKey, CreatedIp: createdIp, Components: components}, nil
}

func (request personalFinanceLoanSettlementComponent) domain(installmentId *int64, location *time.Location) (loans.SettlementComponentCommand, error) {
	if !isPersonalFinanceLoanComponentType(request.ComponentType) || !isPersonalFinanceLoanAmount(request.AllocatedAmount, true) {
		return loans.SettlementComponentCommand{}, errors.New("loan settlement component is invalid")
	}
	transfer := isPersonalFinanceLoanTransferComponent(request.ComponentType)
	if (request.ComponentType == loans.COMPONENT_TYPE_DISBURSEMENT && installmentId != nil) ||
		((request.ComponentType == loans.COMPONENT_TYPE_PRINCIPAL || request.ComponentType == loans.COMPONENT_TYPE_INTEREST) && installmentId == nil) {
		return loans.SettlementComponentCommand{}, errors.New("loan settlement component does not match installment")
	}
	existingFieldsPresent := request.ExistingTransactionId.present || request.ExpectedUpdatedUnixTime.present ||
		request.ExpectedCounterpartUpdatedUnixTime.present
	if (request.LedgerDraft != nil) == existingFieldsPresent {
		return loans.SettlementComponentCommand{}, errors.New("loan settlement source must be exactly one of existing transaction or ledger draft")
	}
	command := loans.SettlementComponentCommand{ComponentType: request.ComponentType, AllocatedAmount: request.AllocatedAmount}
	if request.LedgerDraft != nil {
		draft, err := request.LedgerDraft.domain(transfer, request.AllocatedAmount, location)
		if err != nil {
			return loans.SettlementComponentCommand{}, err
		}
		command.Draft = draft
		return command, nil
	}
	transactionId, err := request.ExistingTransactionId.pointer()
	if err != nil || transactionId == nil {
		return loans.SettlementComponentCommand{}, errors.New("loan existing transaction is required")
	}
	updated, err := request.ExpectedUpdatedUnixTime.pointer()
	if err != nil || updated == nil {
		return loans.SettlementComponentCommand{}, errors.New("loan primary snapshot time is required")
	}
	counterpart, err := request.ExpectedCounterpartUpdatedUnixTime.pointer()
	if err != nil {
		return loans.SettlementComponentCommand{}, err
	}
	if transfer && counterpart == nil || !transfer && request.ExpectedCounterpartUpdatedUnixTime.present {
		return loans.SettlementComponentCommand{}, errors.New("loan counterpart snapshot is inconsistent")
	}
	command.Existing = &loans.ExistingLedgerEventReference{ExistingTransactionId: *transactionId,
		ExpectedUpdatedUnixTime: *updated, ExpectedCounterpartUpdatedUnixTime: counterpart}
	return command, nil
}

func (request *personalFinanceLoanSettlementLedgerDraft) domain(transfer bool, allocatedAmount int64, location *time.Location) (*loans.SettlementLedgerDraft, error) {
	if request == nil || location == nil || request.SourceAccountId < 1 || request.CategoryId < 1 || request.Amount != allocatedAmount ||
		!isPersonalFinanceLoanAmount(request.Amount, true) || !isPersonalFinanceLoanCurrency(request.Currency) {
		return nil, errors.New("loan settlement ledger draft is invalid")
	}
	destination, err := request.DestinationAccountId.pointer()
	if err != nil {
		return nil, err
	}
	if transfer {
		if request.TransactionType != loans.LEDGER_EVENT_KIND_TRANSFER || destination == nil || *destination == request.SourceAccountId {
			return nil, errors.New("loan transfer draft is invalid")
		}
	} else if request.TransactionType != loans.LEDGER_EVENT_KIND_EXPENSE || request.DestinationAccountId.present {
		return nil, errors.New("loan expense draft cannot contain a destination account")
	}
	unixTime, offset, err := personalFinanceLoanCivilDateAtClientMidnight(request.TransactionDate, location)
	if err != nil {
		return nil, err
	}
	destinationId := int64(0)
	if destination != nil {
		destinationId = *destination
	}
	return &loans.SettlementLedgerDraft{Kind: request.TransactionType, TransactionUnixTime: unixTime, TimezoneUtcOffset: offset,
		SourceAccountId: request.SourceAccountId, DestinationAccountId: destinationId, CategoryId: request.CategoryId,
		Amount: request.Amount, Currency: request.Currency}, nil
}

func personalFinanceLoanCivilDateAtClientMidnight(value string, location *time.Location) (int64, int16, error) {
	civil, err := calculation.ParseCivilDate(value)
	if err != nil || location == nil {
		return 0, 0, errors.New("loan transaction date is invalid")
	}
	instant := time.Date(civil.Year, time.Month(civil.Month), civil.Day, 0, 0, 0, 0, location)
	if instant.Format(time.DateOnly) != value || instant.Unix() < 1 {
		return 0, 0, errors.New("loan transaction date cannot be represented in client timezone")
	}
	_, seconds := instant.Zone()
	if seconds%60 != 0 || seconds/60 < -720 || seconds/60 > 840 {
		return 0, 0, errors.New("loan client timezone is invalid")
	}
	return instant.Unix(), int16(seconds / 60), nil
}

func personalFinanceLoanClientTimezone(c *core.WebContext) (*time.Location, *errs.Error) {
	if c == nil {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}
	if name := c.GetHeader(core.ClientTimezoneNameHeaderName); name != "" {
		if location, err := time.LoadLocation(name); err == nil && location != nil {
			_, seconds := time.Now().In(location).Zone()
			if seconds%60 == 0 && seconds/60 >= -720 && seconds/60 <= 840 {
				return location, nil
			}
		}
	}
	offset, err := strconv.Atoi(c.GetHeader(core.ClientTimezoneOffsetHeaderName))
	if err != nil || offset < -720 || offset > 840 {
		return nil, errs.ErrClientTimezoneOffsetInvalid
	}
	return time.FixedZone("Client Fixed Timezone", offset*60), nil
}

func newPersonalFinanceLoanSettlementCandidatesResponse(value *loans.SettlementCandidateResult, request *loans.SettlementCandidateRequest,
	location *time.Location) (*personalFinanceLoanSettlementCandidatesResponse, error) {
	if value == nil || request == nil || location == nil || value.ContractId != request.ContractId ||
		!equalPersonalFinanceLoanOptionalId(value.InstallmentId, request.InstallmentId) || len(value.Groups) != 1 {
		return nil, errors.New("loan settlement candidates result is invalid")
	}
	group := value.Groups[0]
	if group.ComponentType != request.ComponentType || !isPersonalFinanceLoanAmount(group.ExpectedAmount, false) ||
		!isPersonalFinanceLoanAmount(group.OutstandingAmount, false) || group.OutstandingAmount > group.ExpectedAmount ||
		len(group.Candidates) > personalFinanceLoanMaximumSettlementCandidates ||
		group.OutstandingAmount == 0 && (len(group.Candidates) != 0 || group.LimitReached) {
		return nil, errors.New("loan settlement candidate group is invalid")
	}
	responseGroup := &personalFinanceLoanSettlementCandidateGroupResponse{ComponentType: group.ComponentType,
		ExpectedAmount: group.ExpectedAmount, OutstandingAmount: group.OutstandingAmount,
		Candidates: make([]*personalFinanceLoanSettlementCandidateResponse, 0, len(group.Candidates)), LimitReached: group.LimitReached}
	seen := make(map[int64]struct{}, len(group.Candidates))
	transfer := isPersonalFinanceLoanTransferComponent(group.ComponentType)
	for index := range group.Candidates {
		candidate := &group.Candidates[index]
		if candidate.TransactionId < 1 || candidate.TransactionUnixTime < 1 || !isPersonalFinanceLoanAmount(candidate.Amount, true) ||
			candidate.Amount > group.OutstandingAmount || !isPersonalFinanceLoanCurrency(candidate.Currency) ||
			candidate.UpdatedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(candidate.UpdatedUnixTime) ||
			candidate.Eligible != (len(candidate.ReasonCodes) == 0) || !isPersonalFinanceLoanMaskedAccount(candidate.MaskedSourceAccount) {
			return nil, errors.New("loan settlement candidate is invalid")
		}
		if _, duplicate := seen[candidate.TransactionId]; duplicate {
			return nil, errors.New("loan settlement candidate is duplicated")
		}
		seen[candidate.TransactionId] = struct{}{}
		if transfer {
			if candidate.Kind != loans.LEDGER_EVENT_KIND_TRANSFER || !isPersonalFinanceLoanMaskedAccount(candidate.MaskedDestinationAccount) ||
				candidate.CounterpartUpdatedUnixTime == nil || *candidate.CounterpartUpdatedUnixTime < 1 ||
				!isPersonalFinanceLoanSafeNumber(*candidate.CounterpartUpdatedUnixTime) {
				return nil, errors.New("loan transfer candidate snapshot is incomplete")
			}
		} else if candidate.Kind != loans.LEDGER_EVENT_KIND_EXPENSE || candidate.MaskedDestinationAccount != "" ||
			candidate.CounterpartUpdatedUnixTime != nil {
			return nil, errors.New("loan expense candidate contains a counterpart")
		}
		reasons, err := newPersonalFinanceLoanSettlementReasonResponses(candidate.ReasonCodes)
		if err != nil {
			return nil, err
		}
		responseGroup.Candidates = append(responseGroup.Candidates, &personalFinanceLoanSettlementCandidateResponse{
			TransactionId: candidate.TransactionId, TransactionType: candidate.Kind,
			TransactionDate: time.Unix(candidate.TransactionUnixTime, 0).In(location).Format(time.DateOnly), Amount: candidate.Amount,
			Currency: candidate.Currency, MaskedSourceAccount: candidate.MaskedSourceAccount,
			MaskedDestinationAccount: candidate.MaskedDestinationAccount, Eligible: candidate.Eligible, ReasonCodes: reasons,
			UpdatedUnixTime:            candidate.UpdatedUnixTime,
			CounterpartUpdatedUnixTime: clonePersonalFinanceLoanInt64(candidate.CounterpartUpdatedUnixTime)})
	}
	return &personalFinanceLoanSettlementCandidatesResponse{ContractId: value.ContractId,
		InstallmentId: clonePersonalFinanceLoanInt64(value.InstallmentId), Groups: []*personalFinanceLoanSettlementCandidateGroupResponse{responseGroup}}, nil
}

func newPersonalFinanceLoanSettlementActionResponse(value *loans.SettlementResult, expectedAction loans.ActionType,
	expectedContractId int64, expectedContractVersion int64) (*personalFinanceLoanActionResponse, error) {
	if value == nil || value.Action == nil || value.Action.ActionType != expectedAction ||
		value.Action.ContractId != expectedContractId || value.Action.ExpectedContractVersion != expectedContractVersion ||
		expectedContractId < 1 || expectedContractVersion < 1 ||
		(expectedAction != loans.ACTION_TYPE_APPLY_SETTLEMENT && expectedAction != loans.ACTION_TYPE_REVERSE_SETTLEMENT) {
		return nil, errors.New("loan settlement action result is invalid")
	}
	response, err := newPersonalFinanceLoanActionResponse(&loans.CommandResult{Action: value.Action, Replayed: value.Replayed})
	if err != nil || response.Status != loans.ACTION_STATUS_APPLIED || len(value.Allocations) < 1 || len(value.Allocations) > 3 {
		return nil, errors.New("loan settlement action is incomplete")
	}
	responseReasons, err := newPersonalFinanceLoanSettlementReasonResponses(value.ReasonCodes)
	if err != nil {
		return nil, err
	}
	expectedReasons := make(map[loans.ServiceErrorCode]struct{})
	for _, reason := range value.Action.ReasonCodes {
		expectedReasons[reason] = struct{}{}
	}
	allocations := make([]*personalFinanceLoanSettlementAllocationResponse, 0, len(value.Allocations))
	seenAllocationIds := make(map[int64]struct{}, len(value.Allocations))
	seenTransactionIds := make(map[int64]struct{}, len(value.Allocations)*2)
	seenComponents := make(map[loans.ComponentType]struct{}, len(value.Allocations))
	reversedCount := int64(0)
	for _, allocation := range value.Allocations {
		mapped, mapErr := newPersonalFinanceLoanSettlementAllocationResponse(allocation)
		if mapErr != nil {
			return nil, mapErr
		}
		if _, duplicate := seenAllocationIds[mapped.Id]; duplicate {
			return nil, errors.New("loan settlement allocation is duplicated")
		}
		seenAllocationIds[mapped.Id] = struct{}{}
		if _, duplicate := seenComponents[mapped.ComponentType]; duplicate {
			return nil, errors.New("loan settlement allocation component is duplicated")
		}
		seenComponents[mapped.ComponentType] = struct{}{}
		for _, transactionId := range []int64{mapped.TransactionId, valueOrZeroPersonalFinanceLoanId(mapped.CounterpartTransactionId)} {
			if transactionId < 1 {
				continue
			}
			if _, duplicate := seenTransactionIds[transactionId]; duplicate {
				return nil, errors.New("loan settlement transaction is duplicated")
			}
			seenTransactionIds[transactionId] = struct{}{}
		}
		for _, reason := range allocation.ReasonCodes {
			expectedReasons[reason] = struct{}{}
		}
		if allocation.Status == loans.ALLOCATION_STATUS_REVERSED {
			reversedCount++
		}
		allocations = append(allocations, mapped)
	}
	actualReasons := make(map[loans.ServiceErrorCode]struct{}, len(value.ReasonCodes))
	for _, reason := range value.ReasonCodes {
		actualReasons[reason] = struct{}{}
	}
	if len(actualReasons) != len(expectedReasons) {
		return nil, errors.New("loan settlement result reasons are inconsistent")
	}
	for reason := range expectedReasons {
		if _, exists := actualReasons[reason]; !exists {
			return nil, errors.New("loan settlement result reason is missing")
		}
	}
	if expectedAction == loans.ACTION_TYPE_APPLY_SETTLEMENT && value.ReversedAllocationCount != 0 ||
		expectedAction == loans.ACTION_TYPE_REVERSE_SETTLEMENT && (value.ReversedAllocationCount != int64(len(value.Allocations)) || reversedCount != int64(len(value.Allocations))) {
		return nil, errors.New("loan settlement reversal count is inconsistent")
	}
	response.Allocations = allocations
	response.ReasonCodes = responseReasons
	return response, nil
}

func personalFinanceLoanSettlementApplyResponseMatchesRequest(response *personalFinanceLoanActionResponse,
	request loans.ApplySettlementRequest) bool {
	if response == nil || len(response.Allocations) != len(request.Components) {
		return false
	}
	expected := make(map[loans.ComponentType]int64, len(request.Components))
	for _, component := range request.Components {
		if _, duplicate := expected[component.ComponentType]; duplicate {
			return false
		}
		expected[component.ComponentType] = component.AllocatedAmount
	}
	for _, allocation := range response.Allocations {
		amount, exists := expected[allocation.ComponentType]
		if !exists || amount != allocation.AllocatedAmount ||
			!equalPersonalFinanceLoanOptionalId(allocation.InstallmentId, request.InstallmentId) {
			return false
		}
		delete(expected, allocation.ComponentType)
	}
	return len(expected) == 0
}

func newPersonalFinanceLoanSettlementAllocationResponse(value *loans.SettlementAllocationResult) (*personalFinanceLoanSettlementAllocationResponse, error) {
	if value == nil || value.AllocationId < 1 || value.TransactionId < 1 || !isPersonalFinanceLoanComponentType(value.ComponentType) ||
		!isPersonalFinanceLoanAmount(value.AllocatedAmount, true) || !isPersonalFinanceLoanAllocationCreationMethod(value.CreationMethod) ||
		!isPersonalFinanceLoanAllocationStatus(value.Status) || value.TransactionUpdatedUnixTime < 1 ||
		!isPersonalFinanceLoanSafeNumber(value.TransactionUpdatedUnixTime) || value.CreatedUnixTime < 1 ||
		!isPersonalFinanceLoanSafeNumber(value.CreatedUnixTime) || value.UpdatedUnixTime < value.CreatedUnixTime ||
		!isPersonalFinanceLoanSafeNumber(value.UpdatedUnixTime) {
		return nil, errors.New("loan settlement allocation is invalid")
	}
	transfer := isPersonalFinanceLoanTransferComponent(value.ComponentType)
	if (value.ComponentType == loans.COMPONENT_TYPE_DISBURSEMENT && value.InstallmentId != nil) ||
		((value.ComponentType == loans.COMPONENT_TYPE_PRINCIPAL || value.ComponentType == loans.COMPONENT_TYPE_INTEREST) &&
			(value.InstallmentId == nil || *value.InstallmentId < 1)) ||
		(value.InstallmentId != nil && *value.InstallmentId < 1) {
		return nil, errors.New("loan settlement allocation installment is invalid")
	}
	if transfer {
		if value.CounterpartTransactionId == nil || *value.CounterpartTransactionId < 1 || value.CounterpartUpdatedUnixTime == nil ||
			*value.CounterpartUpdatedUnixTime < 1 || !isPersonalFinanceLoanSafeNumber(*value.CounterpartUpdatedUnixTime) {
			return nil, errors.New("loan settlement transfer allocation is incomplete")
		}
	} else if value.CounterpartTransactionId != nil || value.CounterpartUpdatedUnixTime != nil {
		return nil, errors.New("loan settlement expense allocation contains a counterpart")
	}
	reasons, err := newPersonalFinanceLoanSettlementReasonResponses(value.ReasonCodes)
	if err != nil || value.Status == loans.ALLOCATION_STATUS_ACTION_REQUIRED && len(reasons) == 0 ||
		value.Status == loans.ALLOCATION_STATUS_REVERSED && len(reasons) != 0 {
		return nil, errors.New("loan settlement allocation reasons are inconsistent")
	}
	return &personalFinanceLoanSettlementAllocationResponse{Id: value.AllocationId,
		InstallmentId: clonePersonalFinanceLoanInt64(value.InstallmentId), ComponentType: value.ComponentType,
		AllocatedAmount: value.AllocatedAmount, CreationMethod: value.CreationMethod, Status: value.Status,
		TransactionId: value.TransactionId, CounterpartTransactionId: clonePersonalFinanceLoanInt64(value.CounterpartTransactionId),
		TransactionUpdatedUnixTime: value.TransactionUpdatedUnixTime,
		CounterpartUpdatedUnixTime: clonePersonalFinanceLoanInt64(value.CounterpartUpdatedUnixTime), ReasonCodes: reasons,
		CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime}, nil
}

func newPersonalFinanceLoanSettlementUndoImpactResponse(value *loans.SettlementUndoImpact,
	request *loans.SettlementUndoImpactRequest) (*personalFinanceLoanSettlementUndoImpactResponse, error) {
	if value == nil || request == nil || value.ContractId != request.ContractId || value.ApplyActionId != request.ApplyActionId {
		return nil, errors.New("loan settlement undo impact is invalid")
	}
	counts := []int64{value.ActiveAllocationCount, value.RelationshipCount, value.AffectedTransactionCount,
		value.LoanCreatedTransactionCount, value.ModifiedTransactionCount, value.MissingTransactionCount, value.IncompleteTransferPairCount}
	for _, count := range counts {
		if !isPersonalFinanceLoanSafeNumber(count) {
			return nil, errors.New("loan settlement undo impact count is invalid")
		}
	}
	if value.ActiveAllocationCount > value.RelationshipCount || value.AffectedTransactionCount > value.RelationshipCount ||
		value.LoanCreatedTransactionCount > value.RelationshipCount ||
		value.ModifiedTransactionCount+value.MissingTransactionCount+value.IncompleteTransferPairCount > value.RelationshipCount ||
		value.CanUndoRelationships && value.ActiveAllocationCount == 0 {
		return nil, errors.New("loan settlement undo impact counts are inconsistent")
	}
	reasons, err := newPersonalFinanceLoanSettlementReasonResponses(value.ReasonCodes)
	if err != nil {
		return nil, err
	}
	blockingReason := false
	for _, reason := range value.ReasonCodes {
		if reason == loans.SERVICE_ERROR_SETTLEMENT_NOT_FOUND || reason == loans.SERVICE_ERROR_ALLOCATION_LIMIT ||
			reason == loans.SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED || reason == loans.SERVICE_ERROR_BINDING_CONFLICT {
			blockingReason = true
		}
	}
	if value.CanUndoRelationships && blockingReason || !value.CanUndoRelationships && len(reasons) == 0 {
		return nil, errors.New("loan settlement undo eligibility is inconsistent")
	}
	return &personalFinanceLoanSettlementUndoImpactResponse{ContractId: value.ContractId, ActionId: value.ApplyActionId,
		ActiveAllocationCount: value.ActiveAllocationCount, RelationshipCount: value.RelationshipCount,
		AffectedTransactionCount: value.AffectedTransactionCount, LoanCreatedTransactionCount: value.LoanCreatedTransactionCount,
		ModifiedTransactionCount: value.ModifiedTransactionCount, MissingTransactionCount: value.MissingTransactionCount,
		IncompleteTransferPairCount: value.IncompleteTransferPairCount, CanUndoRelationships: value.CanUndoRelationships,
		ReasonCodes: reasons}, nil
}

func (a *PersonalFinanceLoansApi) logSettlementServiceFailure(c *core.WebContext, operation string, contractId int64, actionId int64, err error) {
	code := loans.ServiceErrorCodeOf(err)
	if actionId > 0 {
		log.Warnf(c, "[personal_finance_loans.%s] failed for user \"uid:%d\", contract \"id:%d\", action \"id:%d\" and code \"%s\"",
			operation, c.GetCurrentUid(), contractId, actionId, code)
		return
	}
	log.Warnf(c, "[personal_finance_loans.%s] failed for user \"uid:%d\", contract \"id:%d\" and code \"%s\"",
		operation, c.GetCurrentUid(), contractId, code)
}

func equalPersonalFinanceLoanOptionalId(left *int64, right *int64) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func isPersonalFinanceLoanComponentType(value loans.ComponentType) bool {
	return value == loans.COMPONENT_TYPE_DISBURSEMENT || value == loans.COMPONENT_TYPE_PRINCIPAL ||
		value == loans.COMPONENT_TYPE_INTEREST || value == loans.COMPONENT_TYPE_FEE
}

func isPersonalFinanceLoanTransferComponent(value loans.ComponentType) bool {
	return value == loans.COMPONENT_TYPE_DISBURSEMENT || value == loans.COMPONENT_TYPE_PRINCIPAL
}

func isPersonalFinanceLoanAllocationCreationMethod(value loans.AllocationCreationMethod) bool {
	return value == loans.ALLOCATION_CREATION_METHOD_ATTACHED_EXISTING || value == loans.ALLOCATION_CREATION_METHOD_LOAN_CREATED
}

func isPersonalFinanceLoanAllocationStatus(value loans.AllocationStatus) bool {
	return value == loans.ALLOCATION_STATUS_ACTIVE || value == loans.ALLOCATION_STATUS_REVERSED ||
		value == loans.ALLOCATION_STATUS_ACTION_REQUIRED
}

func newPersonalFinanceLoanSettlementReasonResponses(values []loans.ServiceErrorCode) ([]*personalFinanceLoanReasonResponse, error) {
	seen := make(map[loans.ServiceErrorCode]struct{}, len(values))
	reasons := make([]*personalFinanceLoanReasonResponse, 0, len(values))
	for _, code := range values {
		if !isPersonalFinanceLoanSettlementReasonCode(code) {
			return nil, errors.New("loan settlement reason is not stable")
		}
		if _, duplicate := seen[code]; duplicate {
			return nil, errors.New("loan settlement reason is duplicated")
		}
		seen[code] = struct{}{}
		reasons = append(reasons, &personalFinanceLoanReasonResponse{Code: string(code)})
	}
	return reasons, nil
}

func isPersonalFinanceLoanSettlementReasonCode(value loans.ServiceErrorCode) bool {
	switch value {
	case loans.SERVICE_ERROR_LEDGER_VALIDATION_REQUIRED, loans.SERVICE_ERROR_INSTALLMENT_NOT_FOUND,
		loans.SERVICE_ERROR_REVISION_MISMATCH, loans.SERVICE_ERROR_COMPONENT_MISMATCH, loans.SERVICE_ERROR_AMOUNT_EXCEEDED,
		loans.SERVICE_ERROR_LEDGER_EVENT_MISSING, loans.SERVICE_ERROR_LEDGER_EVENT_MODIFIED, loans.SERVICE_ERROR_LEDGER_EVENT_TYPE,
		loans.SERVICE_ERROR_LEDGER_EVENT_ACCOUNT, loans.SERVICE_ERROR_LEDGER_EVENT_CURRENCY, loans.SERVICE_ERROR_LEDGER_EVENT_AMOUNT,
		loans.SERVICE_ERROR_LEDGER_CATEGORY, loans.SERVICE_ERROR_TRANSFER_INCOMPLETE, loans.SERVICE_ERROR_BINDING_CONFLICT,
		loans.SERVICE_ERROR_SETTLEMENT_NOT_FOUND, loans.SERVICE_ERROR_SETTLEMENT_ALREADY_REVERSED, loans.SERVICE_ERROR_ALLOCATION_LIMIT:
		return true
	default:
		return false
	}
}

func isPersonalFinanceLoanMaskedAccount(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 64 || strings.IndexByte(value, 0) >= 0 {
		return false
	}
	prefix, suffix, found := strings.Cut(value, "-**")
	if !found || (prefix != string(loans.ACCOUNT_KIND_ASSET) && prefix != string(loans.ACCOUNT_KIND_DEBT) &&
		prefix != string(loans.ACCOUNT_KIND_CREDIT_CARD)) || len(suffix) != 4 {
		return false
	}
	for _, char := range suffix {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func valueOrZeroPersonalFinanceLoanId(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
