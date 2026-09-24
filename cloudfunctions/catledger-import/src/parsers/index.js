const { importError } = require('../errors')
const { readCsvRecords } = require('./csv')
const { choosePlatform, parsePlatformRecords } = require('./platform')
const { decodeDelimitedText } = require('./text')
const { readXlsxSheets } = require('./xlsx')
const { readXlsSheets } = require('./xls')
const { parseBank } = require('./bank')

const IDENTITY_VERSION = 'source-identity-v1'
const RAW_SNAPSHOT_VERSION = 'raw-snapshot-v1'

function finish(document) {
  if (document && document.mappingRequired) return document
  if (!document || document.rows.length === 0) throw importError('FILE_FORMAT_UNSUPPORTED')
  return {
    ...document,
    identityVersion: IDENTITY_VERSION,
    rawSnapshotVersion: RAW_SNAPSHOT_VERSION
  }
}

async function parseEvidenceFile({ content, extension, timezoneOffsetMinutes, bankMapping, bankPreview }) {
  const bankOptions = { content, extension, timezoneOffsetMinutes, bankMapping, bankPreview }
  if (extension === 'csv') {
    const text = decodeDelimitedText(content, { allowGb18030: true })
    const records = readCsvRecords(text, { delimiter: text.slice(0, 8192).includes('\t') && !text.slice(0, 8192).includes(',') ? '\t' : ',' })
    const selected = choosePlatform(records)
    if (!selected) return finish(parseBank([{ name: 'CSV', records }], bankOptions))
    if (bankMapping || bankPreview) throw importError('VALIDATION_ERROR')
    return finish(parsePlatformRecords(records, selected, timezoneOffsetMinutes))
  }

  if (extension === 'xlsx') {
    const sheets = await readXlsxSheets(content)
    const candidates = sheets.map((sheet) => ({
      sheet,
      selected: choosePlatform(sheet.records, { xlsx: true })
    })).filter((candidate) => candidate.selected)
      .sort((left, right) => right.selected.confidence - left.selected.confidence)
    if (candidates.length === 0) return finish(parseBank(sheets, bankOptions))
    if (candidates.length !== 1 || candidates[0].selected.descriptor.sourceType !== 'wechat' || candidates[0].sheet.date1904 || bankMapping || bankPreview) {
      throw importError('FILE_FORMAT_UNSUPPORTED')
    }
    return finish(parsePlatformRecords(
      candidates[0].sheet.records,
      candidates[0].selected,
      timezoneOffsetMinutes
    ))
  }

  if (extension === 'xls') return finish(parseBank(readXlsSheets(content), bankOptions))

  throw importError('FILE_FORMAT_UNSUPPORTED')
}

module.exports = {
  parseEvidenceFile
}
