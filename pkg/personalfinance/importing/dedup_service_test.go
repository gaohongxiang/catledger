package importing

import "testing"

func TestParseOptionsDigestGolden(t *testing.T) {
	digest := computeParseOptionsDigest(ResolvedParseOptions{
		Currency:          "CNY",
		TimezoneUtcOffset: 480,
	})

	const expected = "da36560a5df81665beccfb810984c1bfb73a7948a0b6e354e073675018fc2eaf"

	if digest != expected {
		t.Fatalf("parse options digest changed: got %s, expected %s", digest, expected)
	}

	changed := computeParseOptionsDigest(ResolvedParseOptions{
		Currency:          "CNY",
		TimezoneUtcOffset: 0,
	})

	if changed == digest {
		t.Fatal("timezone did not change the parse options digest")
	}
}

func TestPersistentEvidenceSnapshotBytesCoversEveryRawString(t *testing.T) {
	row := &RawImportRow{
		SourceLocator:         "1",
		SourceTransactionId:   "22",
		SourceOrderId:         "333",
		SourceMerchantOrderId: "4444",
		RawTransactionTime:    "55555",
		RawAmount:             "666666",
		RawDirection:          "7777777",
		RawStatus:             "88888888",
		RawTransactionType:    "999999999",
		RawCounterparty:       "aaaaaaaaaa",
		RawItem:               "bbbbbbbbbbb",
		RawPaymentMethod:      "cccccccccccc",
		RawNote:               "ddddddddddddd",
		RawFieldsJson:         "eeeeeeeeeeeeee",
		IssuesJson:            "fffffffffffffff",
	}

	const expected = 120

	if actual := persistentEvidenceSnapshotBytes(row); actual != expected {
		t.Fatalf("unexpected complete raw snapshot size: got %d, expected %d", actual, expected)
	}
}
