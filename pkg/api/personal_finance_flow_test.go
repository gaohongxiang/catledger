package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestTransactionEvidenceResponseRedactsRawIdentityAndStorageFields(t *testing.T) {
	amount := int64(1234)
	canary := "private-evidence-canary"
	response := newPersonalFinanceTransactionEvidenceResponse(&importing.TransactionEvidenceResult{
		TransactionId: 101,
		Items: []*importing.TransactionEvidenceItem{{
			Link: &importing.RawRowTransactionLink{
				RowId:          201,
				TransactionId:  101,
				RelationRole:   importing.RAW_ROW_TRANSACTION_RELATION_PRIMARY,
				CreationMethod: importing.RAW_ROW_TRANSACTION_CREATION_POSTING_CREATED,
				RuleVersion:    importing.POSTING_LINK_VERSION_V1,
			},
			Row: &importing.RawImportRow{
				RowId:               201,
				BatchId:             301,
				RowNumber:           1,
				SourceTransactionId: canary,
				RawNote:             canary,
				RawFieldsJson:       `{"secret":"` + canary + `"}`,
				NormalizedAmount:    &amount,
				Currency:            "CNY",
			},
			Batch: &importing.ImportBatch{BatchId: 301, SourceTypeSnapshot: importing.SOURCE_TYPE_ALIPAY},
			File: &importing.ImportFile{
				FileId:           401,
				FileExtension:    "csv",
				FileSha256:       canary,
				StorageObjectKey: canary,
			},
		}},
	})
	if response == nil {
		t.Fatal("build evidence response")
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal evidence response: %v", err)
	}

	text := string(encoded)
	if strings.Contains(text, canary) || strings.Contains(text, "sourceTransactionId") ||
		strings.Contains(text, "rawNote") || strings.Contains(text, "rawFields") ||
		strings.Contains(text, "fileSha256") || strings.Contains(text, "storageObjectKey") {
		t.Fatalf("evidence response leaked a raw or storage field: %s", text)
	}

	if !strings.Contains(text, `"normalizedAmount":"1234"`) || !strings.Contains(text, `"fileExtension":"csv"`) {
		t.Fatalf("evidence response omitted its safe summary: %s", text)
	}
}
