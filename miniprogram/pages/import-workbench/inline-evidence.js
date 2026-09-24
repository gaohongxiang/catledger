const { evidencePartFields } = require('./presentation')

// 只加载当前成员页：每笔一份来源、最多两个 2048 字符片段。
// 长原文只展示完整列，剩余内容仍可进入原文分页查看。
function previewFields(text, complete) {
  if (complete) return evidencePartFields(text, { index: 0, hasNext: false })
  for (let end = text.lastIndexOf('}'); end > 0; end = text.lastIndexOf('}', end - 1)) {
    const fields = evidencePartFields(text.slice(0, end + 1) + ']', { index: 0, hasNext: false })
    if (fields.length) return fields
  }
  return []
}

function create(session, records, isCurrent, publish) {
  const version = session.summary.viewVersion
  let closed = false
  const current = () => !closed && session.summary.viewVersion === version && isCurrent()
  const rows = records.map(record => ({ eventId: record.eventId,
    pager: session.pager('economicEvents.evidence', { eventId: record.eventId, pageSize: 1 }), ticket: 0 }))
  async function load(index, direction = 0) {
    const row = rows[index]
    if (!row || !current()) return
    const ticket = ++row.ticket
    const valid = () => current() && row.ticket === ticket
    publish(index, { evidence: [], evidenceLoading: true, evidenceError: '', evidencePage: null })
    try {
      const response = await row.pager.load(direction)
      if (!valid()) return
      const source = response.items[0]
      if (!source) {
        publish(index, { evidence: [], evidenceLoading: false, evidenceError: '未找到原始记录，请刷新本页后重试' })
        return
      }
      let text = '', cursor = null
      for (let part = 0; part < 2; part++) {
        const detail = await session.read('economicEvents.detail', { eventId: row.eventId, evidenceId: source.evidenceId, cursor }, valid)
        if (!valid()) return
        text += detail.part
        cursor = detail.nextCursor
        if (!cursor) break
      }
      const fields = previewFields(text, !cursor)
      publish(index, { evidence: [{ evidenceId: source.evidenceId, fileName: source.fileName,
        rowNumber: source.rowNumber, fields, incomplete: Boolean(cursor) || !fields.length }],
      evidenceLoading: false, evidencePage: response.page })
    } catch (error) {
      if (valid()) publish(index, { evidenceLoading: false,
        evidenceError: error.code === 'STALE_VIEW' ? '整理结果已变化，请刷新本页' : '原始记录读取失败，请重试' })
    }
  }
  return {
    async loadAll() {
      let next = 0
      await Promise.all([0, 1].map(async () => {
        while (current() && next < rows.length) await load(next++)
      }))
    },
    change(eventId, direction) { return load(rows.findIndex(row => row.eventId === eventId), direction) },
    close() { closed = true; rows.forEach(row => row.pager.cancel()) }
  }
}

module.exports = { create }
