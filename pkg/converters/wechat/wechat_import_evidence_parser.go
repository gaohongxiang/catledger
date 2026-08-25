package wechat

import (
	"bytes"
	"context"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

const (
	wechatPayCsvEvidenceParserName    = "wechat-pay-csv-evidence"
	wechatPayXlsxEvidenceParserName   = "wechat-pay-xlsx-evidence"
	wechatPayCsvParserVersion         = importing.RuleVersion("wechat-csv-parser-v1")
	wechatPayXlsxParserVersion        = importing.RuleVersion("wechat-xlsx-parser-v1")
	wechatPayNormalizationVersion     = importing.RuleVersion("wechat-normalization-v2")
	wechatPayIssueFilePreambleMissing = importing.IssueCode("wechat_file_preamble_missing")
	wechatPayIssueSheetStructure      = importing.IssueCode("wechat_sheet_structure_ignored")
	wechatPayIssueNicknameInvalid     = importing.IssueCode("wechat_source_account_nickname_invalid")
	wechatPayIssueNicknameConflict    = importing.IssueCode("wechat_source_account_nickname_conflict")
	wechatPayIssueStatementInvalid    = importing.IssueCode("wechat_statement_period_invalid")
	wechatPayIssueDocumentNoRows      = importing.IssueCode("wechat_document_no_data_rows")
	wechatPayIssueRowEmpty            = importing.IssueCode("wechat_row_empty")
	wechatPayIssueRowRepeatedHeader   = importing.IssueCode("wechat_row_repeated_header")
	wechatPayIssueRowFieldTooLong     = importing.IssueCode("wechat_row_field_too_long")
	wechatPayIssueRowExtraColumns     = importing.IssueCode("wechat_row_extra_columns")
	wechatPayIssueXlsxFormula         = importing.IssueCode("wechat_xlsx_formula_unsupported")
)

// WeChatPayImportEvidenceCsvParser 解析微信支付 CSV，并保留每条逻辑数据行的物理证据。
var WeChatPayImportEvidenceCsvParser importing.ImportEvidenceParser = &wechatPayImportEvidenceParser{
	descriptor: importing.ParserDescriptor{
		Name:                 wechatPayCsvEvidenceParserName,
		SourceType:           importing.SOURCE_TYPE_WECHAT,
		Format:               importing.EVIDENCE_FORMAT_WECHAT_CSV,
		ParserVersion:        wechatPayCsvParserVersion,
		NormalizationVersion: wechatPayNormalizationVersion,
	},
}

// WeChatPayImportEvidenceXlsxParser 解析微信支付 XLSX，并保留 sheet 与物理行证据。
var WeChatPayImportEvidenceXlsxParser importing.ImportEvidenceParser = &wechatPayImportEvidenceParser{
	descriptor: importing.ParserDescriptor{
		Name:                 wechatPayXlsxEvidenceParserName,
		SourceType:           importing.SOURCE_TYPE_WECHAT,
		Format:               importing.EVIDENCE_FORMAT_WECHAT_XLSX,
		ParserVersion:        wechatPayXlsxParserVersion,
		NormalizationVersion: wechatPayNormalizationVersion,
	},
}

type wechatPayImportEvidenceParser struct {
	descriptor importing.ParserDescriptor
}

func (p *wechatPayImportEvidenceParser) Descriptor() importing.ParserDescriptor {
	return p.descriptor
}

func (p *wechatPayImportEvidenceParser) Probe(ctx context.Context, file importing.EvidenceFile) importing.ProbeResult {
	if ctx.Err() != nil {
		return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
	}

	sheets, err := p.readSheets(ctx, file.Content)

	if err != nil {
		if ctx.Err() != nil {
			return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
		}

		confidence := importing.PROBE_CONFIDENCE_NONE

		if p.descriptor.Format == importing.EVIDENCE_FORMAT_WECHAT_XLSX && hasOOXMLZipHeader(file.Content) {
			confidence = importing.PROBE_CONFIDENCE_POSSIBLE
		}

		return p.probeResult(confidence, importing.NormalizeEvidenceParseError(p.descriptor, err))
	}

	summary := summarizeWechatEvidenceSheets(sheets)

	if summary.headerCount > 0 && summary.hasMarker {
		return p.probeResult(importing.PROBE_CONFIDENCE_EXACT, importing.ISSUE_CODE_NONE)
	}

	if summary.headerCount > 0 {
		return p.probeResult(importing.PROBE_CONFIDENCE_POSSIBLE, wechatPayIssueFilePreambleMissing)
	}

	if summary.hasMarker {
		return p.probeResult(importing.PROBE_CONFIDENCE_POSSIBLE, importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	return importing.ProbeResult{Confidence: importing.PROBE_CONFIDENCE_NONE}
}

func (p *wechatPayImportEvidenceParser) Parse(ctx context.Context, file importing.EvidenceFile, opts importing.ResolvedParseOptions) (*importing.EvidenceDocument, error) {
	if err := opts.Validate(); err != nil {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	sheets, err := p.readSheets(ctx, file.Content)

	if err != nil {
		return nil, err
	}

	document, err := buildWechatEvidenceDocument(ctx, p.descriptor, sheets, opts)

	if err != nil {
		return nil, err
	}

	if _, err := importing.ValidateEvidenceDocument(p.descriptor, document); err != nil {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	return document, nil
}

func (p *wechatPayImportEvidenceParser) readSheets(ctx context.Context, content []byte) ([]wechatEvidenceSheet, error) {
	switch p.descriptor.Format {
	case importing.EVIDENCE_FORMAT_WECHAT_CSV:
		return readWechatEvidenceCsv(ctx, content)
	case importing.EVIDENCE_FORMAT_WECHAT_XLSX:
		return readWechatEvidenceXlsx(ctx, content)
	default:
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_FORMAT_INVALID)
	}
}

func (p *wechatPayImportEvidenceParser) probeResult(confidence importing.ProbeConfidence, issueCode importing.IssueCode) importing.ProbeResult {
	result := importing.ProbeResult{
		Confidence: confidence,
		IssueCode:  issueCode,
	}

	if confidence.Matched() {
		result.SourceType = p.descriptor.SourceType
		result.Format = p.descriptor.Format
	}

	return result
}

func hasOOXMLZipHeader(content []byte) bool {
	return len(content) >= 4 && bytes.Equal(content[:4], []byte{'P', 'K', 0x03, 0x04})
}

func newWechatEvidenceParseError(code importing.IssueCode) error {
	return &importing.EvidenceParseError{Code: code}
}
