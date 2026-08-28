package importing_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
)

func TestReparseServiceReturnsPostedBatchWithoutCreatingAnotherParse(t *testing.T) {
	content := []byte("safe-posted-fixture")
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	repository, database := newSQLiteDedupRepository(t, 1)
	file := &importing.ImportFile{
		Uid: 101, FileId: 201, OriginalFileName: "posted.csv", FileSize: int64(len(content)), FileSha256: digestText,
		StorageObjectKey: "objects/posted", ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		CreatedIp: "192.0.2.10", MimeType: "text/csv", FileExtension: "csv", CreatedUnixTime: 100, UpdatedUnixTime: 100,
	}
	batch := testImportBatch(101, 301, 201, 100)
	batch.ParserName = "posted_parser"
	update := &organizer.FinanceUpdate{Uid: 101, UpdateId: 401, Status: organizer.UPDATE_STATUS_POSTED, Version: 4,
		PlanVersion: organizer.PLAN_VERSION_V1, SourceCount: 1, PostedEventCount: 1, FinalEventCount: 1,
		CreatedUnixTime: 100, UpdatedUnixTime: 100}
	source := &organizer.FinanceUpdateSource{Uid: 101, UpdateId: 401, SourceId: 501, SourceOrder: 0,
		FileId: 201, BatchId: 301, SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY),
		ParserVersion: organizer.RuleVersion(batch.ParserVersion), NormalizationVersion: organizer.RuleVersion(batch.NormalizationVersion),
		IdentityKeyVersion: organizer.RuleVersion(batch.IdentityKeyVersion), CreatedUnixTime: 100}
	insertRepositoryBeans(t, database, file, batch, update, source)

	parser := &flowTestParser{descriptor: importing.ParserDescriptor{
		Name: "posted_parser", SourceType: importing.SOURCE_TYPE_ALIPAY, Format: importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		ParserVersion: batch.ParserVersion, NormalizationVersion: batch.NormalizationVersion,
	}}
	service, err := importing.NewReparseService(repository, &flowTestStorage{content: content, expectedSHA256: digestText},
		[]importing.ImportEvidenceParser{parser}, &flowTestSourceAccounts{}, new(flowTestPersister))
	if err != nil {
		t.Fatalf("create posted reparse service: %v", err)
	}
	result, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{Uid: 101, FileId: 201,
		ParseOptions: importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480}, ReparseReasonCode: "duplicate_upload_reparse"})
	if err != nil || result == nil || !result.AlreadyPosted || result.Batch == nil || result.Batch.BatchId != 301 || parser.parseCalls != 0 {
		t.Fatalf("posted file was reparsed: result=%+v parseCalls=%d err=%v", result, parser.parseCalls, err)
	}
	batches, total, err := repository.ListImportBatches(nil, 101, 201, 0, 100)
	if err != nil || total != 1 || len(batches) != 1 || batches[0].BatchId != 301 {
		t.Fatalf("posted duplicate created another batch: total=%d batches=%d err=%v", total, len(batches), err)
	}
}

func TestRepositoryFindsLegacyPostedBatchByFileId(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	file := &importing.ImportFile{
		Uid: 101, FileId: 201, OriginalFileName: "legacy.csv", FileSize: 1, FileSha256: strings.Repeat("a", 64),
		StorageObjectKey: "objects/legacy", ContentState: importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		CreatedIp: "192.0.2.10", MimeType: "text/csv", FileExtension: "csv", CreatedUnixTime: 100, UpdatedUnixTime: 100,
	}
	batch := testImportBatch(101, 301, 201, 100)
	posting := &importing.ImportPosting{
		Uid: 101, BatchId: 301, PostingId: 401,
		IdempotencyKeyDigest: strings.Repeat("b", 64), IdempotencyKeyVersion: importing.IDEMPOTENCY_KEY_VERSION_V1,
		RequestDigest: strings.Repeat("c", 64), RequestDigestVersion: importing.POSTING_REQUEST_VERSION_V1,
		Status: importing.IMPORT_POSTING_STATUS_COMPLETED, SelectedRowCount: 1, CreatedTransactionCount: 1,
		CreatedUnixTime: 100, UpdatedUnixTime: 100,
	}
	insertRepositoryBeans(t, database, file, batch, posting)

	found, err := repository.FindPostedImportBatchByFileId(nil, 101, 201)
	if err != nil || found == nil || found.BatchId != 301 {
		t.Fatalf("legacy posting evidence did not protect the batch: batch=%+v err=%v", found, err)
	}
}

func TestReparseServicePersistsUniqueParserWithStableAccount(t *testing.T) {
	content := []byte("safe-fixture")
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	repository, database := newSQLiteDedupRepository(t, 1)
	file := &importing.ImportFile{
		Uid:              101,
		FileId:           201,
		OriginalFileName: "fixture.csv",
		FileSize:         int64(len(content)),
		FileSha256:       digestText,
		StorageObjectKey: "objects/opaque",
		ContentState:     importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		CreatedIp:        "192.0.2.10",
		MimeType:         "text/csv",
		FileExtension:    "csv",
		CreatedUnixTime:  100,
		UpdatedUnixTime:  100,
	}
	insertRepositoryBeans(t, database, file)
	candidate, _ := dedupSourceAccountEvidence(t)
	document := dedupEvidenceDocument(candidate, []importing.EvidenceRow{dedupValidRow(1, "tx-flow-1", 100, false)})
	parser := &flowTestParser{
		descriptor: dedupParserDescriptor(),
		probe: importing.ProbeResult{
			Confidence: importing.PROBE_CONFIDENCE_EXACT,
			SourceType: importing.SOURCE_TYPE_ALIPAY,
			Format:     importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV,
		},
		document: document,
	}
	nextId := int64(1000)
	generateId := func() int64 {
		nextId++
		return nextId
	}
	accounts, err := importing.NewSourceAccountService(repository, generateId)
	if err != nil {
		t.Fatalf("create source account service: %v", err)
	}
	persister, err := importing.NewDedupService(repository, generateId)
	if err != nil {
		t.Fatalf("create dedup service: %v", err)
	}
	service, err := importing.NewReparseService(
		repository,
		&flowTestStorage{content: content, expectedSHA256: digestText},
		[]importing.ImportEvidenceParser{parser},
		accounts,
		persister,
	)
	if err != nil {
		t.Fatalf("create FLOW-101 SQLite service: %v", err)
	}

	first, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "manual_reparse",
	})
	if err != nil {
		t.Fatalf("reparse stable evidence: %v", err)
	}

	second, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "retry_reparse",
	})
	if err != nil {
		t.Fatalf("repeat stable reparse: %v", err)
	}

	savedAccounts, err := accounts.ListSourceAccounts(nil, 101)
	if err != nil {
		t.Fatalf("list resolved source accounts: %v", err)
	}
	batches, total, err := repository.ListImportBatches(nil, 101, 201, 0, 100)
	if err != nil {
		t.Fatalf("list persisted reparse batches: %v", err)
	}

	if first.Batch == nil || second.Batch == nil || first.Batch.BatchId == second.Batch.BatchId ||
		first.SourceAccount == nil || second.SourceAccount == nil ||
		first.SourceAccount.SourceAccountId != second.SourceAccount.SourceAccountId ||
		first.Discovery == nil || first.Discovery.DisplayName == candidate.Identifier ||
		len(savedAccounts) != 1 || len(batches) != 1 || total != 1 || batches[0].BatchId != second.Batch.BatchId {
		t.Fatalf("SQLite reparse did not converge on one source account and one active batch")
	}
	oldBatch, err := repository.FindImportBatchById(nil, 101, first.Batch.BatchId)
	if err != nil || oldBatch == nil || oldBatch.Status != importing.IMPORT_BATCH_STATUS_DISCARDED {
		t.Fatalf("superseded unposted batch was not discarded: batch=%+v err=%v", oldBatch, err)
	}

	_, err = service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               102,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "cross_user",
	})
	if !errors.Is(err, importing.ErrImportFileNotFound) {
		t.Fatalf("cross-user reparse did not hide the file: %v", err)
	}
}

func TestReparseServiceAutoCreatesUniqueWeChatDisplayAccount(t *testing.T) {
	content := []byte("safe-fixture")
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	repository, database := newSQLiteDedupRepository(t, 1)
	file := &importing.ImportFile{
		Uid:              101,
		FileId:           201,
		OriginalFileName: "fixture.csv",
		FileSize:         int64(len(content)),
		FileSha256:       digestText,
		StorageObjectKey: "objects/opaque",
		ContentState:     importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
		CreatedIp:        "192.0.2.10",
		MimeType:         "text/csv",
		FileExtension:    "csv",
		CreatedUnixTime:  100,
		UpdatedUnixTime:  100,
	}
	insertRepositoryBeans(t, database, file)
	candidate := importing.SourceAccountCandidate{
		Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY,
		DisplayName:     "微信昵称",
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME,
	}
	document := &importing.EvidenceDocument{
		Metadata: importing.DocumentMetadata{SourceType: importing.SOURCE_TYPE_WECHAT, SourceAccount: candidate},
		Rows:     []importing.EvidenceRow{dedupValidRow(1, "tx-flow-2", 100, false)},
	}
	descriptor := importing.ParserDescriptor{
		Name:                 "flow_wechat_csv",
		SourceType:           importing.SOURCE_TYPE_WECHAT,
		Format:               importing.EVIDENCE_FORMAT_WECHAT_CSV,
		ParserVersion:        "parser-v1",
		NormalizationVersion: "normalization-v1",
	}
	parser := &flowTestParser{
		descriptor: descriptor,
		probe: importing.ProbeResult{
			Confidence: importing.PROBE_CONFIDENCE_EXACT,
			SourceType: importing.SOURCE_TYPE_WECHAT,
			Format:     importing.EVIDENCE_FORMAT_WECHAT_CSV,
		},
		document: document,
	}
	nextId := int64(1000)
	generateId := func() int64 {
		nextId++
		return nextId
	}
	accounts, err := importing.NewSourceAccountService(repository, generateId)
	if err != nil {
		t.Fatalf("create source account service: %v", err)
	}
	persister, err := importing.NewDedupService(repository, generateId)
	if err != nil {
		t.Fatalf("create dedup service: %v", err)
	}
	service, err := importing.NewReparseService(
		repository,
		&flowTestStorage{content: content, expectedSHA256: digestText},
		[]importing.ImportEvidenceParser{parser},
		accounts,
		persister,
	)
	if err != nil {
		t.Fatalf("create FLOW-101 SQLite service: %v", err)
	}

	first, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "initial_parse",
	})
	if err != nil || first == nil || first.Batch == nil || first.SourceAccount == nil {
		t.Fatalf("wechat display evidence was not auto-created: %+v %v", first, err)
	}
	second, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "repeat_parse",
	})
	if err != nil || second == nil || second.SourceAccount == nil ||
		second.SourceAccount.SourceAccountId != first.SourceAccount.SourceAccountId {
		t.Fatalf("same wechat original was not reused: first=%+v second=%+v err=%v", first.SourceAccount, second.SourceAccount, err)
	}
}

func TestReparseServiceRejectsHighestConfidenceTie(t *testing.T) {
	content := []byte("safe-fixture")
	first := &flowTestParser{
		descriptor: dedupParserDescriptor(),
		probe:      importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_EXACT, SourceType: importing.SOURCE_TYPE_ALIPAY, Format: importing.EVIDENCE_FORMAT_ALIPAY_APP_CSV},
	}
	secondDescriptor := dedupParserDescriptor()
	secondDescriptor.Name = "flow_alipay_web"
	secondDescriptor.Format = importing.EVIDENCE_FORMAT_ALIPAY_WEB_CSV
	second := &flowTestParser{
		descriptor: secondDescriptor,
		probe:      importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_EXACT, SourceType: importing.SOURCE_TYPE_ALIPAY, Format: importing.EVIDENCE_FORMAT_ALIPAY_WEB_CSV},
	}
	service := newFlowTestService(t, content, []importing.ImportEvidenceParser{first, second}, new(flowTestSourceAccounts), new(flowTestPersister))

	_, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "manual_reparse",
	})
	if !errors.Is(err, importing.ErrImportFormatInvalid) || first.parseCalls != 0 || second.parseCalls != 0 {
		t.Fatalf("ambiguous parser tie was not rejected safely: %v", err)
	}
}

func TestReparseServicePrefersSourceSpecificParserOverGenericFallback(t *testing.T) {
	content := []byte("safe-fixture")
	specific := &flowTestParser{
		descriptor: importing.ParserDescriptor{
			Name: "wechat-pay-csv-evidence", SourceType: importing.SOURCE_TYPE_WECHAT, Format: importing.EVIDENCE_FORMAT_WECHAT_CSV,
			ParserVersion: "wechat-parser-v1", NormalizationVersion: "wechat-normalization-v1",
		},
		probe: importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_POSSIBLE, SourceType: importing.SOURCE_TYPE_WECHAT, Format: importing.EVIDENCE_FORMAT_WECHAT_CSV},
		document: &importing.EvidenceDocument{Metadata: importing.DocumentMetadata{SourceType: importing.SOURCE_TYPE_WECHAT, SourceAccount: importing.SourceAccountCandidate{
			Kind: importing.SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY, DisplayName: "合成昵称", DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME,
		}}},
	}
	generic := &flowTestParser{
		descriptor: importing.ParserDescriptor{
			Name: "generic_bank_csv", SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV,
			ParserVersion: "generic-bank-parser-v2", NormalizationVersion: "generic-bank-normalization-v2",
		},
		probe: importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_POSSIBLE, SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV},
	}
	accounts := &flowTestSourceAccounts{resolved: &importing.SourceAccount{
		Uid: 101, SourceAccountId: 301, SourceType: importing.SOURCE_TYPE_WECHAT, Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		SourceAccountKey: strings.Repeat("f", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
	}}
	persister := new(flowTestPersister)
	service := newFlowTestService(t, content, []importing.ImportEvidenceParser{specific, generic}, accounts, persister)
	result, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid: 101, FileId: 201, ParseOptions: importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480}, ReparseReasonCode: "specific_before_fallback",
	})
	if err != nil || result == nil || result.Descriptor.Name != specific.descriptor.Name || specific.parseCalls != 1 || generic.parseCalls != 0 {
		t.Fatalf("source-specific parser did not outrank generic fallback: result=%+v specific=%d generic=%d err=%v", result, specific.parseCalls, generic.parseCalls, err)
	}
}

func TestReparseServiceSkipsGenericBankUnlessExplicitlySelected(t *testing.T) {
	descriptor := importing.ParserDescriptor{
		Name: "generic_bank_csv", SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV,
		ParserVersion: "generic-bank-parser-v1", NormalizationVersion: "generic-bank-normalization-v1", ExplicitSelectionOnly: true,
	}
	parser := &flowTestParser{
		descriptor: descriptor,
		probe:      importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_POSSIBLE, SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV},
		document: &importing.EvidenceDocument{Metadata: importing.DocumentMetadata{SourceType: importing.SOURCE_TYPE_BANK, SourceAccount: importing.SourceAccountCandidate{
			Kind: importing.SOURCE_ACCOUNT_EVIDENCE_MISSING, DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
		}}},
	}
	ledgerAccountId := int64(701)
	accounts := &flowTestSourceAccounts{selected: &importing.SourceAccount{
		Uid: 101, SourceAccountId: 301, SourceType: importing.SOURCE_TYPE_BANK, LedgerAccountId: &ledgerAccountId,
		Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE, SourceAccountKey: strings.Repeat("b", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
	}}
	persister := new(flowTestPersister)
	service := newFlowTestService(t, []byte("time,amount\n"), []importing.ImportEvidenceParser{parser}, accounts, persister)
	mapping := importing.GenericBankMapping{
		Encoding: importing.GENERIC_CSV_ENCODING_UTF8, Delimiter: importing.GENERIC_CSV_DELIMITER_COMMA, SheetIndex: -1, HeaderRow: 1,
		TimeFormat: importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS, AmountMode: importing.GENERIC_CSV_AMOUNT_MODE_SIGNED,
		SignedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE, TimeColumn: 0, AmountColumn: 1,
		DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1, CurrencyColumn: -1, TransactionIdColumn: -1,
		OrderIdColumn: -1, MerchantOrderIdColumn: -1, CounterpartyColumn: -1, ItemColumn: -1,
		PaymentMethodColumn: -1, StatusColumn: -1, TransactionTypeColumn: -1, NoteColumn: -1,
	}
	base := importing.ReparseImportFileRequest{
		Uid: 101, FileId: 201, SourceAccountId: 301,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480, GenericBankMapping: &mapping},
		ReparseReasonCode: "generic_bank_test",
	}
	if _, err := service.ReparseImportFile(nil, base); !errors.Is(err, importing.ErrImportFormatInvalid) || parser.parseCalls != 0 {
		t.Fatalf("auto detection did not skip explicit-only parser: calls=%d err=%v", parser.parseCalls, err)
	}
	base.ParserName = descriptor.Name
	base.SourceAccountId = 0
	accounts.fileEnsured = &importing.SourceAccount{
		Uid: 101, SourceAccountId: 501, SourceType: importing.SOURCE_TYPE_BANK,
		Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE, SourceAccountKey: strings.Repeat("d", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
	}
	auto, err := service.ReparseImportFile(nil, base)
	if err != nil || auto == nil || auto.Batch == nil || persister.calls != 1 || accounts.fileCalls != 1 {
		t.Fatalf("generic bank parser did not auto-create original identity: result=%+v calls=%d file=%d err=%v", auto, persister.calls, accounts.fileCalls, err)
	}
	base.SourceAccountId = 301
	accounts.selected.LedgerAccountId = nil
	result, err := service.ReparseImportFile(nil, base)
	if err != nil || result == nil || result.Batch == nil || persister.calls != 2 || parser.parseCalls != 2 {
		t.Fatalf("explicit generic bank reparse failed: result=%+v calls=%d parse=%d err=%v", result, persister.calls, parser.parseCalls, err)
	}
	if persister.request.ParseOptions.GenericBankMapping == nil || persister.request.Descriptor.Name != descriptor.Name {
		t.Fatalf("explicit parser or mapping was not carried to persistence: %+v", persister.request)
	}
}

func TestReparseServicePersistsAutomaticallyResolvedGenericBankOptions(t *testing.T) {
	descriptor := importing.ParserDescriptor{
		Name: "generic_bank_csv", SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV,
		ParserVersion: "generic-bank-parser-v2", NormalizationVersion: "generic-bank-normalization-v2",
	}
	mapping := importing.GenericBankMapping{
		Encoding: importing.GENERIC_CSV_ENCODING_UTF8, Delimiter: importing.GENERIC_CSV_DELIMITER_COMMA, SheetIndex: -1,
		HeaderRow: 1, DataStartRow: 2, DataEndRow: 2, TimeFormat: importing.GENERIC_CSV_TIME_FORMAT_DATE_TIME_SECONDS,
		AmountMode: importing.GENERIC_CSV_AMOUNT_MODE_SIGNED, SignedPositiveDirection: importing.NORMALIZED_DIRECTION_EXPENSE,
		TimeColumn: 0, AmountColumn: 1, DirectionColumn: -1, IncomeColumn: -1, ExpenseColumn: -1, CurrencyColumn: -1,
		TransactionIdColumn: -1, OrderIdColumn: -1, MerchantOrderIdColumn: -1, CounterpartyColumn: -1, ItemColumn: -1,
		PaymentMethodColumn: -1, StatusColumn: -1, TransactionTypeColumn: -1, NoteColumn: -1,
	}
	baseParser := &flowTestParser{
		descriptor: descriptor,
		probe:      importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_POSSIBLE, SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV},
		document: &importing.EvidenceDocument{Metadata: importing.DocumentMetadata{SourceType: importing.SOURCE_TYPE_BANK, SourceAccount: importing.SourceAccountCandidate{
			Kind: importing.SOURCE_ACCOUNT_EVIDENCE_MISSING, DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
		}}},
	}
	parser := &flowTestResolvingParser{flowTestParser: baseParser, mapping: mapping}
	accounts := &flowTestSourceAccounts{fileEnsured: &importing.SourceAccount{
		Uid: 101, SourceAccountId: 501, SourceType: importing.SOURCE_TYPE_BANK, Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		SourceAccountKey: strings.Repeat("e", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
	}}
	persister := new(flowTestPersister)
	service := newFlowTestService(t, []byte("time,amount\n2026-01-01 00:00:00,1.00\n"), []importing.ImportEvidenceParser{parser}, accounts, persister)

	result, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid: 101, FileId: 201, ParseOptions: importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "automatic_generic_bank",
	})
	if err != nil || result == nil || result.Batch == nil || parser.resolveCalls != 1 || baseParser.parseCalls != 1 || persister.calls != 1 {
		t.Fatalf("automatic generic bank options were not resolved and persisted: result=%+v resolve=%d parse=%d persist=%d err=%v", result, parser.resolveCalls, baseParser.parseCalls, persister.calls, err)
	}
	if baseParser.lastOptions.GenericBankMapping == nil || persister.request.ParseOptions.GenericBankMapping == nil ||
		baseParser.lastOptions.GenericBankMapping.DataEndRow != 2 || persister.request.ParseOptions.GenericBankMapping.DataEndRow != 2 {
		t.Fatalf("resolved options did not reach parsing and persistence: parse=%+v persist=%+v", baseParser.lastOptions, persister.request.ParseOptions)
	}
}

func TestReparseServicePersistsCebCreditWithoutSourceAccount(t *testing.T) {
	descriptor := importing.ParserDescriptor{
		Name: "ceb_credit_pdf", SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF,
		ParserVersion: "ceb-credit-pdf-parser-v1", NormalizationVersion: "ceb-credit-pdf-normalization-v1", ExplicitSelectionOnly: true,
	}
	parser := &flowTestParser{
		descriptor: descriptor,
		probe:      importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_EXACT, SourceType: importing.SOURCE_TYPE_BANK, Format: importing.EVIDENCE_FORMAT_CEB_CREDIT_PDF},
		document: &importing.EvidenceDocument{Metadata: importing.DocumentMetadata{SourceType: importing.SOURCE_TYPE_BANK, SourceAccount: importing.SourceAccountCandidate{
			Kind: importing.SOURCE_ACCOUNT_EVIDENCE_MISSING, DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_MISSING,
		}}},
	}
	accounts := &flowTestSourceAccounts{ensured: &importing.SourceAccount{
		Uid: 101, SourceAccountId: 401, SourceType: importing.SOURCE_TYPE_BANK,
		Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE, SourceAccountKey: strings.Repeat("c", 64), SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
	}}
	persister := new(flowTestPersister)
	service := newFlowTestService(t, []byte("%PDF-1.4"), []importing.ImportEvidenceParser{parser}, accounts, persister)
	result, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid: 101, FileId: 201, ParserName: descriptor.Name,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "user_selected_ceb_credit_pdf",
	})
	if err != nil || result == nil || result.Batch == nil || persister.calls != 1 || accounts.ensureCalls != 1 || parser.parseCalls != 1 {
		t.Fatalf("CEB parser did not persist without a ledger mapping: result=%+v ensure=%d persist=%d parse=%d err=%v", result, accounts.ensureCalls, persister.calls, parser.parseCalls, err)
	}
	if persister.request.SourceAccountId != 401 || persister.request.Descriptor.Name != descriptor.Name {
		t.Fatalf("CEB persistence used the wrong identity scope: %+v", persister.request)
	}
}

func newFlowTestService(t *testing.T, content []byte, parsers []importing.ImportEvidenceParser, accounts *flowTestSourceAccounts, persister *flowTestPersister) *importing.ReparseService {
	t.Helper()
	repository := &flowTestFileRepository{file: &importing.ImportFile{
		Uid:              101,
		FileId:           201,
		OriginalFileName: "fixture.csv",
		FileSize:         int64(len(content)),
		FileSha256:       strings.Repeat("a", 64),
		StorageObjectKey: "objects/opaque",
		ContentState:     importing.IMPORT_FILE_CONTENT_STATE_AVAILABLE,
	}}
	storage := &flowTestStorage{content: content}
	service, err := importing.NewReparseService(repository, storage, parsers, accounts, persister)
	if err != nil {
		t.Fatalf("create FLOW-101 service: %v", err)
	}
	return service
}

type flowTestFileRepository struct {
	file        *importing.ImportFile
	postedBatch *importing.ImportBatch
}

func (r *flowTestFileRepository) FindImportFileById(_ core.Context, uid int64, fileId int64) (*importing.ImportFile, error) {
	if r.file == nil || r.file.Uid != uid || r.file.FileId != fileId {
		return nil, nil
	}
	copy := *r.file
	return &copy, nil
}

func (r *flowTestFileRepository) FindPostedImportBatchByFileId(_ core.Context, uid int64, fileId int64) (*importing.ImportBatch, error) {
	if r.postedBatch == nil || r.postedBatch.Uid != uid || r.postedBatch.FileId != fileId {
		return nil, nil
	}
	copy := *r.postedBatch
	return &copy, nil
}

type flowTestStorage struct {
	content        []byte
	expectedSHA256 string
}

func (s *flowTestStorage) ReadAvailable(_ core.Context, _ string, expectedSHA256 string, expectedSize int64) ([]byte, error) {
	if int64(len(s.content)) != expectedSize || (s.expectedSHA256 != "" && s.expectedSHA256 != expectedSHA256) {
		return nil, errors.New("unexpected size")
	}
	return append([]byte(nil), s.content...), nil
}

type flowTestParser struct {
	descriptor  importing.ParserDescriptor
	probe       importing.ProbeResult
	document    *importing.EvidenceDocument
	lastOptions importing.ResolvedParseOptions
	parseCalls  int
}

func (p *flowTestParser) Descriptor() importing.ParserDescriptor {
	return p.descriptor
}

func (p *flowTestParser) Probe(_ context.Context, _ importing.EvidenceFile) importing.ProbeResult {
	return p.probe
}

func (p *flowTestParser) Parse(_ context.Context, _ importing.EvidenceFile, options importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	p.parseCalls++
	p.lastOptions = options
	return p.document, nil
}

type flowTestResolvingParser struct {
	*flowTestParser
	mapping      importing.GenericBankMapping
	resolveCalls int
}

func (p *flowTestResolvingParser) ResolveParseOptions(_ context.Context, _ importing.EvidenceFile, options importing.ResolvedParseOptions) (importing.ResolvedParseOptions, error) {
	p.resolveCalls++
	options.GenericBankMapping = &p.mapping
	return options, nil
}

type flowTestSourceAccounts struct {
	selected     *importing.SourceAccount
	resolved     *importing.SourceAccount
	ensured      *importing.SourceAccount
	fileEnsured  *importing.SourceAccount
	resolveCalls int
	ensureCalls  int
	fileCalls    int
}

func (s *flowTestSourceAccounts) FindSourceAccount(_ core.Context, _ int64, _ int64) (*importing.SourceAccount, error) {
	return s.selected, nil
}

func (s *flowTestSourceAccounts) ResolveStableSourceAccount(_ core.Context, _ int64, _ importing.SourceType, _ importing.SourceAccountCandidate) (*importing.SourceAccount, error) {
	s.resolveCalls++
	return s.resolved, nil
}

func (s *flowTestSourceAccounts) ResolveDisplaySourceAccount(_ core.Context, _ int64, _ importing.SourceType, _ importing.SourceAccountCandidate) (*importing.SourceAccount, error) {
	return s.resolved, nil
}

func (s *flowTestSourceAccounts) EnsureFileSourceAccount(_ core.Context, _ int64, _ importing.SourceType, _ importing.EvidenceFormat, _ string) (*importing.SourceAccount, error) {
	s.fileCalls++
	return s.fileEnsured, nil
}

func (s *flowTestSourceAccounts) EnsureCebCreditSourceAccount(_ core.Context, _ int64) (*importing.SourceAccount, error) {
	s.ensureCalls++
	return s.ensured, nil
}

type flowTestPersister struct {
	request importing.PersistEvidenceDocumentRequest
	calls   int
}

func (p *flowTestPersister) PersistEvidenceDocument(_ core.Context, request importing.PersistEvidenceDocumentRequest) (*importing.ImportBatch, error) {
	p.calls++
	p.request = request
	return &importing.ImportBatch{Uid: request.Uid, FileId: request.FileId, BatchId: 401}, nil
}
