package genericbank

import (
	"context"
	"testing"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestDescriptorRequiresExplicitSelectionAndProbeRejectsBinary(t *testing.T) {
	descriptor := ImportEvidenceParser.Descriptor()
	if descriptor.Name != "generic_bank_csv" || descriptor.SourceType != importing.SOURCE_TYPE_BANK ||
		descriptor.Format != importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV || !descriptor.ExplicitSelectionOnly {
		t.Fatalf("unexpected generic bank descriptor: %+v", descriptor)
	}
	if result := ImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: []byte("time,amount\n2026-01-01,1.00\n")}); !result.Confidence.Matched() {
		t.Fatalf("supported CSV was not probed: %+v", result)
	}
	if result := ImportEvidenceParser.Probe(context.Background(), importing.EvidenceFile{Content: []byte{'P', 'K', 3, 4}}); result.Confidence.Matched() {
		t.Fatalf("binary content was claimed as CSV: %+v", result)
	}
}

func TestParseSignedRowsPreservesPhysicalEvidence(t *testing.T) {
	content := []byte("time,amount,id,counterparty,item,status\n" +
		"2026-08-13 10:00:00,+12.34,txn-1,Shop,Meal,settled\n" +
		"2026-08-13 11:00:00,-5.00,txn-2,Employer,Salary,refund-looking-text\n" +
		"\n" +
		"bad-time,1.00,txn-3,Other,Thing,failed-looking-text\n")
	mapping := baseMapping()
	mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_SIGNED
	mapping.AmountColumn = 1
	mapping.SignedPositiveDirection = importing.NORMALIZED_DIRECTION_EXPENSE
	mapping.TransactionIdColumn = 2
	mapping.CounterpartyColumn = 3
	mapping.ItemColumn = 4
	mapping.StatusColumn = 5
	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, options(mapping))
	if err != nil {
		t.Fatalf("parse signed CSV: %v", err)
	}
	if len(document.Rows) != 4 {
		t.Fatalf("physical rows were not preserved: %d", len(document.Rows))
	}
	positive, negative, blank, badTime := document.Rows[0], document.Rows[1], document.Rows[2], document.Rows[3]
	if positive.Normalized.Amount == nil || *positive.Normalized.Amount != 1234 || positive.Normalized.Direction != importing.NORMALIZED_DIRECTION_EXPENSE {
		t.Fatalf("positive signed semantics changed: %+v", positive.Normalized)
	}
	if negative.Normalized.Amount == nil || *negative.Normalized.Amount != 500 || negative.Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME {
		t.Fatalf("negative signed semantics changed: %+v", negative.Normalized)
	}
	if negative.Normalized.EconomicEffect != importing.ECONOMIC_EFFECT_NORMAL || negative.Normalized.TransactionType != importing.SOURCE_TRANSACTION_TYPE_OTHER {
		t.Fatalf("generic parser guessed bank-specific status semantics: %+v", negative.Normalized)
	}
	if blank.ParseStatus != importing.PARSE_STATE_INVALID || blank.Locator.CSVStartRow != 4 || blank.Locator.CSVEndRow != 4 || blank.RawFields == nil {
		t.Fatalf("empty physical row evidence was lost: %+v", blank)
	}
	if badTime.ParseStatus != importing.PARSE_STATE_INVALID || badTime.Identifiers.TransactionId != "txn-3" {
		t.Fatalf("semantic error row evidence was lost: %+v", badTime)
	}
	if document.Metadata.SourceAccount.Kind != importing.SOURCE_ACCOUNT_EVIDENCE_MISSING {
		t.Fatalf("generic bank parser invented a source account: %+v", document.Metadata.SourceAccount)
	}
}

func TestParseAmountDirectionGBKTabAndIncomeExpense(t *testing.T) {
	plain := "时间\t金额\t方向\n2026/08/13 10:00\t88.01\t入账\n2026/08/13 11:00\t9.50\t出账\n"
	mapping := baseMapping()
	mapping.Delimiter = importing.GENERIC_CSV_DELIMITER_TAB
	mapping.TimeFormat = importing.GENERIC_CSV_TIME_FORMAT_SLASH_DATE_TIME_MINUTES
	mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_AMOUNT_DIRECTION
	mapping.AmountColumn = 1
	mapping.DirectionColumn = 2
	mapping.IncomeValues = []string{" 入账 "}
	mapping.ExpenseValues = []string{"出账"}
	var document *importing.EvidenceDocument
	for _, test := range []struct {
		name  importing.GenericCSVEncoding
		codec encoding.Encoding
	}{{importing.GENERIC_CSV_ENCODING_GBK, simplifiedchinese.GBK}, {importing.GENERIC_CSV_ENCODING_GB18030, simplifiedchinese.GB18030}} {
		encoded, _, err := transform.Bytes(test.codec.NewEncoder(), []byte(plain))
		if err != nil {
			t.Fatalf("encode %s fixture: %v", test.name, err)
		}
		mapping.Encoding = test.name
		document, err = ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: encoded}, options(mapping))
		if err != nil {
			t.Fatalf("parse %s tab CSV: %v", test.name, err)
		}
		if len(document.Rows) != 2 || document.Rows[0].Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME || document.Rows[1].Normalized.Direction != importing.NORMALIZED_DIRECTION_EXPENSE {
			t.Fatalf("%s amount-direction mapping failed: %+v", test.name, document.Rows)
		}
	}

	incomeExpense := baseMapping()
	incomeExpense.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_INCOME_EXPENSE
	incomeExpense.IncomeColumn, incomeExpense.ExpenseColumn = 1, 2
	content := []byte("time,income,expense\n2026-08-13 10:00:00,10.00,\n2026-08-13 11:00:00,,3.00\n")
	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, options(incomeExpense))
	if err != nil {
		t.Fatalf("parse income-expense CSV: %v", err)
	}
	if document.Rows[0].Normalized.Direction != importing.NORMALIZED_DIRECTION_INCOME || document.Rows[1].Normalized.Direction != importing.NORMALIZED_DIRECTION_EXPENSE {
		t.Fatalf("income-expense direction failed: %+v", document.Rows)
	}
}

func TestParseRejectsSelectedEncodingAndStructuralMappingMismatch(t *testing.T) {
	mapping := baseMapping()
	mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_SIGNED
	mapping.AmountColumn = 1
	mapping.SignedPositiveDirection = importing.NORMALIZED_DIRECTION_INCOME
	invalidUTF8 := []byte("time,amount\n2026-01-01 00:00:00,1.00\xff")
	if _, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: invalidUTF8}, options(mapping)); err == nil || importing.NormalizeEvidenceParseError(ImportEvidenceParser.Descriptor(), err) != importing.ISSUE_CODE_FILE_ENCODING_INVALID {
		t.Fatalf("invalid selected encoding was not rejected safely: %v", err)
	}
	mapping.NoteColumn = 9
	if _, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: []byte("time,amount\n2026-01-01 00:00:00,1.00\n")}, options(mapping)); err == nil {
		t.Fatal("out-of-header mapping was not rejected as a structural error")
	}
}

func TestParsePreservesMultilineCSVLocatorAndRejectsAmountOverflow(t *testing.T) {
	mapping := baseMapping()
	mapping.AmountMode = importing.GENERIC_CSV_AMOUNT_MODE_SIGNED
	mapping.AmountColumn = 1
	mapping.SignedPositiveDirection = importing.NORMALIZED_DIRECTION_INCOME
	mapping.NoteColumn = 2
	content := []byte("time,amount,note\n2026-08-13 10:00:00,1.00,\"line one\nline two\"\n")
	document, err := ImportEvidenceParser.Parse(context.Background(), importing.EvidenceFile{Content: content}, options(mapping))
	if err != nil {
		t.Fatalf("parse multiline CSV: %v", err)
	}
	if len(document.Rows) != 1 || document.Rows[0].Locator.CSVStartRow != 2 || document.Rows[0].Locator.CSVEndRow != 3 || document.Rows[0].Raw.Note != "line one\nline two" {
		t.Fatalf("multiline locator or raw value changed: %+v", document.Rows)
	}
	if _, ok := parseUnsignedAmount("92233720368547758.08"); ok {
		t.Fatal("overflowing minimum-unit amount was accepted")
	}
}

func baseMapping() importing.GenericCSVMapping {
	return importing.GenericCSVMapping{
		Encoding: importing.GENERIC_CSV_ENCODING_UTF8, Delimiter: importing.GENERIC_CSV_DELIMITER_COMMA,
		HeaderRow: 1, TimeFormat: importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS, TimeColumn: 0,
		AmountColumn: -1, DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1, CurrencyColumn: -1,
		TransactionIdColumn: -1, OrderIdColumn: -1, MerchantOrderIdColumn: -1, CounterpartyColumn: -1,
		ItemColumn: -1, PaymentMethodColumn: -1, StatusColumn: -1, TransactionTypeColumn: -1, NoteColumn: -1,
	}
}

func options(mapping importing.GenericCSVMapping) importing.ResolvedParseOptions {
	return importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480, GenericCSVMapping: &mapping}
}
