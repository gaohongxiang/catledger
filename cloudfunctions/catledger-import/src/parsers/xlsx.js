const path = require('node:path').posix

const { SaxesParser } = require('saxes')
const yauzl = require('yauzl')

const { importError } = require('../errors')

const MAX_ENTRY_COUNT = 128
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
const MAX_SHEETS = 8
const MAX_ROWS_PER_SHEET = 5000
const MAX_COLUMNS = 64
const MAX_CELL_CHARS = 4096

function isSafeEntryName(name) {
  return !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..')
}

function wantedEntry(name) {
  return name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name)
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error)
      const chunks = []
      let length = 0
      stream.on('data', (chunk) => {
        length += chunk.length
        if (length > MAX_ENTRY_BYTES) stream.destroy(importError('FILE_SIZE_INVALID'))
        else chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks, length).toString('utf8')))
    })
  })
}

function readZipEntries(content) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(content, {
      autoClose: true,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (openError, zip) => {
      if (openError) return reject(importError('FILE_FORMAT_UNSUPPORTED', openError))
      const entries = new Map()
      let count = 0
      let total = 0
      let settled = false

      function fail(error) {
        if (settled) return
        settled = true
        zip.close()
        reject(error.publicCode ? error : importError('FILE_FORMAT_UNSUPPORTED', error))
      }

      zip.on('error', fail)
      zip.on('entry', async (entry) => {
        try {
          count += 1
          total += Number(entry.uncompressedSize)
          if (count > MAX_ENTRY_COUNT || total > MAX_TOTAL_UNCOMPRESSED_BYTES ||
              Number(entry.uncompressedSize) > MAX_ENTRY_BYTES || !isSafeEntryName(entry.fileName)) {
            throw importError('FILE_SIZE_INVALID')
          }
          if (!/\/$/.test(entry.fileName) && wantedEntry(entry.fileName)) {
            entries.set(entry.fileName, await readEntry(zip, entry))
          }
          zip.readEntry()
        } catch (error) {
          fail(error)
        }
      })
      zip.on('end', () => {
        if (settled) return
        settled = true
        resolve(entries)
      })
      zip.readEntry()
    })
  })
}

function parseXml(xml, handlers) {
  const parser = new SaxesParser({ xmlns: false })
  parser.on('opentag', handlers.open || (() => {}))
  parser.on('text', handlers.text || (() => {}))
  parser.on('closetag', handlers.close || (() => {}))
  parser.on('error', (error) => { throw error })
  try {
    parser.write(xml).close()
  } catch (error) {
    throw importError('FILE_FORMAT_UNSUPPORTED', error)
  }
}

function parseWorkbook(xml) {
  const sheets = []
  parseXml(xml, {
    open(tag) {
      if (tag.name === 'sheet') {
        sheets.push({
          name: String(tag.attributes.name || '').slice(0, 128),
          relationId: String(tag.attributes['r:id'] || '')
        })
      }
    }
  })
  if (sheets.length < 1 || sheets.length > MAX_SHEETS) throw importError('FILE_SIZE_INVALID')
  return sheets
}

function parseRelationships(xml) {
  const relationships = new Map()
  parseXml(xml, {
    open(tag) {
      if (tag.name === 'Relationship') {
        const id = String(tag.attributes.Id || '')
        const target = String(tag.attributes.Target || '')
        if (id && target && !target.includes('..') && !target.startsWith('/')) {
          relationships.set(id, path.normalize(path.join('xl', target)))
        }
      }
    }
  })
  return relationships
}

function parseSharedStrings(xml) {
  if (!xml) return []
  const values = []
  let inItem = false
  let inText = false
  let current = ''
  parseXml(xml, {
    open(tag) {
      if (tag.name === 'si') {
        inItem = true
        current = ''
      } else if (inItem && tag.name === 't') {
        inText = true
      }
    },
    text(value) {
      if (inItem && inText) current += value
    },
    close(tag) {
      if (tag.name === 't') inText = false
      if (tag.name === 'si') {
        if ([...current].length > MAX_CELL_CHARS) throw importError('FILE_SIZE_INVALID')
        values.push(current)
        inItem = false
      }
    }
  })
  return values
}

function columnIndex(cellReference) {
  const match = /^([A-Z]+)\d+$/i.exec(cellReference)
  if (!match) return null
  let value = 0
  for (const char of match[1].toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64
  return value - 1
}

function parseWorksheet(xml, sharedStrings, sheetIndex, sheetName) {
  const records = []
  let currentRow = null
  let currentCell = null
  let capture = null
  let text = ''

  parseXml(xml, {
    open(tag) {
      if (tag.name === 'row') {
        if (records.length >= MAX_ROWS_PER_SHEET) throw importError('FILE_SIZE_INVALID')
        currentRow = {
          values: [],
          formulaColumns: [],
          rowNumber: Number(tag.attributes.r) || records.length + 1
        }
      } else if (tag.name === 'c' && currentRow) {
        const index = columnIndex(String(tag.attributes.r || ''))
        if (index == null || index >= MAX_COLUMNS) throw importError('FILE_SIZE_INVALID')
        currentCell = { index, type: String(tag.attributes.t || ''), formula: false, value: '' }
      } else if (currentCell && tag.name === 'f') {
        currentCell.formula = true
      } else if (currentCell && (tag.name === 'v' || tag.name === 't')) {
        capture = tag.name
        text = ''
      }
    },
    text(value) {
      if (capture) text += value
    },
    close(tag) {
      if (currentCell && capture && tag.name === capture) {
        currentCell.value += text
        capture = null
        text = ''
      } else if (tag.name === 'c' && currentCell && currentRow) {
        let value = currentCell.value
        if (currentCell.type === 's') {
          const sharedIndex = Number(value)
          value = Number.isSafeInteger(sharedIndex) ? sharedStrings[sharedIndex] || '' : ''
        }
        if ([...String(value)].length > MAX_CELL_CHARS) throw importError('FILE_SIZE_INVALID')
        currentRow.values[currentCell.index] = String(value)
        if (currentCell.formula) currentRow.formulaColumns.push(currentCell.index)
        currentCell = null
      } else if (tag.name === 'row' && currentRow) {
        for (let index = 0; index < currentRow.values.length; index += 1) {
          if (currentRow.values[index] == null) currentRow.values[index] = ''
        }
        currentRow.sourceLocator = `XLSX:${sheetIndex + 1}:${sheetName}:${currentRow.rowNumber}`
        records.push(currentRow)
        currentRow = null
      }
    }
  })
  return records
}

async function readXlsxSheets(content) {
  if (content.length < 4 || !content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw importError('FILE_FORMAT_UNSUPPORTED')
  }
  const entries = await readZipEntries(content)
  const workbook = entries.get('xl/workbook.xml')
  const relationships = entries.get('xl/_rels/workbook.xml.rels')
  if (!workbook || !relationships) throw importError('FILE_FORMAT_UNSUPPORTED')

  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml'))
  const sheetDefinitions = parseWorkbook(workbook)
  const relationMap = parseRelationships(relationships)
  return sheetDefinitions.map((sheet, index) => {
    const entryName = relationMap.get(sheet.relationId)
    const xml = entryName && entries.get(entryName)
    if (!xml) throw importError('FILE_FORMAT_UNSUPPORTED')
    return {
      name: sheet.name || `Sheet${index + 1}`,
      records: parseWorksheet(xml, sharedStrings, index, sheet.name || `Sheet${index + 1}`)
    }
  })
}

module.exports = {
  readXlsxSheets
}
