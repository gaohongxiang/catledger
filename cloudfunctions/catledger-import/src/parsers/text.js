const { TextDecoder } = require('node:util')

const iconv = require('iconv-lite')

const { importError } = require('../errors')

function decodeUtf16(content, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content)
  } catch (error) {
    throw importError('FILE_ENCODING_INVALID', error)
  }
}

function decodeDelimitedText(content, { allowGb18030 = false } = {}) {
  if (content.length >= 3 && content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    content = content.subarray(3)
  } else if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return decodeUtf16(content.subarray(2), 'utf-16le')
  } else if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return decodeUtf16(content.subarray(2), 'utf-16be')
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch (utf8Error) {
    if (!allowGb18030) throw importError('FILE_ENCODING_INVALID', utf8Error)
    try {
      const decoded = iconv.decode(content, 'gb18030')
      if (decoded.includes('\ufffd')) throw new Error('replacement character')
      return decoded
    } catch (error) {
      throw importError('FILE_ENCODING_INVALID', error)
    }
  }
}

function normalizeText(value, maximum = 1024) {
  const normalized = String(value == null ? '' : value).normalize('NFKC').trim()
  if ([...normalized].length > maximum) throw importError('VALIDATION_ERROR')
  return normalized
}

module.exports = {
  decodeDelimitedText,
  normalizeText
}
