package importing

import (
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/models"
)

func TestNormalizePostingRequestDigestIgnoresCommandRowAndTagOrder(t *testing.T) {
	first := PostImportBatchRequest{
		Uid:            1001,
		BatchId:        2001,
		IdempotencyKey: "posting-request-1",
		CreatedIp:      "192.0.2.1",
		Commands: []PostingIdentityCommand{
			{
				RowIds: []int64{4, 3},
				Draft: &LedgerTransactionDraft{
					Type:            models.TRANSACTION_TYPE_EXPENSE,
					CategoryId:      51,
					UnixTime:        1_700_000_000,
					SourceAccountId: 61,
					SourceAmount:    123,
					TagIds:          []int64{73, 72},
					Comment:         "fixture",
				},
			},
			{RowIds: []int64{2, 1}},
		},
	}
	second := first
	second.Commands = []PostingIdentityCommand{
		{RowIds: []int64{1, 2}},
		{
			RowIds: []int64{3, 4},
			Draft: &LedgerTransactionDraft{
				Type:            models.TRANSACTION_TYPE_EXPENSE,
				CategoryId:      51,
				UnixTime:        1_700_000_000,
				SourceAccountId: 61,
				SourceAmount:    123,
				TagIds:          []int64{72, 73},
				Comment:         "fixture",
			},
		},
	}

	_, firstKey, firstDigest, _, err := normalizePostingRequest(first)

	if err != nil {
		t.Fatalf("normalize first request: %v", err)
	}

	_, secondKey, secondDigest, _, err := normalizePostingRequest(second)

	if err != nil {
		t.Fatalf("normalize reordered request: %v", err)
	}

	if firstKey != secondKey || firstDigest != secondDigest {
		t.Fatal("canonical posting digest changed after order-only differences")
	}
}
