const { parse } = require('csv-parse/sync')

const { importError } = require('../errors')

const MAX_COLUMNS = 64
const MAX_RECORDS = 5000

function readCsvRecords(text) {
  let parsed
  try {
    parsed = parse(text, {
      bom: false,
      columns: false,
      info: true,
      raw: true,
      relax_column_count: true,
      relax_quotes: false,
      record_delimiter: ['\r\n', '\n', '\r'],
      skip_empty_lines: false,
      max_record_size: 128 * 1024
    })
  } catch (error) {
    throw importError('FILE_FORMAT_UNSUPPORTED', error)
  }

  if (parsed.length > MAX_RECORDS) throw importError('CSV_RECORD_LIMIT_EXCEEDED')
  let previousEndLine = 0
  return parsed.map((entry, index) => {
    const values = entry.record.map((value) => String(value))
    if (values.length > MAX_COLUMNS) throw importError('CSV_COLUMN_LIMIT_EXCEEDED')
    const endLine = Number(entry.info.lines) || previousEndLine + 1
    const startLine = previousEndLine + 1
    previousEndLine = endLine
    return {
      values,
      logicalNumber: index + 1,
      startLine,
      endLine
    }
  })
}

module.exports = {
  readCsvRecords
}
