package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestPersonalFinanceImportFileResponseOmitsSensitiveStorageFields(t *testing.T) {
	file := &importing.ImportFile{
		Uid:              1001,
		FileId:           2001,
		OriginalFileName: "statement.csv",
		FileSha256:       strings.Repeat("1", 64),
		StorageObjectKey: "objects/" + strings.Repeat("a", 64),
		CreatedIp:        "192.0.2.1",
	}
	response := newPersonalFinanceImportFileResponse(file)
	encoded, err := json.Marshal(response)

	if err != nil {
		t.Fatalf("marshal import file response: %v", err)
	}

	text := string(encoded)

	for _, secret := range []string{file.FileSha256, file.StorageObjectKey, file.CreatedIp, "uid"} {
		if strings.Contains(text, secret) {
			t.Fatalf("import file response leaked a private field")
		}
	}
}

func TestRawImportRowResponseOmitsSnapshotByDefault(t *testing.T) {
	row := &importing.RawImportRow{
		RowId:         1,
		BatchId:       2,
		RowNumber:     3,
		RawFieldsJson: `[{"name":"synthetic","value":"raw-redaction-canary"}]`,
		IssuesJson:    `[{"code":"row_field_missing","severity":"error"}]`,
	}

	summary, err := json.Marshal(newPersonalFinanceRawImportRowResponse(row, false))

	if err != nil {
		t.Fatalf("marshal summary row: %v", err)
	}

	if strings.Contains(string(summary), "raw-redaction-canary") || strings.Contains(string(summary), "rawFields") || strings.Contains(string(summary), "issues") {
		t.Fatalf("summary row leaked the raw snapshot")
	}

	details, err := json.Marshal(newPersonalFinanceRawImportRowResponse(row, true))

	if err != nil {
		t.Fatalf("marshal detailed row: %v", err)
	}

	if !strings.Contains(string(details), "raw-redaction-canary") || !strings.Contains(string(details), "rawFields") {
		t.Fatalf("explicit detailed row did not include the requested snapshot")
	}
}

func TestPersonalFinanceListHandlersForwardPageConvention(t *testing.T) {
	gin.SetMode(gin.TestMode)
	application := &paginationCaptureImportApplication{}
	api := &PersonalFinanceImportsApi{
		serviceFactory: func() (personalFinanceImportApplication, error) {
			return application, nil
		},
	}

	for _, page := range []string{"0", "1", "2"} {
		if _, err := api.ImportFileListHandler(newPersonalFinanceListTestContext(t, "/?page="+page+"&count=1")); err != nil {
			t.Fatalf("file list handler rejected page %s", page)
		}

		if _, err := api.ImportBatchListHandler(newPersonalFinanceListTestContext(t, "/?page="+page+"&count=1")); err != nil {
			t.Fatalf("batch list handler rejected page %s", page)
		}

		if _, err := api.RawImportRowListHandler(newPersonalFinanceListTestContext(t, "/?batch_id=3001&page="+page+"&count=1")); err != nil {
			t.Fatalf("raw row list handler rejected page %s", page)
		}
	}

	assertCapturedPages(t, "file", application.filePages)
	assertCapturedPages(t, "batch", application.batchPages)
	assertCapturedPages(t, "raw row", application.rowPages)
}

type paginationCaptureImportApplication struct {
	personalFinanceImportApplication
	filePages  []int32
	batchPages []int32
	rowPages   []int32
}

func (a *paginationCaptureImportApplication) ListImportFiles(_ core.Context, _ int64, page int32, _ int32) (*importing.ImportFilePage, error) {
	a.filePages = append(a.filePages, page)
	return &importing.ImportFilePage{Items: []*importing.ImportFile{}}, nil
}

func (a *paginationCaptureImportApplication) ListImportBatches(_ core.Context, _ int64, _ int64, page int32, _ int32) (*importing.ImportBatchPage, error) {
	a.batchPages = append(a.batchPages, page)
	return &importing.ImportBatchPage{Items: []*importing.ImportBatchDetails{}}, nil
}

func (a *paginationCaptureImportApplication) ListRawImportRows(_ core.Context, _ int64, batchId int64, page int32, _ int32, _ bool) (*importing.RawImportRowPage, error) {
	a.rowPages = append(a.rowPages, page)
	return &importing.RawImportRowPage{
		Batch: &importing.ImportBatchDetails{
			Batch: &importing.ImportBatch{BatchId: batchId},
		},
		Items: []*importing.RawImportRow{},
	}, nil
}

func newPersonalFinanceListTestContext(t *testing.T, requestURL string) *core.WebContext {
	t.Helper()
	response := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(response)
	ginContext.Request = httptest.NewRequest(http.MethodGet, requestURL, nil)
	webContext := &core.WebContext{Context: ginContext}
	webContext.SetTokenClaims(&core.UserTokenClaims{Uid: 1001})
	return webContext
}

func assertCapturedPages(t *testing.T, name string, pages []int32) {
	t.Helper()
	expected := []int32{0, 1, 2}

	if len(pages) != len(expected) {
		t.Fatalf("%s list captured an unexpected page count", name)
	}

	for index := range expected {
		if pages[index] != expected[index] {
			t.Fatalf("%s list did not forward page %d", name, expected[index])
		}
	}
}
