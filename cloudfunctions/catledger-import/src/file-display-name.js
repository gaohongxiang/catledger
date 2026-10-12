const { importError } = require('./errors')

function normalizeDisplayName(value, originalFileName) {
  if (typeof value !== 'string') throw importError('VALIDATION_ERROR')
  const normalized = value.normalize('NFKC')
  const name = normalized.trim()
  const extension = originalFileName.slice(originalFileName.lastIndexOf('.')).toLowerCase()
  if (!name || [...name].length > 255 || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(normalized) ||
      !name.toLowerCase().endsWith(extension) || !name.slice(0, -extension.length).trim() ||
      /^[. ]+$/.test(name.slice(0, -extension.length))) throw importError('VALIDATION_ERROR')
  return name === originalFileName ? null : name
}

module.exports = { normalizeDisplayName }
