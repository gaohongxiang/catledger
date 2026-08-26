package excel

import "github.com/mayswind/ezbookkeeping/pkg/converters/datatable"

// WorksheetDataTable 是原项目 Excel 读取器暴露给通用账单适配层的最小工作表契约。
// 它保留原工作簿索引和名称，同时继续复用 BasicDataTable 的逐行读取能力。
type WorksheetDataTable interface {
	datatable.BasicDataTable
	WorksheetIndex() int
	WorksheetName() string
	PhysicalRows() [][]string
}
