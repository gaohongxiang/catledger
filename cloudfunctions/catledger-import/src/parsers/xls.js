const XLSX = require('xlsx')
const { importError } = require('../errors')
const { decodeDelimitedText } = require('./text')

// XLS is not a ZIP container. Keep the bounded OOXML reader for XLSX files.
function readXlsSheets(content) {
  const compound = content.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  const biff = content[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(content[1])
  let input = content
  if (!compound && !biff) {
    input = decodeDelimitedText(content, { allowGb18030: true })
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<(?:html|table|Workbook)\b/i.test(input) || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input)) {
      throw importError('FILE_FORMAT_UNSUPPORTED')
    }
  }
  let book
  try {
    book = XLSX.read(input, { type: typeof input === 'string' ? 'string' : 'buffer',
      raw: true, cellFormula: true, cellDates: false, cellNF: false, bookVBA: false, sheetRows: 5001 })
  } catch (error) { throw importError('FILE_FORMAT_UNSUPPORTED', error) }
  if (!book.SheetNames.length || book.SheetNames.length > 8) throw importError('FILE_SIZE_INVALID')
  return book.SheetNames.map((name, index) => {
    const sheet = book.Sheets[name]
    if (!sheet || !sheet['!ref']) return { name, records: [] }
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'])
    if (range.e.r >= 5000) throw importError('CSV_RECORD_LIMIT_EXCEEDED')
    if (range.e.c >= 64) throw importError('CSV_COLUMN_LIMIT_EXCEEDED')
    const records = []
    for (let r = 0; r <= range.e.r; r += 1) {
      const values = [], formulaColumns = [], numericColumns = []
      for (let c = 0; c <= range.e.c; c += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })]
        const value = cell && cell.v != null ? String(cell.v) : ''
        if (value.length > 4096) throw importError('FILE_SIZE_INVALID')
        values.push(value)
        if (cell && cell.t === 'n') numericColumns.push(c)
        if (cell && (cell.f || cell.F || cell.t === 'e')) formulaColumns.push(c + 1)
      }
      records.push({ values, formulaColumns, numericColumns, rowNumber: r + 1, logicalNumber: r + 1,
        sourceLocator: `XLS:${index + 1}:${name}:${r + 1}` })
    }
    return { name, records, date1904: Boolean(book.Workbook && book.Workbook.WBProps && book.Workbook.WBProps.date1904) }
  })
}

module.exports = { readXlsSheets }
