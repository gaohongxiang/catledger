package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestPaymentLedgerAccountUsabilityRequiresVisibleSingleAccountAndCurrency(t *testing.T) {
	account := &models.Account{Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT, Currency: "CNY"}
	if !isPersonalFinancePaymentLedgerAccountUsable(account, "CNY") {
		t.Fatal("visible single-currency account was rejected")
	}
	if isPersonalFinancePaymentLedgerAccountUsable(account, "USD") {
		t.Fatal("currency mismatch was accepted")
	}
	hidden := *account
	hidden.Hidden = true
	if isPersonalFinancePaymentLedgerAccountUsable(&hidden, "CNY") {
		t.Fatal("hidden account was accepted")
	}
	parent := *account
	parent.Type = models.ACCOUNT_TYPE_MULTI_SUB_ACCOUNTS
	if isPersonalFinancePaymentLedgerAccountUsable(&parent, "CNY") || isPersonalFinancePaymentLedgerAccountUsable(nil, "CNY") {
		t.Fatal("parent or missing account was accepted")
	}
}

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

func TestGenericCSVMappingRequestConversionPreservesExplicitIndexes(t *testing.T) {
	request := &personalFinanceGenericCSVMapping{
		Encoding: importing.GENERIC_CSV_ENCODING_UTF8, Delimiter: importing.GENERIC_CSV_DELIMITER_COMMA,
		HeaderRow: 3, TimeFormat: importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS, AmountMode: importing.GENERIC_CSV_AMOUNT_MODE_SIGNED,
		SignedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE, TimeColumn: 0, AmountColumn: 4,
		DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1, CurrencyColumn: -1, TransactionIdColumn: 2,
		OrderIdColumn: -1, MerchantOrderIdColumn: -1, CounterpartyColumn: -1, ItemColumn: -1,
		PaymentMethodColumn: -1, StatusColumn: -1, TransactionTypeColumn: -1, NoteColumn: -1,
	}
	mapping := newGenericCSVMapping(request)
	if mapping == nil || mapping.HeaderRow != 3 || mapping.AmountColumn != 4 || mapping.TransactionIdColumn != 2 || mapping.DirectionColumn != -1 {
		t.Fatalf("API mapping conversion changed explicit indexes: %+v", mapping)
	}
	if _, err := importing.NormalizeGenericCSVMapping(*mapping); err != nil {
		t.Fatalf("converted API mapping is invalid: %v", err)
	}
}
