package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestBillflowHandlersUseStringIdsAndOmitSecrets(t *testing.T) {
	accountId := int64(61)
	stub := &billflowAPITestApplication{
		task: &billflow.TaskView{
			TaskId: 9001, Status: billflow.TASK_STATUS_READY, ConfirmPolicy: billflow.CONFIRM_POLICY_AUTO_POST, Version: 4,
			ReusedMappingCount: 1, AutoPostedCount: 2, Members: []*billflow.MemberView{{MemberId: 11, FileId: 301, BatchId: 401, MemberOrder: 0}},
		},
		accounts: &billflow.TaskAccountsView{Reused: []*billflow.AccountGroupView{{
			SourceType: importing.SOURCE_TYPE_ALIPAY, Currency: "CNY", DisplayName: "余额宝", SampleRowId: 801, LedgerAccountId: &accountId, Mapped: true, SuggestedType: "virtual",
		}}},
		todos: &billflow.TodoListResult{Items: []*billflow.TodoView{{
			TodoId: 501, TodoKind: billflow.TODO_KIND_UNCATEGORIZED, Status: billflow.TODO_STATUS_OPEN,
			SubjectKind: billflow.SUBJECT_KIND_RAW_ROW, SubjectId: 801, ReasonCodes: []string{}, Version: 1,
		}}},
		impact: &billflow.UndoImpactView{CanReverse: true, AutoPostedCount: 2, ReasonCodes: []string{}},
	}
	stub.list = &billflow.TaskListResult{Items: []*billflow.TaskView{stub.task}, NextCursor: &billflow.TaskCursor{UpdatedUnixTime: 1700000100, TaskId: 9002}}
	api := newBillflowTestAPI(t, stub)

	created, apiErr := api.BillflowTaskCreateHandler(newBillflowTestContext(t, http.MethodPost, "/create", `{"fileIds":["301"],"idempotencyKey":"create-key-1"}`))
	if apiErr != nil {
		t.Fatalf("create billflow task: %v", apiErr)
	}
	replaced, apiErr := api.BillflowTaskReplaceFilesHandler(newBillflowTestContext(t, http.MethodPost, "/replace_files", `{"taskId":"9001","expectedVersion":4,"fileIds":["301","302"],"idempotencyKey":"replace-key-1"}`))
	if apiErr != nil {
		t.Fatalf("replace billflow task files: %v", apiErr)
	}
	createdText := marshalBillflowResponse(t, created)
	if !strings.Contains(createdText, `"id":"9001"`) || !strings.Contains(createdText, `"fileId":"301"`) {
		t.Fatalf("create response omitted string ids: %s", createdText)
	}
	assertBillflowResponseOmits(t, createdText, "aliasKey", "alias_key", "candidateKey", "RawItem", "rawNote")
	replacedText := marshalBillflowResponse(t, replaced)
	if !strings.Contains(replacedText, `"id":"9001"`) {
		t.Fatalf("replace response omitted string ids: %s", replacedText)
	}
	assertBillflowResponseOmits(t, replacedText, "aliasKey", "alias_key", "candidateKey", "RawItem", "rawNote")

	listResponse, apiErr := api.BillflowTaskListHandler(newBillflowTestContext(t, http.MethodGet,
		"/list?status=ready&limit=20&cursor_updated_unix_time=1700000000&cursor_task_id=9000", ""))
	if apiErr != nil {
		t.Fatalf("list billflow tasks: %v", apiErr)
	}
	listText := marshalBillflowResponse(t, listResponse)
	if !strings.Contains(listText, `"taskId":"9002"`) {
		t.Fatalf("list cursor omitted string id: %s", listText)
	}

	accounts, apiErr := api.BillflowTaskAccountsHandler(newBillflowTestContext(t, http.MethodGet, "/accounts?id=9001", ""))
	if apiErr != nil {
		t.Fatalf("list billflow accounts: %v", apiErr)
	}
	accountText := marshalBillflowResponse(t, accounts)
	if !strings.Contains(accountText, `"ledgerAccountId":"61"`) || !strings.Contains(accountText, `"sampleRowId":"801"`) ||
		!strings.Contains(accountText, `"excluded":`) {
		t.Fatalf("accounts response omitted string ids: %s", accountText)
	}
	assertBillflowResponseOmits(t, accountText, "aliasKey", "rawPaymentMethod", "RawPaymentMethod")

	stub.classified = []*billflow.ClassifiedRowView{{
		RowId: 802, CategoryId: 51, Label: "mapped-merchant", Amount: "123", Currency: "CNY", Direction: string(importing.NORMALIZED_DIRECTION_EXPENSE),
	}}
	classified, apiErr := api.BillflowTaskClassifiedHandler(newBillflowTestContext(t, http.MethodGet, "/categories?id=9001", ""))
	if apiErr != nil {
		t.Fatalf("list classified rows: %v", apiErr)
	}
	classifiedText := marshalBillflowResponse(t, classified)
	if !strings.Contains(classifiedText, `"id":"802"`) || !strings.Contains(classifiedText, `"categoryId":"51"`) {
		t.Fatalf("classified response omitted string ids: %s", classifiedText)
	}
	assertBillflowResponseOmits(t, classifiedText, "aliasKey", "RawItem", "rawNote")

	caseId := int64(7001)
	stub.mergeGroups = &billflow.MergeGroupListResult{Items: []*billflow.MergeGroupView{{
		GroupId: strings.Repeat("a", 64), Status: billflow.MERGE_GROUP_STATUS_PREVIEW_MERGED,
		RelationType: "same_event", PrimaryCaseId: &caseId, CaseIds: []int64{caseId},
		CandidateRuleVersion: "reconciliation-candidate-v2", ReasonCodes: []string{"amount_currency_exact"},
		Rows: []*billflow.MergeGroupRowView{{TodoMatchView: &billflow.TodoMatchView{RowId: 801, SourceType: "alipay", Label: "merchant", Amount: "123", Currency: "CNY", Direction: "expense"}, InTask: true},
			{TodoMatchView: &billflow.TodoMatchView{RowId: 802, SourceType: "bank", Label: "merchant", Amount: "123", Currency: "CNY", Direction: "expense"}, InTask: true}},
	}}}
	mergeGroups, apiErr := api.BillflowTaskMergeGroupsHandler(newBillflowTestContext(t, http.MethodGet, "/merge_groups?id=9001", ""))
	if apiErr != nil {
		t.Fatalf("list merge groups: %v", apiErr)
	}
	mergeText := marshalBillflowResponse(t, mergeGroups)
	if !strings.Contains(mergeText, `"primaryCaseId":"7001"`) || !strings.Contains(mergeText, `"status":"preview_merged"`) || !strings.Contains(mergeText, `"rowId":"801"`) {
		t.Fatalf("merge group response omitted safe task projection: %s", mergeText)
	}
	assertBillflowResponseOmits(t, mergeText, "caseKey", "aliasKey", "rawPaymentMethod", "RawItem", "rawNote")
}

func TestBillflowHandlersMapErrorsAndRejectInvalidInput(t *testing.T) {
	stub := &billflowAPITestApplication{task: &billflow.TaskView{TaskId: 9001, Status: billflow.TASK_STATUS_READY, ConfirmPolicy: billflow.CONFIRM_POLICY_AUTO_POST, Version: 1}}
	api := newBillflowTestAPI(t, stub)

	if response, apiErr := api.BillflowTaskListHandler(newBillflowTestContext(t, http.MethodGet, "/list?status=ready&extra=1", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown list query was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.BillflowTaskGetHandler(newBillflowTestContext(t, http.MethodGet, "/get?id=abc", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid get id was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.BillflowTaskClassifiedHandler(newBillflowTestContext(t, http.MethodGet, "/categories?id=9001&extra=1", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown classified query was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.BillflowTaskMergeGroupsHandler(newBillflowTestContext(t, http.MethodGet, "/merge_groups?id=bad", "")); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("invalid merge group task id was accepted: response=%v err=%v", response, apiErr)
	}
	if response, apiErr := api.BillflowTaskCreateHandler(newBillflowTestContext(t, http.MethodPost, "/create",
		`{"fileIds":["301"],"idempotencyKey":"create-key-1","uid":"999"}`)); response != nil || apiErr != errs.ErrParameterInvalid {
		t.Fatalf("unknown create field was accepted: response=%v err=%v", response, apiErr)
	}

	stub.err = billflow.ErrServiceVersionConflict
	if response, apiErr := api.BillflowTaskRunHandler(newBillflowTestContext(t, http.MethodPost, "/run",
		`{"taskId":"9001","expectedVersion":1,"idempotencyKey":"run-key-1"}`)); response != nil || apiErr != errs.ErrRepeatedRequest {
		t.Fatalf("version conflict did not map to repeated request: response=%v err=%v", response, apiErr)
	}
	stub.err = billflow.ErrServiceActionRequired
	if response, apiErr := api.BillflowTaskUndoHandler(newBillflowTestContext(t, http.MethodPost, "/undo",
		`{"taskId":"9001","expectedVersion":1,"idempotencyKey":"undo-key-1"}`)); response != nil || apiErr != errs.ErrOperationFailed {
		t.Fatalf("action required did not map to operation failed: response=%v err=%v", response, apiErr)
	}
}

type billflowAPITestApplication struct {
	task        *billflow.TaskView
	list        *billflow.TaskListResult
	accounts    *billflow.TaskAccountsView
	rows        []*billflow.AccountRowView
	todos       *billflow.TodoListResult
	classified  []*billflow.ClassifiedRowView
	mergeGroups *billflow.MergeGroupListResult
	impact      *billflow.UndoImpactView
	err         error
}

func (a *billflowAPITestApplication) CreateTask(_ core.Context, _ billflow.CreateTaskRequest) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) ReplaceTaskFiles(_ core.Context, _ billflow.ReplaceTaskFilesRequest) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) ListTasks(_ core.Context, _ int64, _ billflow.TaskStatus, _ *billflow.TaskCursor, _ int) (*billflow.TaskListResult, error) {
	return a.list, a.err
}
func (a *billflowAPITestApplication) GetTask(_ core.Context, _ int64, _ int64) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) GetTaskAccounts(_ core.Context, _ int64, _ int64) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) CreateTaskAccount(_ core.Context, _ billflow.CreateAccountRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) OverrideTaskAccount(_ core.Context, _ billflow.OverrideAccountRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) ExcludeTaskAccount(_ core.Context, _ billflow.ExcludeAccountRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) RestoreTaskAccount(_ core.Context, _ billflow.ExcludeAccountRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) SkipTaskAccountRows(_ core.Context, _ billflow.SkipAccountRowsRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) RestoreTaskAccountRows(_ core.Context, _ billflow.SkipAccountRowsRequest) (*billflow.TaskAccountsView, error) {
	return a.accounts, a.err
}
func (a *billflowAPITestApplication) ListTaskAccountRows(_ core.Context, _ int64, _ int64, _ int64) ([]*billflow.AccountRowView, error) {
	return a.rows, a.err
}
func (a *billflowAPITestApplication) RunTask(_ core.Context, _ billflow.RunTaskRequest, _ *time.Location) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) ConfirmPost(_ core.Context, _ billflow.RunTaskRequest, _ *time.Location) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) ListTodos(_ core.Context, _ int64, _ int64, _ billflow.TodoStatus, _ *billflow.TodoCursor, _ int) (*billflow.TodoListResult, error) {
	return a.todos, a.err
}
func (a *billflowAPITestApplication) ListClassifiedRows(_ core.Context, _ int64, _ int64) ([]*billflow.ClassifiedRowView, error) {
	return a.classified, a.err
}
func (a *billflowAPITestApplication) ListMergeGroups(_ core.Context, _ int64, _ int64) (*billflow.MergeGroupListResult, error) {
	return a.mergeGroups, a.err
}
func (a *billflowAPITestApplication) ResolveTodo(_ core.Context, _ billflow.ResolveTodoRequest) (*billflow.TodoView, error) {
	if a.todos != nil && len(a.todos.Items) > 0 {
		return a.todos.Items[0], a.err
	}
	return nil, a.err
}
func (a *billflowAPITestApplication) AssignTodoCategories(_ core.Context, _ billflow.AssignTodoCategoryRequest) (*billflow.TaskView, error) {
	return a.task, a.err
}
func (a *billflowAPITestApplication) GetUndoImpact(_ core.Context, _ int64, _ int64) (*billflow.UndoImpactView, error) {
	return a.impact, a.err
}
func (a *billflowAPITestApplication) UndoTask(_ core.Context, _ billflow.UndoTaskRequest) (*billflow.TaskView, error) {
	return a.task, a.err
}

func newBillflowTestAPI(t *testing.T, application *billflowAPITestApplication) *PersonalFinanceBillflowApi {
	t.Helper()
	api, err := NewPersonalFinanceBillflowApi(application)
	if err != nil {
		t.Fatalf("create billflow api: %v", err)
	}
	return api
}

func newBillflowTestContext(t *testing.T, method, target, body string) *core.WebContext {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	ginContext.Request = request
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func marshalBillflowResponse(t *testing.T, response any) string {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal billflow response: %v", err)
	}
	return string(encoded)
}

func assertBillflowResponseOmits(t *testing.T, text string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(text, value) {
			t.Fatalf("billflow response leaked %q: %s", value, text)
		}
	}
}
