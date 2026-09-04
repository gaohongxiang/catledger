const path = require('node:path')

const { importError } = require('./errors')

const ACCEPTED_EXTENSIONS = Object.freeze(['csv', 'xlsx'])
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILE_NAME_CHARS = 255
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw importError('VALIDATION_ERROR')
  }
  return value.toLowerCase()
}

function validateTimezoneOffset(value) {
  if (!Number.isInteger(value) || value < -840 || value > 840) {
    throw importError('VALIDATION_ERROR')
  }
  return value
}

function normalizeFileName(value) {
  if (typeof value !== 'string') throw importError('VALIDATION_ERROR')
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!normalized || [...normalized].length > MAX_FILE_NAME_CHARS) {
    throw importError('VALIDATION_ERROR')
  }
  const extension = path.extname(normalized).slice(1).toLowerCase()
  if (!ACCEPTED_EXTENSIONS.includes(extension)) throw importError('FILE_FORMAT_UNSUPPORTED')
  return { fileName: normalized, extension }
}

function validateDeclaredSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILE_BYTES) {
    throw importError('FILE_SIZE_INVALID')
  }
  return value
}

function validateActualContent(content) {
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > MAX_FILE_BYTES) {
    throw importError('FILE_SIZE_INVALID')
  }
  return content
}

function validateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw importError('VALIDATION_ERROR')
  return value
}

module.exports = {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  normalizeFileName,
  validateActualContent,
  validateDeclaredSize,
  validateTimezoneOffset,
  validateUuid,
  validateVersion
}
