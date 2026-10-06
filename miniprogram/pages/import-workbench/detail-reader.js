// 复用原详情分段协议，只读取当前笔；旧服务端没有补充信息时保持明确的未读取状态。
async function readDetail(session, eventId, active) {
  let cursor = null, text = ''
  for (let index = 0; index < 32; index++) {
    if (!active()) return null
    const result = await session.read('economicEvents.detail', { eventId, cursor }, active)
    if (!active()) return null
    if (typeof result.part !== 'string') throw Error('交易详情未能完整读取，请重试')
    text += result.part
    cursor = result.nextCursor
    if (!cursor) {
      let row
      try { row = JSON.parse(text) } catch (_) { throw Error('交易详情未能完整读取，请重试') }
      if (!row || Array.isArray(row) || row.eventId !== eventId || !Number.isInteger(row.version)) throw Error('交易详情不匹配，请重新读取')
      return row
    }
  }
  throw Error('交易详情较长，尚未完整读取，请重试')
}
module.exports = { readDetail }
