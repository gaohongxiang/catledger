package api

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/errs"
	"github.com/gaohongxiang/catledger/pkg/log"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/organizer"
)

const (
	personalFinanceOrganizerDefaultListLimit = 20
	personalFinanceOrganizerMaximumListLimit = 100
)

type PersonalFinanceOrganizerApplication interface {
	CreateUpdate(c core.Context, uid int64, batchIds []int64, idempotencyKey string) (*organizerUpdateDetail, error)
	ListUpdates(c core.Context, uid int64, status organizer.UpdateStatus, cursor *organizer.UpdateCursor, limit int) (*organizer.UpdatePage, error)
	GetUpdate(c core.Context, uid int64, updateId int64) (*organizerUpdateDetail, error)
	Organize(c core.Context, request organizer.OrganizeRequest) (*organizer.OrganizeResult, error)
	Abandon(c core.Context, request organizer.AbandonRequest) (*organizer.AbandonResult, error)
	ListEvents(c core.Context, uid int64, updateId int64, status organizer.EventStatus, cursor *organizer.EventCursor, limit int) (*organizerEventPage, error)
	GetEventEvidence(c core.Context, uid int64, eventId int64) (*organizerEventEvidenceDetail, error)
	InspectEventCorrection(c core.Context, uid int64, updateId int64, eventId int64) (*organizer.UndoImpact, error)
	InspectCategoryCorrectionScope(c core.Context, uid int64, updateId int64, eventId int64) (*organizer.CategoryCorrectionScopePreview, error)
	CorrectEvent(c core.Context, request organizer.CorrectEventRequest) (*organizerMutationResult, error)
	Post(c core.Context, request organizer.PostRequest) (*organizer.PostResult, error)
	InspectUndo(c core.Context, uid int64, updateId int64) (*organizer.UndoImpact, error)
	Undo(c core.Context, request organizer.UndoRequest) (*organizer.UndoResult, error)
}

type PersonalFinanceOrganizerApi struct {
	application PersonalFinanceOrganizerApplication
}

var PersonalFinanceOrganizer *PersonalFinanceOrganizerApi

func NewPersonalFinanceOrganizerApi(application PersonalFinanceOrganizerApplication) (*PersonalFinanceOrganizerApi, error) {
	if application == nil {
		return nil, errors.New("personal finance organizer application is required")
	}
	return &PersonalFinanceOrganizerApi{application: application}, nil
}

type organizerUpdateDetail struct {
	Update  *organizer.FinanceUpdate
	Sources []*organizer.FinanceUpdateSource
}

type organizerEventEvidenceDetail struct {
	Event     *organizer.EconomicEvent
	Evidence  []*organizer.EconomicEventEvidence
	Rows      []*importing.RawImportRow
	Relations []*organizer.EconomicEventRelation
	Links     []*organizer.EconomicEventTransaction
}

type organizerEventSummary struct {
	Counterparty  string
	Item          string
	PaymentMethod string
	Note          string
	EvidenceCount int64
}

type organizerEventListItem struct {
	Event   *organizer.EconomicEvent
	Summary organizerEventSummary
}

type organizerEventPage struct {
	Items      []*organizerEventListItem
	NextCursor *organizer.EventCursor
}

type organizerMutationResult struct {
	Update   *organizer.FinanceUpdate
	Event    *organizer.EconomicEvent
	Events   []*organizer.EconomicEvent
	Action   *organizer.FinanceAction
	Impact   *organizer.UndoImpact
	Replayed bool
}

type personalFinanceOrganizerCreateRequest struct {
	BatchIds       []string `json:"batchIds"`
	IdempotencyKey string   `json:"idempotencyKey"`
}

type personalFinanceOrganizerActionRequest struct {
	UpdateId              int64  `json:"updateId,string"`
	ExpectedUpdateVersion int64  `json:"expectedUpdateVersion"`
	IdempotencyKey        string `json:"idempotencyKey"`
}

type personalFinanceOrganizerCorrectRequest struct {
	UpdateId                    int64                             `json:"updateId,string"`
	EventId                     int64                             `json:"eventId,string"`
	ExpectedUpdateVersion       int64                             `json:"expectedUpdateVersion"`
	ExpectedEventVersion        int64                             `json:"expectedEventVersion"`
	IdempotencyKey              string                            `json:"idempotencyKey"`
	CategoryScope               organizer.CategoryCorrectionScope `json:"categoryScope"`
	FieldMask                   int64                             `json:"fieldMask"`
	Status                      organizer.EventStatus             `json:"status"`
	FlowDirection               organizer.FlowDirection           `json:"flowDirection"`
	EconomicNature              organizer.EconomicNature          `json:"economicNature"`
	LedgerAccountId             *int64                            `json:"ledgerAccountId,string"`
	CounterpartyLedgerAccountId *int64                            `json:"counterpartyLedgerAccountId,string"`
	EventUnixTime               *int64                            `json:"eventUnixTime"`
	TimezoneUtcOffset           *int16                            `json:"timezoneUtcOffset"`
	Amount                      *int64                            `json:"amount,string"`
	Currency                    string                            `json:"currency"`
	CategoryId                  *int64                            `json:"categoryId,string"`
}

type personalFinanceOrganizerSourceResponse struct {
	Id                   string  `json:"id"`
	FileId               string  `json:"fileId"`
	BatchId              string  `json:"batchId"`
	SourceOrder          int64   `json:"sourceOrder"`
	SourceAccountId      *string `json:"sourceAccountId"`
	SourceType           string  `json:"sourceType"`
	ParserVersion        string  `json:"parserVersion"`
	NormalizationVersion string  `json:"normalizationVersion"`
	IdentityKeyVersion   string  `json:"identityKeyVersion"`
}

type personalFinanceOrganizerUpdateResponse struct {
	Id                     string                                    `json:"id"`
	Status                 organizer.UpdateStatus                    `json:"status"`
	Version                int64                                     `json:"version"`
	PlanVersion            organizer.RuleVersion                     `json:"planVersion"`
	CurrentActionId        *string                                   `json:"currentActionId"`
	SourceCount            int64                                     `json:"sourceCount"`
	ValidEvidenceCount     int64                                     `json:"validEvidenceCount"`
	DuplicateEvidenceCount int64                                     `json:"duplicateEvidenceCount"`
	FinalEventCount        int64                                     `json:"finalEventCount"`
	PostedEventCount       int64                                     `json:"postedEventCount"`
	ReadyEventCount        int64                                     `json:"readyEventCount"`
	NeedsActionEventCount  int64                                     `json:"needsActionEventCount"`
	ExcludedEventCount     int64                                     `json:"excludedEventCount"`
	ErrorCode              string                                    `json:"errorCode"`
	CreatedUnixTime        int64                                     `json:"createdUnixTime"`
	UpdatedUnixTime        int64                                     `json:"updatedUnixTime"`
	Sources                []*personalFinanceOrganizerSourceResponse `json:"sources,omitempty"`
}

type personalFinanceOrganizerUpdateListResponse struct {
	Items      []*personalFinanceOrganizerUpdateResponse `json:"items"`
	NextCursor *personalFinanceOrganizerCursorResponse   `json:"nextCursor"`
}

type personalFinanceOrganizerCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	UpdateId        string `json:"updateId"`
}

type personalFinanceOrganizerEventCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	EventId         string `json:"eventId"`
}

type personalFinanceOrganizerEventListResponse struct {
	Items      []*personalFinanceOrganizerEventResponse     `json:"items"`
	NextCursor *personalFinanceOrganizerEventCursorResponse `json:"nextCursor"`
}

type personalFinanceOrganizerEventResponse struct {
	Id                          string                   `json:"id"`
	UpdateId                    string                   `json:"updateId"`
	Status                      organizer.EventStatus    `json:"status"`
	Version                     int64                    `json:"version"`
	FlowDirection               organizer.FlowDirection  `json:"flowDirection"`
	EconomicNature              organizer.EconomicNature `json:"economicNature"`
	LedgerAccountId             *string                  `json:"ledgerAccountId"`
	CounterpartyLedgerAccountId *string                  `json:"counterpartyLedgerAccountId"`
	EventUnixTime               *int64                   `json:"eventUnixTime"`
	TimezoneUtcOffset           *int16                   `json:"timezoneUtcOffset"`
	Amount                      *string                  `json:"amount"`
	Currency                    string                   `json:"currency"`
	CategoryId                  *string                  `json:"categoryId"`
	ManualFieldMask             int64                    `json:"manualFieldMask"`
	FieldSourcesJson            string                   `json:"fieldSourcesJson"`
	ReasonCodesJson             string                   `json:"reasonCodesJson"`
	CreatedUnixTime             int64                    `json:"createdUnixTime"`
	UpdatedUnixTime             int64                    `json:"updatedUnixTime"`
	Counterparty                string                   `json:"counterparty"`
	Item                        string                   `json:"item"`
	PaymentMethod               string                   `json:"paymentMethod"`
	Note                        string                   `json:"note"`
	EvidenceCount               int64                    `json:"evidenceCount"`
}

type personalFinanceOrganizerActionResponse struct {
	Id                   string                 `json:"id"`
	UpdateId             string                 `json:"updateId"`
	ActionType           organizer.ActionType   `json:"actionType"`
	Status               organizer.ActionStatus `json:"status"`
	AppliedUpdateVersion int64                  `json:"appliedUpdateVersion"`
	ReasonCodesJson      string                 `json:"reasonCodesJson"`
	ErrorCode            string                 `json:"errorCode"`
	CreatedUnixTime      int64                  `json:"createdUnixTime"`
	UpdatedUnixTime      int64                  `json:"updatedUnixTime"`
}

type personalFinanceOrganizerImpactResponse struct {
	SafeToApply                 bool     `json:"safeToApply"`
	PostedEventCount            int64    `json:"postedEventCount"`
	TransactionCount            int64    `json:"transactionCount"`
	MissingTransactionCount     int64    `json:"missingTransactionCount"`
	ModifiedTransactionCount    int64    `json:"modifiedTransactionCount"`
	SharedTransactionCount      int64    `json:"sharedTransactionCount"`
	BatchRelationCount          int64    `json:"batchRelationCount"`
	DebtRelationCount           int64    `json:"debtRelationCount"`
	IncompleteTransferPairCount int64    `json:"incompleteTransferPairCount"`
	ReasonCodes                 []string `json:"reasonCodes"`
}

type personalFinanceOrganizerCategoryScopeResponse struct {
	MatchingEventCount int64 `json:"matchingEventCount"`
}

type personalFinanceOrganizerMutationResponse struct {
	Update   *personalFinanceOrganizerUpdateResponse  `json:"update"`
	Event    *personalFinanceOrganizerEventResponse   `json:"event,omitempty"`
	Events   []*personalFinanceOrganizerEventResponse `json:"events,omitempty"`
	Action   *personalFinanceOrganizerActionResponse  `json:"action"`
	Impact   *personalFinanceOrganizerImpactResponse  `json:"impact,omitempty"`
	Replayed bool                                     `json:"replayed"`
}

type personalFinanceOrganizerEvidenceResponse struct {
	Id           string                                  `json:"id"`
	RowId        string                                  `json:"rowId"`
	EvidenceRole organizer.EvidenceRole                  `json:"evidenceRole"`
	FieldMask    int64                                   `json:"fieldMask"`
	Row          *personalFinanceOrganizerRawRowResponse `json:"row"`
}

type personalFinanceOrganizerRawRowResponse struct {
	Id              string          `json:"id"`
	BatchId         string          `json:"batchId"`
	RowNumber       int64           `json:"rowNumber"`
	SourceLocator   string          `json:"sourceLocator"`
	UnixTime        *int64          `json:"unixTime"`
	Amount          *string         `json:"amount"`
	Currency        string          `json:"currency"`
	Direction       string          `json:"direction"`
	TransactionType string          `json:"transactionType"`
	Counterparty    string          `json:"counterparty"`
	Item            string          `json:"item"`
	PaymentMethod   string          `json:"paymentMethod"`
	Note            string          `json:"note"`
	RawFields       json.RawMessage `json:"rawFields"`
}

type personalFinanceOrganizerEventEvidenceResponse struct {
	Event        *personalFinanceOrganizerEventResponse         `json:"event"`
	Evidence     []*personalFinanceOrganizerEvidenceResponse    `json:"evidence"`
	Relations    []*personalFinanceOrganizerRelationResponse    `json:"relations"`
	Transactions []*personalFinanceOrganizerTransactionResponse `json:"transactions"`
}

type personalFinanceOrganizerRelationResponse struct {
	Id              string                   `json:"id"`
	Type            organizer.RelationType   `json:"type"`
	Status          organizer.RelationStatus `json:"status"`
	Version         int64                    `json:"version"`
	SourceEventId   string                   `json:"sourceEventId"`
	TargetEventId   string                   `json:"targetEventId"`
	Amount          *string                  `json:"amount"`
	Currency        string                   `json:"currency"`
	Manual          bool                     `json:"manual"`
	ReasonCodesJson string                   `json:"reasonCodesJson"`
}

type personalFinanceOrganizerTransactionResponse struct {
	Id                         string                         `json:"id"`
	TransactionId              string                         `json:"transactionId"`
	Role                       organizer.EventTransactionRole `json:"role"`
	TransactionUpdatedUnixTime int64                          `json:"transactionUpdatedUnixTime"`
}

func (a *PersonalFinanceOrganizerApi) UpdateCreateHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceOrganizerCreateRequest)
	if !a.available(c) || decodePersonalFinanceLoanJSON(c, request) != nil {
		return nil, errs.ErrParameterInvalid
	}
	batchIds, ok := parseOrganizerIDs(request.BatchIds)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.CreateUpdate(c, c.GetCurrentUid(), batchIds, request.IdempotencyKey)
	if err != nil {
		return a.failed(c, "create_update", err)
	}
	return newOrganizerUpdateDetailResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) UpdateListHandler(c *core.WebContext) (any, *errs.Error) {
	if !a.available(c) || !personalFinanceInstallmentQueryAllowed(c, "status", "limit", "cursor_updated_unix_time", "cursor_update_id") {
		return nil, errs.ErrParameterInvalid
	}
	status := organizer.UpdateStatus(strings.TrimSpace(c.Query("status")))
	if !organizerUpdateStatusAllowed(status) {
		return nil, errs.ErrParameterInvalid
	}
	limit, cursor, ok := parseOrganizerUpdatePage(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.ListUpdates(c, c.GetCurrentUid(), status, cursor, limit)
	if err != nil {
		return a.failed(c, "list_updates", err)
	}
	return newOrganizerUpdateListResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) UpdateGetHandler(c *core.WebContext) (any, *errs.Error) {
	updateId, ok := parseOrganizerIDQuery(c, "id")
	if !a.available(c) || !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.GetUpdate(c, c.GetCurrentUid(), updateId)
	if err != nil {
		return a.failed(c, "get_update", err)
	}
	return newOrganizerUpdateDetailResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) UpdateOrganizeHandler(c *core.WebContext) (any, *errs.Error) {
	request, ok := a.actionRequest(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.Organize(c, organizer.OrganizeRequest{Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		return a.failed(c, "organize", err)
	}
	return &personalFinanceOrganizerMutationResponse{Update: newOrganizerUpdateResponse(result.Update), Events: newOrganizerEventResponses(result.Events), Action: newOrganizerActionResponse(result.Action), Replayed: result.Replayed}, nil
}

func (a *PersonalFinanceOrganizerApi) UpdateAbandonHandler(c *core.WebContext) (any, *errs.Error) {
	request, ok := a.actionRequest(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.Abandon(c, organizer.AbandonRequest{Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		return a.failed(c, "abandon", err)
	}
	return &personalFinanceOrganizerMutationResponse{Update: newOrganizerUpdateResponse(result.Update), Action: newOrganizerActionResponse(result.Action), Replayed: result.Replayed}, nil
}

func (a *PersonalFinanceOrganizerApi) EventListHandler(c *core.WebContext) (any, *errs.Error) {
	if !a.available(c) || !personalFinanceInstallmentQueryAllowed(c, "update_id", "status", "limit", "cursor_updated_unix_time", "cursor_event_id") {
		return nil, errs.ErrParameterInvalid
	}
	updateId, err := strconv.ParseInt(strings.TrimSpace(c.Query("update_id")), 10, 64)
	if err != nil || updateId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	limit, cursor, ok := parseOrganizerEventPage(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	status := organizer.EventStatus(strings.TrimSpace(c.Query("status")))
	if status != "" && !organizerEventStatusAllowed(status) {
		return nil, errs.ErrParameterInvalid
	}
	page, listErr := a.application.ListEvents(c, c.GetCurrentUid(), updateId, status, cursor, limit)
	if listErr != nil {
		return a.failed(c, "list_events", listErr)
	}
	return newOrganizerEventListResponse(page), nil
}

func (a *PersonalFinanceOrganizerApi) EventEvidenceHandler(c *core.WebContext) (any, *errs.Error) {
	eventId, ok := parseOrganizerIDQuery(c, "id")
	if !a.available(c) || !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.GetEventEvidence(c, c.GetCurrentUid(), eventId)
	if err != nil {
		return a.failed(c, "event_evidence", err)
	}
	return newOrganizerEventEvidenceResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) EventCorrectionImpactHandler(c *core.WebContext) (any, *errs.Error) {
	if !a.available(c) || !personalFinanceInstallmentQueryAllowed(c, "update_id", "event_id") {
		return nil, errs.ErrParameterInvalid
	}
	updateId, updateErr := strconv.ParseInt(strings.TrimSpace(c.Query("update_id")), 10, 64)
	eventId, eventErr := strconv.ParseInt(strings.TrimSpace(c.Query("event_id")), 10, 64)
	if updateErr != nil || eventErr != nil || updateId < 1 || eventId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	impact, err := a.application.InspectEventCorrection(c, c.GetCurrentUid(), updateId, eventId)
	if err != nil {
		return a.failed(c, "correction_impact", err)
	}
	return newOrganizerImpactResponse(impact), nil
}

func (a *PersonalFinanceOrganizerApi) EventCategoryScopeHandler(c *core.WebContext) (any, *errs.Error) {
	if !a.available(c) || !personalFinanceInstallmentQueryAllowed(c, "update_id", "event_id") {
		return nil, errs.ErrParameterInvalid
	}
	updateId, updateErr := strconv.ParseInt(strings.TrimSpace(c.Query("update_id")), 10, 64)
	eventId, eventErr := strconv.ParseInt(strings.TrimSpace(c.Query("event_id")), 10, 64)
	if updateErr != nil || eventErr != nil || updateId < 1 || eventId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	preview, err := a.application.InspectCategoryCorrectionScope(c, c.GetCurrentUid(), updateId, eventId)
	if err != nil {
		return a.failed(c, "category_scope", err)
	}
	return newOrganizerCategoryScopeResponse(preview), nil
}

func (a *PersonalFinanceOrganizerApi) EventCorrectHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceOrganizerCorrectRequest)
	if !a.available(c) || decodePersonalFinanceLoanJSON(c, request) != nil {
		return nil, errs.ErrParameterInvalid
	}
	return a.correct(c, request)
}

func (a *PersonalFinanceOrganizerApi) EventExcludeHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceOrganizerCorrectRequest)
	if !a.available(c) || decodePersonalFinanceLoanJSON(c, request) != nil || !organizerExcludeRequestClean(request) {
		return nil, errs.ErrParameterInvalid
	}
	request.FieldMask = organizer.MANUAL_FIELD_STATUS
	request.Status = organizer.EVENT_STATUS_EXCLUDED
	return a.correct(c, request)
}

func (a *PersonalFinanceOrganizerApi) correct(c *core.WebContext, request *personalFinanceOrganizerCorrectRequest) (any, *errs.Error) {
	result, err := a.application.CorrectEvent(c, organizer.CorrectEventRequest{
		Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, EventId: request.EventId,
		ExpectedUpdateVersion: request.ExpectedUpdateVersion, ExpectedEventVersion: request.ExpectedEventVersion,
		IdempotencyKey: request.IdempotencyKey, CategoryScope: request.CategoryScope, Correction: organizer.EventCorrection{
			FieldMask: request.FieldMask, Status: request.Status, FlowDirection: request.FlowDirection,
			EconomicNature: request.EconomicNature, LedgerAccountId: request.LedgerAccountId,
			CounterpartyLedgerAccountId: request.CounterpartyLedgerAccountId, EventUnixTime: request.EventUnixTime,
			TimezoneUtcOffset: request.TimezoneUtcOffset, Amount: request.Amount, Currency: request.Currency, CategoryId: request.CategoryId,
		},
	})
	if err != nil {
		return a.failed(c, "correct_event", err)
	}
	return newOrganizerMutationResponse(result), nil
}

func (a *PersonalFinanceOrganizerApi) ActionPostAllReadyHandler(c *core.WebContext) (any, *errs.Error) {
	return a.post(c, organizer.POST_MODE_ALL_READY)
}

func (a *PersonalFinanceOrganizerApi) post(c *core.WebContext, mode organizer.PostMode) (any, *errs.Error) {
	request, ok := a.actionRequest(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.Post(c, organizer.PostRequest{Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, IdempotencyKey: request.IdempotencyKey, Mode: mode})
	if err != nil {
		return a.failed(c, string(mode), err)
	}
	return &personalFinanceOrganizerMutationResponse{Update: newOrganizerUpdateResponse(result.Update), Events: newOrganizerEventResponses(result.Events), Action: newOrganizerActionResponse(result.Action), Replayed: result.Replayed}, nil
}

func (a *PersonalFinanceOrganizerApi) ActionUndoImpactHandler(c *core.WebContext) (any, *errs.Error) {
	updateId, ok := parseOrganizerIDQuery(c, "update_id")
	if !a.available(c) || !ok {
		return nil, errs.ErrParameterInvalid
	}
	impact, err := a.application.InspectUndo(c, c.GetCurrentUid(), updateId)
	if err != nil {
		return a.failed(c, "undo_impact", err)
	}
	return newOrganizerImpactResponse(impact), nil
}

func (a *PersonalFinanceOrganizerApi) ActionUndoHandler(c *core.WebContext) (any, *errs.Error) {
	request, ok := a.actionRequest(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.Undo(c, organizer.UndoRequest{Uid: c.GetCurrentUid(), UpdateId: request.UpdateId, ExpectedUpdateVersion: request.ExpectedUpdateVersion, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		return a.failed(c, "undo", err)
	}
	return &personalFinanceOrganizerMutationResponse{Update: newOrganizerUpdateResponse(result.Update), Action: newOrganizerActionResponse(result.Action), Impact: newOrganizerImpactResponse(result.Impact), Replayed: result.Replayed}, nil
}

func (a *PersonalFinanceOrganizerApi) available(c *core.WebContext) bool {
	return a != nil && a.application != nil && c != nil && c.Request != nil
}

func (a *PersonalFinanceOrganizerApi) actionRequest(c *core.WebContext) (*personalFinanceOrganizerActionRequest, bool) {
	request := new(personalFinanceOrganizerActionRequest)
	return request, a.available(c) && decodePersonalFinanceLoanJSON(c, request) == nil
}

func (a *PersonalFinanceOrganizerApi) failed(c *core.WebContext, operation string, err error) (any, *errs.Error) {
	log.Warnf(c, "[personal_finance_organizer.%s] failed for user \"uid:%d\"", operation, c.GetCurrentUid())
	return nil, personalFinanceOrganizerServiceError(err)
}

func parseOrganizerIDs(raw []string) ([]int64, bool) {
	if len(raw) < 1 || len(raw) > personalFinanceOrganizerMaximumListLimit {
		return nil, false
	}
	ids := make([]int64, 0, len(raw))
	seen := make(map[int64]struct{}, len(raw))
	for _, value := range raw {
		id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || id < 1 {
			return nil, false
		}
		if _, exists := seen[id]; exists {
			return nil, false
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, true
}

func organizerUpdateStatusAllowed(status organizer.UpdateStatus) bool {
	switch status {
	case organizer.UPDATE_STATUS_DRAFT, organizer.UPDATE_STATUS_ORGANIZING, organizer.UPDATE_STATUS_REVIEW,
		organizer.UPDATE_STATUS_POSTING, organizer.UPDATE_STATUS_POSTED,
		organizer.UPDATE_STATUS_FAILED, organizer.UPDATE_STATUS_UNDONE, organizer.UPDATE_STATUS_ABANDONED:
		return true
	default:
		return false
	}
}

func organizerEventStatusAllowed(status organizer.EventStatus) bool {
	switch status {
	case organizer.EVENT_STATUS_READY, organizer.EVENT_STATUS_NEEDS_ACTION, organizer.EVENT_STATUS_EXCLUDED,
		organizer.EVENT_STATUS_POSTED, organizer.EVENT_STATUS_CORRECTED:
		return true
	default:
		return false
	}
}

func organizerExcludeRequestClean(request *personalFinanceOrganizerCorrectRequest) bool {
	return request != nil && request.FieldMask == 0 && request.Status == "" && request.FlowDirection == "" &&
		request.EconomicNature == "" && request.LedgerAccountId == nil && request.CounterpartyLedgerAccountId == nil &&
		request.EventUnixTime == nil && request.TimezoneUtcOffset == nil && request.Amount == nil &&
		request.Currency == "" && request.CategoryId == nil && request.CategoryScope == ""
}

func parseOrganizerIDQuery(c *core.WebContext, key string) (int64, bool) {
	if c == nil || !personalFinanceInstallmentQueryAllowed(c, key) {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimSpace(c.Query(key)), 10, 64)
	return id, err == nil && id > 0
}

func parseOrganizerUpdatePage(c *core.WebContext) (int, *organizer.UpdateCursor, bool) {
	limit := personalFinanceOrganizerDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > personalFinanceOrganizerMaximumListLimit {
			return 0, nil, false
		}
		limit = value
	}
	var cursor *organizer.UpdateCursor
	rawTime, rawId := strings.TrimSpace(c.Query("cursor_updated_unix_time")), strings.TrimSpace(c.Query("cursor_update_id"))
	if rawTime != "" || rawId != "" {
		updated, timeErr := strconv.ParseInt(rawTime, 10, 64)
		updateId, idErr := strconv.ParseInt(rawId, 10, 64)
		if timeErr != nil || idErr != nil || updated < 1 || updateId < 1 {
			return 0, nil, false
		}
		cursor = &organizer.UpdateCursor{UpdatedUnixTime: updated, UpdateId: updateId}
	}
	return limit, cursor, true
}

func parseOrganizerEventPage(c *core.WebContext) (int, *organizer.EventCursor, bool) {
	limit := personalFinanceOrganizerDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > personalFinanceOrganizerMaximumListLimit {
			return 0, nil, false
		}
		limit = value
	}
	var cursor *organizer.EventCursor
	rawTime, rawId := strings.TrimSpace(c.Query("cursor_updated_unix_time")), strings.TrimSpace(c.Query("cursor_event_id"))
	if rawTime != "" || rawId != "" {
		updated, timeErr := strconv.ParseInt(rawTime, 10, 64)
		eventId, idErr := strconv.ParseInt(rawId, 10, 64)
		if timeErr != nil || idErr != nil || updated < 1 || eventId < 1 {
			return 0, nil, false
		}
		cursor = &organizer.EventCursor{UpdatedUnixTime: updated, EventId: eventId}
	}
	return limit, cursor, true
}

func newOrganizerUpdateDetailResponse(detail *organizerUpdateDetail) *personalFinanceOrganizerUpdateResponse {
	if detail == nil {
		return nil
	}
	response := newOrganizerUpdateResponse(detail.Update)
	if response == nil {
		return nil
	}
	response.Sources = make([]*personalFinanceOrganizerSourceResponse, 0, len(detail.Sources))
	for _, source := range detail.Sources {
		if source == nil {
			continue
		}
		response.Sources = append(response.Sources, &personalFinanceOrganizerSourceResponse{
			Id: strconv.FormatInt(source.SourceId, 10), FileId: strconv.FormatInt(source.FileId, 10), BatchId: strconv.FormatInt(source.BatchId, 10),
			SourceOrder: source.SourceOrder, SourceAccountId: organizerStringId(source.SourceAccountId), SourceType: source.SourceTypeSnapshot,
			ParserVersion: string(source.ParserVersion), NormalizationVersion: string(source.NormalizationVersion), IdentityKeyVersion: string(source.IdentityKeyVersion),
		})
	}
	return response
}

func newOrganizerUpdateResponse(value *organizer.FinanceUpdate) *personalFinanceOrganizerUpdateResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceOrganizerUpdateResponse{
		Id: strconv.FormatInt(value.UpdateId, 10), Status: value.Status, Version: value.Version, PlanVersion: value.PlanVersion,
		CurrentActionId: organizerStringId(value.CurrentActionId), SourceCount: value.SourceCount, ValidEvidenceCount: value.ValidEvidenceCount,
		DuplicateEvidenceCount: value.DuplicateEvidenceCount, FinalEventCount: value.FinalEventCount, PostedEventCount: value.PostedEventCount,
		ReadyEventCount: value.ReadyEventCount, NeedsActionEventCount: value.NeedsActionEventCount, ExcludedEventCount: value.ExcludedEventCount,
		ErrorCode: value.ErrorCode, CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}

func newOrganizerUpdateListResponse(page *organizer.UpdatePage) *personalFinanceOrganizerUpdateListResponse {
	response := &personalFinanceOrganizerUpdateListResponse{Items: []*personalFinanceOrganizerUpdateResponse{}}
	if page == nil {
		return response
	}
	for _, item := range page.Items {
		response.Items = append(response.Items, newOrganizerUpdateResponse(item))
	}
	if page.NextCursor != nil {
		response.NextCursor = &personalFinanceOrganizerCursorResponse{UpdatedUnixTime: page.NextCursor.UpdatedUnixTime, UpdateId: strconv.FormatInt(page.NextCursor.UpdateId, 10)}
	}
	return response
}

func newOrganizerEventResponse(value *organizer.EconomicEvent) *personalFinanceOrganizerEventResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceOrganizerEventResponse{
		Id: strconv.FormatInt(value.EventId, 10), UpdateId: strconv.FormatInt(value.UpdateId, 10), Status: value.Status, Version: value.Version,
		FlowDirection: value.FlowDirection, EconomicNature: value.EconomicNature, LedgerAccountId: organizerStringId(value.LedgerAccountId),
		CounterpartyLedgerAccountId: organizerStringId(value.CounterpartyLedgerAccountId), EventUnixTime: value.EventUnixTime,
		TimezoneUtcOffset: value.TimezoneUtcOffset, Amount: organizerStringId(value.Amount), Currency: value.Currency,
		CategoryId: organizerStringId(value.CategoryId), ManualFieldMask: value.ManualFieldMask, FieldSourcesJson: value.FieldSourcesJson,
		ReasonCodesJson: value.ReasonCodesJson, CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}

func newOrganizerEventResponses(values []*organizer.EconomicEvent) []*personalFinanceOrganizerEventResponse {
	items := make([]*personalFinanceOrganizerEventResponse, 0, len(values))
	for _, value := range values {
		items = append(items, newOrganizerEventResponse(value))
	}
	return items
}

func newOrganizerEventListResponse(page *organizerEventPage) *personalFinanceOrganizerEventListResponse {
	response := &personalFinanceOrganizerEventListResponse{Items: []*personalFinanceOrganizerEventResponse{}}
	if page == nil {
		return response
	}
	for _, item := range page.Items {
		if item == nil {
			continue
		}
		event := newOrganizerEventResponse(item.Event)
		if event == nil {
			continue
		}
		event.Counterparty = item.Summary.Counterparty
		event.Item = item.Summary.Item
		event.PaymentMethod = item.Summary.PaymentMethod
		event.Note = item.Summary.Note
		event.EvidenceCount = item.Summary.EvidenceCount
		response.Items = append(response.Items, event)
	}
	if page.NextCursor != nil {
		response.NextCursor = &personalFinanceOrganizerEventCursorResponse{UpdatedUnixTime: page.NextCursor.UpdatedUnixTime, EventId: strconv.FormatInt(page.NextCursor.EventId, 10)}
	}
	return response
}

func newOrganizerActionResponse(value *organizer.FinanceAction) *personalFinanceOrganizerActionResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceOrganizerActionResponse{Id: strconv.FormatInt(value.ActionId, 10), UpdateId: strconv.FormatInt(value.UpdateId, 10), ActionType: value.ActionType, Status: value.Status, AppliedUpdateVersion: value.AppliedUpdateVersion, ReasonCodesJson: value.ReasonCodesJson, ErrorCode: value.ErrorCode, CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime}
}

func newOrganizerImpactResponse(value *organizer.UndoImpact) *personalFinanceOrganizerImpactResponse {
	if value == nil {
		return nil
	}
	reasons := value.ReasonCodes
	if reasons == nil {
		reasons = []string{}
	}
	return &personalFinanceOrganizerImpactResponse{SafeToApply: value.CanUndo, PostedEventCount: value.PostedEventCount, TransactionCount: value.TransactionCount, MissingTransactionCount: value.MissingTransactionCount, ModifiedTransactionCount: value.ModifiedTransactionCount, SharedTransactionCount: value.SharedTransactionCount, BatchRelationCount: value.BatchRelationCount, DebtRelationCount: value.DebtRelationCount, IncompleteTransferPairCount: value.IncompleteTransferPairCount, ReasonCodes: reasons}
}

func newOrganizerCategoryScopeResponse(value *organizer.CategoryCorrectionScopePreview) *personalFinanceOrganizerCategoryScopeResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceOrganizerCategoryScopeResponse{MatchingEventCount: value.MatchingEventCount}
}

func newOrganizerMutationResponse(value *organizerMutationResult) *personalFinanceOrganizerMutationResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceOrganizerMutationResponse{Update: newOrganizerUpdateResponse(value.Update), Event: newOrganizerEventResponse(value.Event), Action: newOrganizerActionResponse(value.Action), Impact: newOrganizerImpactResponse(value.Impact), Replayed: value.Replayed}
	if len(value.Events) > 0 {
		response.Events = newOrganizerEventResponses(value.Events)
	}
	return response
}

func newOrganizerEventEvidenceResponse(value *organizerEventEvidenceDetail) *personalFinanceOrganizerEventEvidenceResponse {
	if value == nil {
		return nil
	}
	rows := make(map[int64]*importing.RawImportRow, len(value.Rows))
	for _, row := range value.Rows {
		if row != nil {
			rows[row.RowId] = row
		}
	}
	response := &personalFinanceOrganizerEventEvidenceResponse{
		Event: newOrganizerEventResponse(value.Event), Evidence: []*personalFinanceOrganizerEvidenceResponse{},
		Relations:    make([]*personalFinanceOrganizerRelationResponse, 0, len(value.Relations)),
		Transactions: make([]*personalFinanceOrganizerTransactionResponse, 0, len(value.Links)),
	}
	for _, evidence := range value.Evidence {
		if evidence == nil {
			continue
		}
		response.Evidence = append(response.Evidence, &personalFinanceOrganizerEvidenceResponse{Id: strconv.FormatInt(evidence.EvidenceId, 10), RowId: strconv.FormatInt(evidence.RowId, 10), EvidenceRole: evidence.EvidenceRole, FieldMask: evidence.FieldMask, Row: newOrganizerRawRowResponse(rows[evidence.RowId])})
	}
	for _, relation := range value.Relations {
		if relation == nil {
			continue
		}
		response.Relations = append(response.Relations, &personalFinanceOrganizerRelationResponse{
			Id: strconv.FormatInt(relation.RelationId, 10), Type: relation.RelationType, Status: relation.Status,
			Version: relation.Version, SourceEventId: strconv.FormatInt(relation.SourceEventId, 10),
			TargetEventId: strconv.FormatInt(relation.TargetEventId, 10), Amount: organizerStringId(relation.Amount),
			Currency: relation.Currency, Manual: relation.Manual, ReasonCodesJson: relation.ReasonCodesJson,
		})
	}
	for _, link := range value.Links {
		if link == nil {
			continue
		}
		response.Transactions = append(response.Transactions, &personalFinanceOrganizerTransactionResponse{
			Id: strconv.FormatInt(link.LinkId, 10), TransactionId: strconv.FormatInt(link.TransactionId, 10),
			Role: link.Role, TransactionUpdatedUnixTime: link.TransactionUpdatedUnixTime,
		})
	}
	return response
}

func newOrganizerRawRowResponse(value *importing.RawImportRow) *personalFinanceOrganizerRawRowResponse {
	if value == nil {
		return nil
	}
	rawFields := json.RawMessage("[]")
	if json.Valid([]byte(value.RawFieldsJson)) {
		rawFields = json.RawMessage(value.RawFieldsJson)
	}
	return &personalFinanceOrganizerRawRowResponse{Id: strconv.FormatInt(value.RowId, 10), BatchId: strconv.FormatInt(value.BatchId, 10), RowNumber: value.RowNumber, SourceLocator: value.SourceLocator, UnixTime: value.NormalizedUnixTime, Amount: organizerStringId(value.NormalizedAmount), Currency: value.Currency, Direction: string(value.NormalizedDirection), TransactionType: string(value.NormalizedTransactionType), Counterparty: value.RawCounterparty, Item: value.RawItem, PaymentMethod: value.RawPaymentMethod, Note: value.RawNote, RawFields: rawFields}
}

func organizerStringId(value *int64) *string {
	if value == nil {
		return nil
	}
	formatted := strconv.FormatInt(*value, 10)
	return &formatted
}

func personalFinanceOrganizerServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, organizer.ErrCreateUpdateRequestInvalid), errors.Is(err, organizer.ErrCreateUpdateBatchNotFound),
		errors.Is(err, organizer.ErrCreateUpdateBatchNotReady), errors.Is(err, organizer.ErrOrganizeRequestInvalid),
		errors.Is(err, organizer.ErrOrganizeUpdateNotFound), errors.Is(err, organizer.ErrAbandonRequestInvalid),
		errors.Is(err, organizer.ErrAbandonUpdateNotFound),
		errors.Is(err, organizer.ErrPostRequestInvalid), errors.Is(err, organizer.ErrPostUpdateNotFound),
		errors.Is(err, organizer.ErrCorrectionRequestInvalid), errors.Is(err, organizer.ErrUndoRequestInvalid),
		errors.Is(err, organizer.ErrRebuildRequestInvalid):
		return errs.ErrParameterInvalid
	case errors.Is(err, organizer.ErrActionRequestConflict), errors.Is(err, organizer.ErrCreateUpdateStateConflict),
		errors.Is(err, organizer.ErrOrganizeVersionConflict), errors.Is(err, organizer.ErrAbandonVersionConflict),
		errors.Is(err, organizer.ErrOrganizeStateConflict), errors.Is(err, organizer.ErrAbandonStateConflict),
		errors.Is(err, organizer.ErrPostVersionConflict), errors.Is(err, organizer.ErrPostStateConflict),
		errors.Is(err, organizer.ErrPostUnresolvedEvents), errors.Is(err, organizer.ErrPostEventNotPostable),
		errors.Is(err, organizer.ErrCorrectionUpdateConflict), errors.Is(err, organizer.ErrCorrectionEventConflict),
		errors.Is(err, organizer.ErrUndoStateConflict), errors.Is(err, organizer.ErrRebuildStateConflict):
		return errs.ErrRepeatedRequest
	default:
		return errs.ErrOperationFailed
	}
}
