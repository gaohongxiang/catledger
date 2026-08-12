package wechat

import (
	"bytes"
	"context"

	"github.com/xuri/excelize/v2"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func readWechatEvidenceXlsx(ctx context.Context, content []byte) ([]wechatEvidenceSheet, error) {
	if !hasOOXMLZipHeader(content) {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_FORMAT_INVALID)
	}

	workbook, err := excelize.OpenReader(bytes.NewReader(content))

	if err != nil {
		return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_FORMAT_INVALID)
	}

	defer workbook.Close()

	sheetNames := workbook.GetSheetList()
	sheets := make([]wechatEvidenceSheet, 0, len(sheetNames))

	for sheetIndex, sheetName := range sheetNames {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		allRows, err := workbook.GetRows(sheetName)

		if err != nil {
			return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
		}

		rows := make([]wechatEvidencePhysicalRow, 0, len(allRows))

		for rowIndex, values := range allRows {
			if err := ctx.Err(); err != nil {
				return nil, err
			}

			values = append([]string(nil), values...)
			formulaColumns := make(map[int]bool)

			for columnIndex := range values {
				cellName, err := excelize.CoordinatesToCellName(columnIndex+1, rowIndex+1)

				if err != nil {
					return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
				}

				formula, err := workbook.GetCellFormula(sheetName, cellName)

				if err != nil {
					return nil, newWechatEvidenceParseError(importing.ISSUE_CODE_FILE_STRUCTURE_INVALID)
				}

				if formula != "" {
					formulaColumns[columnIndex] = true

					if formula[0] == '=' {
						values[columnIndex] = formula
					} else {
						values[columnIndex] = "=" + formula
					}
				}
			}

			rows = append(rows, wechatEvidencePhysicalRow{
				values:         values,
				xlsxRow:        int64(rowIndex + 1),
				formulaColumns: formulaColumns,
			})
		}

		sheets = append(sheets, wechatEvidenceSheet{
			format:     importing.EVIDENCE_FORMAT_WECHAT_XLSX,
			sheetIndex: sheetIndex,
			sheetName:  sheetName,
			rows:       rows,
		})
	}

	return sheets, nil
}
