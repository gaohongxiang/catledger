package wechat

import (
	"context"
	"encoding/binary"
	"encoding/csv"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func readWechatEvidenceCsv(ctx context.Context, content []byte) ([]wechatEvidenceSheet, error) {
	decoded, err := decodeWechatEvidenceCsv(content)

	if err != nil {
		return nil, err
	}

	rows, err := splitWechatEvidenceCsvRecords(ctx, decoded)

	if err != nil {
		return nil, err
	}

	return []wechatEvidenceSheet{{
		format: importing.EVIDENCE_FORMAT_WECHAT_CSV,
		rows:   rows,
	}}, nil
}

func decodeWechatEvidenceCsv(content []byte) (string, error) {
	switch {
	case len(content) >= 3 && content[0] == 0xef && content[1] == 0xbb && content[2] == 0xbf:
		return decodeStrictWechatEvidenceUTF8(content[3:])
	case len(content) >= 2 && content[0] == 0xff && content[1] == 0xfe:
		return decodeStrictWechatEvidenceUTF16(content[2:], binary.LittleEndian)
	case len(content) >= 2 && content[0] == 0xfe && content[1] == 0xff:
		return decodeStrictWechatEvidenceUTF16(content[2:], binary.BigEndian)
	default:
		return decodeStrictWechatEvidenceUTF8(content)
	}
}

func decodeStrictWechatEvidenceUTF8(content []byte) (string, error) {
	if !utf8.Valid(content) {
		return "", newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
	}

	return string(content), nil
}

func decodeStrictWechatEvidenceUTF16(content []byte, byteOrder binary.ByteOrder) (string, error) {
	if len(content)%2 != 0 {
		return "", newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
	}

	decoded := make([]byte, 0, len(content))

	for offset := 0; offset < len(content); {
		first := byteOrder.Uint16(content[offset : offset+2])

		switch {
		case first >= 0xd800 && first <= 0xdbff:
			if offset+4 > len(content) {
				return "", newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
			}

			second := byteOrder.Uint16(content[offset+2 : offset+4])

			if second < 0xdc00 || second > 0xdfff {
				return "", newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
			}

			codePoint := rune(0x10000 + (uint32(first-0xd800) << 10) + uint32(second-0xdc00))
			decoded = utf8.AppendRune(decoded, codePoint)
			offset += 4
		case first >= 0xdc00 && first <= 0xdfff:
			return "", newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_ENCODING_INVALID)
		default:
			decoded = utf8.AppendRune(decoded, rune(first))
			offset += 2
		}
	}

	return string(decoded), nil
}

func splitWechatEvidenceCsvRecords(ctx context.Context, content string) ([]wechatEvidencePhysicalRow, error) {
	data := []byte(content)
	rows := make([]wechatEvidencePhysicalRow, 0)
	recordStart := 0
	recordStartLine := int64(1)
	currentLine := int64(1)
	inQuotes := false
	atFieldStart := true

	for index := 0; index < len(data); index++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		char := data[index]

		if inQuotes {
			if char == '"' {
				if index+1 < len(data) && data[index+1] == '"' {
					index++
					continue
				}

				inQuotes = false
				atFieldStart = false
				continue
			}

			if char == '\r' {
				if index+1 < len(data) && data[index+1] == '\n' {
					index++
				}

				currentLine++
			} else if char == '\n' {
				currentLine++
			}

			continue
		}

		switch char {
		case '"':
			if atFieldStart {
				inQuotes = true
			}
		case ',':
			atFieldStart = true
		case '\r', '\n':
			row, err := parseWechatEvidenceCsvRecord(data[recordStart:index], recordStartLine, currentLine)

			if err != nil {
				return nil, err
			}

			rows = append(rows, row)

			if char == '\r' && index+1 < len(data) && data[index+1] == '\n' {
				index++
			}

			currentLine++
			recordStart = index + 1
			recordStartLine = currentLine
			atFieldStart = true
		default:
			atFieldStart = false
		}
	}

	if inQuotes {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
	}

	if recordStart < len(data) {
		row, err := parseWechatEvidenceCsvRecord(data[recordStart:], recordStartLine, currentLine)

		if err != nil {
			return nil, err
		}

		rows = append(rows, row)
	}

	return rows, nil
}

func parseWechatEvidenceCsvRecord(record []byte, startLine int64, endLine int64) (wechatEvidencePhysicalRow, error) {
	values := make([]string, 0)

	if len(record) > 0 {
		reader := csv.NewReader(strings.NewReader(string(record)))
		reader.FieldsPerRecord = -1
		parsed, err := reader.Read()

		if err != nil {
			return wechatEvidencePhysicalRow{}, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
		}

		if _, err := reader.Read(); err != io.EOF {
			return wechatEvidencePhysicalRow{}, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
		}

		values = parsed
	}

	return wechatEvidencePhysicalRow{
		values:      values,
		csvStartRow: startLine,
		csvEndRow:   endLine,
	}, nil
}
