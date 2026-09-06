const OBSERVATION_STATE = Object.freeze({
  VALUE: 'value',
  COLUMN_MISSING: 'column_missing',
  EXPLICIT_SLASH: 'explicit_slash',
  EXPLICIT_BLANK: 'explicit_blank',
  PARSE_FAILURE: 'parse_failure',
  UNKNOWN_TOKEN: 'unknown_token'
})

function observeField(rawValue, { parsed = true, known = true, present = true } = {}) {
  if (!present) return { state: OBSERVATION_STATE.COLUMN_MISSING }
  const value = String(rawValue == null ? '' : rawValue).normalize('NFKC').trim()
  if (!value) return { state: OBSERVATION_STATE.EXPLICIT_BLANK }
  if (value === '/') return { state: OBSERVATION_STATE.EXPLICIT_SLASH }
  if (!parsed) return { state: OBSERVATION_STATE.PARSE_FAILURE }
  if (!known) return { state: OBSERVATION_STATE.UNKNOWN_TOKEN }
  return { state: OBSERVATION_STATE.VALUE }
}

module.exports = {
  OBSERVATION_STATE,
  observeField
}
