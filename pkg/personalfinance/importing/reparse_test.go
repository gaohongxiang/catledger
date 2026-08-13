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
)

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
		len(savedAccounts) != 1 || len(batches) != 2 || total != 2 {
		t.Fatalf("SQLite reparse did not converge on one source account and two immutable batches")
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

func TestReparseServiceRequiresSelectionForWeakSourceEvidence(t *testing.T) {
	content := []byte("safe-fixture")
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
	accounts := new(flowTestSourceAccounts)
	persister := new(flowTestPersister)
	service := newFlowTestService(t, content, []importing.ImportEvidenceParser{parser}, accounts, persister)

	result, err := service.ReparseImportFile(nil, importing.ReparseImportFileRequest{
		Uid:               101,
		FileId:            201,
		ParseOptions:      importing.ResolvedParseOptions{Currency: "CNY", TimezoneUtcOffset: 480},
		ReparseReasonCode: "initial_parse",
	})
	if err != nil {
		t.Fatalf("inspect weak source evidence: %v", err)
	}

	if result.Batch != nil || result.SourceAccount != nil || result.Discovery == nil ||
		result.Discovery.DisplayName == "" || persister.calls != 0 || accounts.resolveCalls != 0 {
		t.Fatalf("weak evidence must wait for an explicit source account: %+v", result)
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
	file *importing.ImportFile
}

func (r *flowTestFileRepository) FindImportFileById(_ core.Context, uid int64, fileId int64) (*importing.ImportFile, error) {
	if r.file == nil || r.file.Uid != uid || r.file.FileId != fileId {
		return nil, nil
	}
	copy := *r.file
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
	descriptor importing.ParserDescriptor
	probe      importing.ProbeResult
	document   *importing.EvidenceDocument
	parseCalls int
}

func (p *flowTestParser) Descriptor() importing.ParserDescriptor {
	return p.descriptor
}

func (p *flowTestParser) Probe(_ context.Context, _ importing.EvidenceFile) importing.ProbeResult {
	return p.probe
}

func (p *flowTestParser) Parse(_ context.Context, _ importing.EvidenceFile, _ importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	p.parseCalls++
	return p.document, nil
}

type flowTestSourceAccounts struct {
	selected     *importing.SourceAccount
	resolved     *importing.SourceAccount
	resolveCalls int
}

func (s *flowTestSourceAccounts) FindSourceAccount(_ core.Context, _ int64, _ int64) (*importing.SourceAccount, error) {
	return s.selected, nil
}

func (s *flowTestSourceAccounts) ResolveStableSourceAccount(_ core.Context, _ int64, _ importing.SourceType, _ importing.SourceAccountCandidate) (*importing.SourceAccount, error) {
	s.resolveCalls++
	return s.resolved, nil
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
