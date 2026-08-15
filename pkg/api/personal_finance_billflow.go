package api

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	personalFinanceBillflowDefaultListLimit = 20
	personalFinanceBillflowMaximumListLimit = 100
)

type PersonalFinanceBillflowApplication interface {
	CreateTask(c core.Context, request billflow.CreateTaskRequest) (*billflow.TaskView, error)
	ListTasks(c core.Context, uid int64, status billflow.TaskStatus, cursor *billflow.TaskCursor, limit int) (*billflow.TaskListResult, error)
	GetTask(c core.Context, uid int64, taskId int64) (*billflow.TaskView, error)
	GetTaskAccounts(c core.Context, uid int64, taskId int64) (*billflow.TaskAccountsView, error)
	CreateTaskAccount(c core.Context, request billflow.CreateAccountRequest) (*billflow.TaskAccountsView, error)
	OverrideTaskAccount(c core.Context, request billflow.OverrideAccountRequest) (*billflow.TaskAccountsView, error)
	RunTask(c core.Context, request billflow.RunTaskRequest, clientTimezone *time.Location) (*billflow.TaskView, error)
	ConfirmPost(c core.Context, request billflow.RunTaskRequest, clientTimezone *time.Location) (*billflow.TaskView, error)
	ListTodos(c core.Context, uid int64, taskId int64, status billflow.TodoStatus, cursor *billflow.TodoCursor, limit int) (*billflow.TodoListResult, error)
	ResolveTodo(c core.Context, request billflow.ResolveTodoRequest) (*billflow.TodoView, error)
	GetUndoImpact(c core.Context, uid int64, taskId int64) (*billflow.UndoImpactView, error)
	UndoTask(c core.Context, request billflow.UndoTaskRequest) (*billflow.TaskView, error)
}

var _ PersonalFinanceBillflowApplication = (*billflow.Service)(nil)

type PersonalFinanceBillflowApi struct {
	application PersonalFinanceBillflowApplication
}

func NewPersonalFinanceBillflowApi(application PersonalFinanceBillflowApplication) (*PersonalFinanceBillflowApi, error) {
	if application == nil {
		return nil, errors.New("personal finance billflow application is required")
	}
	return &PersonalFinanceBillflowApi{application: application}, nil
}

type personalFinanceBillflowCreateRequest struct {
	FileIds        []string `json:"fileIds"`
	IdempotencyKey string   `json:"idempotencyKey"`
}

type personalFinanceBillflowTaskActionRequest struct {
	TaskId          int64  `json:"taskId,string"`
	ExpectedVersion int64  `json:"expectedVersion"`
	IdempotencyKey  string `json:"idempotencyKey"`
}

type personalFinanceBillflowCreateAccountRequest struct {
	TaskId          int64                  `json:"taskId,string"`
	ExpectedVersion int64                  `json:"expectedVersion"`
	SampleRowId     int64                  `json:"sampleRowId,string"`
	Name            string                 `json:"name"`
	Category        models.AccountCategory `json:"category"`
	Currency        string                 `json:"currency"`
	IdempotencyKey  string                 `json:"idempotencyKey"`
}

type personalFinanceBillflowOverrideAccountRequest struct {
	TaskId          int64  `json:"taskId,string"`
	ExpectedVersion int64  `json:"expectedVersion"`
	SampleRowId     int64  `json:"sampleRowId,string"`
	LedgerAccountId int64  `json:"ledgerAccountId,string"`
	IdempotencyKey  string `json:"idempotencyKey"`
}

type personalFinanceBillflowResolveTodoRequest struct {
	TodoId          int64               `json:"todoId,string"`
	ExpectedVersion int64               `json:"expectedVersion"`
	Status          billflow.TodoStatus `json:"status"`
	IdempotencyKey  string              `json:"idempotencyKey"`
}

type personalFinanceBillflowMemberResponse struct {
	Id          string `json:"id"`
	FileId      string `json:"fileId"`
	BatchId     string `json:"batchId"`
	MemberOrder int64  `json:"memberOrder"`
}

type personalFinanceBillflowTaskResponse struct {
	Id                  string                                   `json:"id"`
	Status              billflow.TaskStatus                      `json:"status"`
	ConfirmPolicy       billflow.ConfirmPolicy                   `json:"confirmPolicy"`
	Version             int64                                    `json:"version"`
	CreatedAccountCount int64                                    `json:"createdAccountCount"`
	ReusedMappingCount  int64                                    `json:"reusedMappingCount"`
	AutoPostedCount     int64                                    `json:"autoPostedCount"`
	TodoOpenCount       int64                                    `json:"todoOpenCount"`
	ErrorCode           string                                   `json:"errorCode"`
	CreatedUnixTime     int64                                    `json:"createdUnixTime"`
	UpdatedUnixTime     int64                                    `json:"updatedUnixTime"`
	Members             []*personalFinanceBillflowMemberResponse `json:"members"`
}

type personalFinanceBillflowTaskListResponse struct {
	Items      []*personalFinanceBillflowTaskResponse     `json:"items"`
	NextCursor *personalFinanceBillflowTaskCursorResponse `json:"nextCursor"`
}

type personalFinanceBillflowTaskCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	TaskId          string `json:"taskId"`
}

type personalFinanceBillflowAccountGroupResponse struct {
	SourceType      importing.SourceType `json:"sourceType"`
	Currency        string               `json:"currency"`
	DisplayName     string               `json:"displayName"`
	RowCount        int64                `json:"rowCount"`
	PendingRowCount int64                `json:"pendingRowCount"`
	SampleRowId     string               `json:"sampleRowId"`
	LedgerAccountId *string              `json:"ledgerAccountId"`
	SuggestedType   string               `json:"suggestedType"`
	Mapped          bool                 `json:"mapped"`
}

type personalFinanceBillflowAccountsResponse struct {
	NeedsCreate []*personalFinanceBillflowAccountGroupResponse `json:"needsCreate"`
	Reused      []*personalFinanceBillflowAccountGroupResponse `json:"reused"`
}

type personalFinanceBillflowTodoResponse struct {
	Id              string               `json:"id"`
	TodoKind        billflow.TodoKind    `json:"todoKind"`
	Status          billflow.TodoStatus  `json:"status"`
	SubjectKind     billflow.SubjectKind `json:"subjectKind"`
	SubjectId       string               `json:"subjectId"`
	ReasonCodes     []string             `json:"reasonCodes"`
	Version         int64                `json:"version"`
	CreatedUnixTime int64                `json:"createdUnixTime"`
	UpdatedUnixTime int64                `json:"updatedUnixTime"`
}

type personalFinanceBillflowTodoListResponse struct {
	Items      []*personalFinanceBillflowTodoResponse     `json:"items"`
	NextCursor *personalFinanceBillflowTodoCursorResponse `json:"nextCursor"`
}

type personalFinanceBillflowTodoCursorResponse struct {
	UpdatedUnixTime int64  `json:"updatedUnixTime"`
	TodoId          string `json:"todoId"`
}

type personalFinanceBillflowUndoImpactResponse struct {
	CanReverse      bool     `json:"canReverse"`
	AutoPostedCount int64    `json:"autoPostedCount"`
	ReusedLinkCount int64    `json:"reusedLinkCount"`
	ReasonCodes     []string `json:"reasonCodes"`
}

func (a *PersonalFinanceBillflowApi) BillflowTaskCreateHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceBillflowCreateRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	fileIds := make([]int64, 0, len(request.FileIds))
	for _, raw := range request.FileIds {
		id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || id < 1 {
			return nil, errs.ErrParameterInvalid
		}
		fileIds = append(fileIds, id)
	}
	result, err := a.application.CreateTask(c, billflow.CreateTaskRequest{Uid: c.GetCurrentUid(), FileIds: fileIds, IdempotencyKey: request.IdempotencyKey})
	if err != nil {
		log.Warnf(c, "[personal_finance_billflow.create] failed for user \"uid:%d\" and code \"%s\"", c.GetCurrentUid(), billflow.ServiceErrorCodeOf(err))
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowTaskResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskListHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "status", "limit", "cursor_updated_unix_time", "cursor_task_id") {
		return nil, errs.ErrParameterInvalid
	}
	status := billflow.TaskStatus(strings.TrimSpace(c.Query("status")))
	limit, cursor, ok := parsePersonalFinanceBillflowTaskPage(c)
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.ListTasks(c, c.GetCurrentUid(), status, cursor, limit)
	if err != nil {
		log.Warnf(c, "[personal_finance_billflow.list] failed for user \"uid:%d\" and code \"%s\"", c.GetCurrentUid(), billflow.ServiceErrorCodeOf(err))
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowTaskListResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskGetHandler(c *core.WebContext) (any, *errs.Error) {
	taskId, ok := parsePersonalFinanceBillflowIDQuery(c, "id")
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.GetTask(c, c.GetCurrentUid(), taskId)
	if err != nil {
		log.Warnf(c, "[personal_finance_billflow.get] failed for user \"uid:%d\" and task \"id:%d\"", c.GetCurrentUid(), taskId)
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowTaskResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskAccountsHandler(c *core.WebContext) (any, *errs.Error) {
	taskId, ok := parsePersonalFinanceBillflowIDQuery(c, "id")
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.GetTaskAccounts(c, c.GetCurrentUid(), taskId)
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowAccountsResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskAccountsCreateHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceBillflowCreateAccountRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.CreateTaskAccount(c, billflow.CreateAccountRequest{
		Uid: c.GetCurrentUid(), TaskId: request.TaskId, ExpectedVersion: request.ExpectedVersion,
		SampleRowId: request.SampleRowId, Name: request.Name, Category: request.Category,
		Currency: request.Currency, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowAccountsResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskAccountsOverrideHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceBillflowOverrideAccountRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.OverrideTaskAccount(c, billflow.OverrideAccountRequest{
		Uid: c.GetCurrentUid(), TaskId: request.TaskId, ExpectedVersion: request.ExpectedVersion,
		SampleRowId: request.SampleRowId, LedgerAccountId: request.LedgerAccountId, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowAccountsResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskRunHandler(c *core.WebContext) (any, *errs.Error) {
	return a.handleTaskRun(c, false)
}

func (a *PersonalFinanceBillflowApi) BillflowTaskConfirmPostHandler(c *core.WebContext) (any, *errs.Error) {
	return a.handleTaskRun(c, true)
}

func (a *PersonalFinanceBillflowApi) handleTaskRun(c *core.WebContext, confirm bool) (any, *errs.Error) {
	request := new(personalFinanceBillflowTaskActionRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	location, err := c.GetClientTimezone()
	if err != nil {
		location = nil
	}
	domain := billflow.RunTaskRequest{
		Uid: c.GetCurrentUid(), TaskId: request.TaskId, ExpectedVersion: request.ExpectedVersion,
		IdempotencyKey: request.IdempotencyKey, CreatedIp: c.ClientIP(),
	}
	var result *billflow.TaskView
	var runErr error
	if confirm {
		result, runErr = a.application.ConfirmPost(c, domain, location)
	} else {
		result, runErr = a.application.RunTask(c, domain, location)
	}
	if runErr != nil {
		return nil, personalFinanceBillflowServiceError(runErr)
	}
	return newPersonalFinanceBillflowTaskResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskTodosHandler(c *core.WebContext) (any, *errs.Error) {
	if !personalFinanceInstallmentQueryAllowed(c, "id", "status", "limit", "cursor_updated_unix_time", "cursor_todo_id") {
		return nil, errs.ErrParameterInvalid
	}
	taskId, err := strconv.ParseInt(strings.TrimSpace(c.Query("id")), 10, 64)
	if err != nil || taskId < 1 {
		return nil, errs.ErrParameterInvalid
	}
	status := billflow.TodoStatus(strings.TrimSpace(c.Query("status")))
	limit := personalFinanceBillflowDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > personalFinanceBillflowMaximumListLimit {
			return nil, errs.ErrParameterInvalid
		}
		limit = parsed
	}
	var cursor *billflow.TodoCursor
	if rawTime := strings.TrimSpace(c.Query("cursor_updated_unix_time")); rawTime != "" || strings.TrimSpace(c.Query("cursor_todo_id")) != "" {
		updated, timeErr := strconv.ParseInt(rawTime, 10, 64)
		todoId, idErr := strconv.ParseInt(strings.TrimSpace(c.Query("cursor_todo_id")), 10, 64)
		if timeErr != nil || idErr != nil || updated < 1 || todoId < 1 {
			return nil, errs.ErrParameterInvalid
		}
		cursor = &billflow.TodoCursor{UpdatedUnixTime: updated, TodoId: todoId}
	}
	result, listErr := a.application.ListTodos(c, c.GetCurrentUid(), taskId, status, cursor, limit)
	if listErr != nil {
		return nil, personalFinanceBillflowServiceError(listErr)
	}
	return newPersonalFinanceBillflowTodoListResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTodoResolveHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceBillflowResolveTodoRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.ResolveTodo(c, billflow.ResolveTodoRequest{
		Uid: c.GetCurrentUid(), TodoId: request.TodoId, ExpectedVersion: request.ExpectedVersion,
		Status: request.Status, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowTodoResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskUndoImpactHandler(c *core.WebContext) (any, *errs.Error) {
	taskId, ok := parsePersonalFinanceBillflowIDQuery(c, "id")
	if !ok {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.GetUndoImpact(c, c.GetCurrentUid(), taskId)
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowUndoImpactResponse(result), nil
}

func (a *PersonalFinanceBillflowApi) BillflowTaskUndoHandler(c *core.WebContext) (any, *errs.Error) {
	request := new(personalFinanceBillflowTaskActionRequest)
	if err := decodePersonalFinanceLoanJSON(c, request); err != nil {
		return nil, errs.ErrParameterInvalid
	}
	result, err := a.application.UndoTask(c, billflow.UndoTaskRequest{
		Uid: c.GetCurrentUid(), TaskId: request.TaskId, ExpectedVersion: request.ExpectedVersion, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		return nil, personalFinanceBillflowServiceError(err)
	}
	return newPersonalFinanceBillflowTaskResponse(result), nil
}

func parsePersonalFinanceBillflowIDQuery(c *core.WebContext, key string) (int64, bool) {
	if !personalFinanceInstallmentQueryAllowed(c, key) {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimSpace(c.Query(key)), 10, 64)
	if err != nil || id < 1 {
		return 0, false
	}
	return id, true
}

func parsePersonalFinanceBillflowTaskPage(c *core.WebContext) (int, *billflow.TaskCursor, bool) {
	limit := personalFinanceBillflowDefaultListLimit
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > personalFinanceBillflowMaximumListLimit {
			return 0, nil, false
		}
		limit = parsed
	}
	var cursor *billflow.TaskCursor
	if rawTime := strings.TrimSpace(c.Query("cursor_updated_unix_time")); rawTime != "" || strings.TrimSpace(c.Query("cursor_task_id")) != "" {
		updated, err := strconv.ParseInt(rawTime, 10, 64)
		taskId, idErr := strconv.ParseInt(strings.TrimSpace(c.Query("cursor_task_id")), 10, 64)
		if err != nil || idErr != nil || updated < 1 || taskId < 1 {
			return 0, nil, false
		}
		cursor = &billflow.TaskCursor{UpdatedUnixTime: updated, TaskId: taskId}
	}
	return limit, cursor, true
}

func newPersonalFinanceBillflowTaskResponse(value *billflow.TaskView) *personalFinanceBillflowTaskResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceBillflowTaskResponse{
		Id: strconv.FormatInt(value.TaskId, 10), Status: value.Status, ConfirmPolicy: value.ConfirmPolicy, Version: value.Version,
		CreatedAccountCount: value.CreatedAccountCount, ReusedMappingCount: value.ReusedMappingCount,
		AutoPostedCount: value.AutoPostedCount, TodoOpenCount: value.TodoOpenCount, ErrorCode: value.ErrorCode,
		CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
		Members: []*personalFinanceBillflowMemberResponse{},
	}
	for _, member := range value.Members {
		if member == nil {
			continue
		}
		response.Members = append(response.Members, &personalFinanceBillflowMemberResponse{
			Id: strconv.FormatInt(member.MemberId, 10), FileId: strconv.FormatInt(member.FileId, 10),
			BatchId: strconv.FormatInt(member.BatchId, 10), MemberOrder: member.MemberOrder,
		})
	}
	return response
}

func newPersonalFinanceBillflowTaskListResponse(result *billflow.TaskListResult) *personalFinanceBillflowTaskListResponse {
	response := &personalFinanceBillflowTaskListResponse{Items: []*personalFinanceBillflowTaskResponse{}}
	if result == nil {
		return response
	}
	for _, item := range result.Items {
		response.Items = append(response.Items, newPersonalFinanceBillflowTaskResponse(item))
	}
	if result.NextCursor != nil {
		response.NextCursor = &personalFinanceBillflowTaskCursorResponse{
			UpdatedUnixTime: result.NextCursor.UpdatedUnixTime, TaskId: strconv.FormatInt(result.NextCursor.TaskId, 10),
		}
	}
	return response
}

func newPersonalFinanceBillflowAccountsResponse(value *billflow.TaskAccountsView) *personalFinanceBillflowAccountsResponse {
	response := &personalFinanceBillflowAccountsResponse{
		NeedsCreate: []*personalFinanceBillflowAccountGroupResponse{},
		Reused:      []*personalFinanceBillflowAccountGroupResponse{},
	}
	if value == nil {
		return response
	}
	for _, item := range value.NeedsCreate {
		response.NeedsCreate = append(response.NeedsCreate, newPersonalFinanceBillflowAccountGroupResponse(item))
	}
	for _, item := range value.Reused {
		response.Reused = append(response.Reused, newPersonalFinanceBillflowAccountGroupResponse(item))
	}
	return response
}

func newPersonalFinanceBillflowAccountGroupResponse(value *billflow.AccountGroupView) *personalFinanceBillflowAccountGroupResponse {
	if value == nil {
		return nil
	}
	response := &personalFinanceBillflowAccountGroupResponse{
		SourceType: value.SourceType, Currency: value.Currency, DisplayName: value.DisplayName,
		RowCount: value.RowCount, PendingRowCount: value.PendingRowCount, SampleRowId: strconv.FormatInt(value.SampleRowId, 10),
		SuggestedType: value.SuggestedType, Mapped: value.Mapped,
	}
	response.LedgerAccountId = formatOptionalId(value.LedgerAccountId)
	return response
}

func newPersonalFinanceBillflowTodoResponse(value *billflow.TodoView) *personalFinanceBillflowTodoResponse {
	if value == nil {
		return nil
	}
	return &personalFinanceBillflowTodoResponse{
		Id: strconv.FormatInt(value.TodoId, 10), TodoKind: value.TodoKind, Status: value.Status, SubjectKind: value.SubjectKind,
		SubjectId: strconv.FormatInt(value.SubjectId, 10), ReasonCodes: value.ReasonCodes, Version: value.Version,
		CreatedUnixTime: value.CreatedUnixTime, UpdatedUnixTime: value.UpdatedUnixTime,
	}
}

func newPersonalFinanceBillflowTodoListResponse(result *billflow.TodoListResult) *personalFinanceBillflowTodoListResponse {
	response := &personalFinanceBillflowTodoListResponse{Items: []*personalFinanceBillflowTodoResponse{}}
	if result == nil {
		return response
	}
	for _, item := range result.Items {
		response.Items = append(response.Items, newPersonalFinanceBillflowTodoResponse(item))
	}
	if result.NextCursor != nil {
		response.NextCursor = &personalFinanceBillflowTodoCursorResponse{
			UpdatedUnixTime: result.NextCursor.UpdatedUnixTime, TodoId: strconv.FormatInt(result.NextCursor.TodoId, 10),
		}
	}
	return response
}

func newPersonalFinanceBillflowUndoImpactResponse(value *billflow.UndoImpactView) *personalFinanceBillflowUndoImpactResponse {
	if value == nil {
		return &personalFinanceBillflowUndoImpactResponse{ReasonCodes: []string{}}
	}
	codes := value.ReasonCodes
	if codes == nil {
		codes = []string{}
	}
	return &personalFinanceBillflowUndoImpactResponse{
		CanReverse: value.CanReverse, AutoPostedCount: value.AutoPostedCount,
		ReusedLinkCount: value.ReusedLinkCount, ReasonCodes: codes,
	}
}

func personalFinanceBillflowServiceError(err error) *errs.Error {
	switch {
	case errors.Is(err, billflow.ErrServiceInvalidRequest), errors.Is(err, billflow.ErrServiceTaskNotFound),
		errors.Is(err, billflow.ErrServiceAccountRejected):
		return errs.ErrParameterInvalid
	case errors.Is(err, billflow.ErrServiceVersionConflict), errors.Is(err, billflow.ErrServiceStateConflict),
		errors.Is(err, billflow.ErrServiceIdempotencyConflict):
		return errs.ErrRepeatedRequest
	case errors.Is(err, billflow.ErrServiceActionRequired):
		return errs.ErrOperationFailed
	default:
		return errs.ErrOperationFailed
	}
}
