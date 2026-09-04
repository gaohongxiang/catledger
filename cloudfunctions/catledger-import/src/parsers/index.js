const { importError } = require('../errors')
const { readCsvRecords } = require('./csv')
const { choosePlatform, parsePlatformRecords } = require('./platform')
const { decodeDelimitedText } = require('./text')
const { readXlsxSheets } = require('./xlsx')

const IDENTITY_VERSION = 'source-identity-v1'
const RAW_SNAPSHOT_VERSION = 'raw-snapshot-v1'

function finish(document) {
  if (!document || document.rows.length === 0) throw importError('FILE_FORMAT_UNSUPPORTED')
  return {
    ...document,
    identityVersion: IDENTITY_VERSION,
    rawSnapshotVersion: RAW_SNAPSHOT_VERSION
  }
}

async function parseEvidenceFile({ content, extension, timezoneOffsetMinutes }) {
  if (extension === 'csv') {
    const text = decodeDelimitedText(content, { allowGb18030: true })
    const records = readCsvRecords(text)
    const selected = choosePlatform(records)
    if (!selected) throw importError('FILE_FORMAT_UNSUPPORTED')
    return finish(parsePlatformRecords(records, selected, timezoneOffsetMinutes))
  }

  if (extension === 'xlsx') {
    const sheets = await readXlsxSheets(content)
    const candidates = sheets.map((sheet) => ({
      sheet,
      selected: choosePlatform(sheet.records, { xlsx: true })
    })).filter((candidate) => candidate.selected)
      .sort((left, right) => right.selected.confidence - left.selected.confidence)
    if (!candidates[0] || candidates[0].selected.descriptor.sourceType !== 'wechat') {
      throw importError('FILE_FORMAT_UNSUPPORTED')
    }
    return finish(parsePlatformRecords(
      candidates[0].sheet.records,
      candidates[0].selected,
      timezoneOffsetMinutes
    ))
  }

  throw importError('FILE_FORMAT_UNSUPPORTED')
}

module.exports = {
  parseEvidenceFile
}
