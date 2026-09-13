const { BUDGET } = require('./performance-contract')
const { importError } = require('./errors')

function* chunks(rows, { parametersPerRow, bytesPerRow, fixedParameters = 0 } = {}) {
  let part = [], bytes = 4096, parameters = fixedParameters
  for (const row of rows) {
    const size = bytesPerRow ? bytesPerRow(row) : Buffer.byteLength(JSON.stringify(row)) + 64
    const count = parametersPerRow || row.length
    if (size + 4096 > BUDGET.sqlBytes || count + fixedParameters > BUDGET.sqlParameters) throw importError('REQUEST_TOO_LARGE')
    if (part.length && (part.length >= BUDGET.sqlRows || bytes + size > BUDGET.sqlBytes || parameters + count > BUDGET.sqlParameters)) {
      yield part; part = []; bytes = 4096; parameters = fixedParameters
    }
    part.push(row); bytes += size; parameters += count
  }
  if (part.length) yield part
}
async function insertMany(connection, prefix, rows, suffix = '') {
  for (const part of chunks(rows)) {
    const placeholders = part.map(row => '(' + row.map(() => '?').join(',') + ')').join(',')
    await connection.execute(prefix + ' ' + placeholders + suffix, part.flat())
  }
}
async function updateEvents(connection, uid, updateId, columns, rows) {
  if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('invalid static column')
  for (const part of chunks(rows, { parametersPerRow: columns.length * 2 + 2, fixedParameters: 2,
    bytesPerRow: row => Buffer.byteLength(JSON.stringify(row)) + columns.length * 100 })) {
    const values = []
    const set = columns.map((column, index) => {
      for (const row of part) values.push(row[0], row[index + 2])
      return column + ' = CASE event_id ' + part.map(() => 'WHEN ? THEN ?').join(' ') + ' END'
    }).join(', ')
    values.push(uid, updateId, ...part.flatMap(row => [row[0], row[1]]))
    const [result] = await connection.execute(`UPDATE catledger_economic_events SET ${set}
      WHERE uid = ? AND update_id = ? AND (event_id, version) IN (${part.map(() => '(?,?)').join(',')})`, values)
    if (result.affectedRows !== part.length) throw importError('CONFLICT')
  }
}
async function loadEventContexts(connection, uid, updateId) {
  const [relations] = await connection.execute(`SELECT relation_id AS relationId, relation_type AS relationType, status, version,
    source_event_id AS sourceEventId, target_event_id AS targetEventId, amount_minor AS amountMinor, currency
    FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ?`, [uid, updateId])
  const [links] = await connection.execute(`SELECT event_id AS eventId, transaction_id AS transactionId, role
    FROM catledger_economic_event_transactions WHERE uid = ? AND update_id = ?`, [uid, updateId])
  const contexts = new Map()
  function get(id) { if (!contexts.has(id)) contexts.set(id, { relations: [], transactionLinks: [] }); return contexts.get(id) }
  for (const relation of relations) {
    get(relation.sourceEventId).relations.push(relation)
    if (relation.targetEventId !== relation.sourceEventId) get(relation.targetEventId).relations.push(relation)
  }
  for (const link of links) get(link.eventId).transactionLinks.push(link)
  return { get }
}
module.exports = { chunks, insertMany, updateEvents, loadEventContexts }
