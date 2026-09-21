const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')

function normalizeNickname(value) {
  if (typeof value !== 'string') throw ledgerError('VALIDATION_ERROR')
  const nickname = value.trim()
  if (!nickname || Array.from(nickname).length > 6 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return nickname
}

function createProfileService({ getPool }) {
  return {
    async get({ provider, subjectHash, data = {}, read }) {
      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length) {
        throw ledgerError('VALIDATION_ERROR')
      }
      return executeLedgerRead({
        getPool, provider, subjectHash, read,
        operation: async (connection, uid) => {
          const [[user]] = await connection.execute(
            "SELECT nickname FROM catledger_users WHERE uid=? AND status='active'", [uid]
          )
          if (!user) throw ledgerError('INITIALIZATION_REQUIRED')
          return { nickname: user.nickname || '' }
        }
      })
    },

    async update({ provider, subjectHash, data }) {
      if (!data || Array.isArray(data) || typeof data !== 'object' ||
          Object.keys(data).some(key => !['requestId', 'nickname', 'previousNickname'].includes(key)) ||
          typeof data.previousNickname !== 'string') {
        throw ledgerError('VALIDATION_ERROR')
      }
      const nickname = normalizeNickname(data.nickname)
      return executeIdempotentMutation({
        getPool, provider, subjectHash, action: 'profile.update',
        data: { requestId: data.requestId, nickname, previousNickname: data.previousNickname },
        operation: async (connection, uid) => {
          const [[user]] = await connection.execute(
            "SELECT nickname FROM catledger_users WHERE uid=? AND status='active' FOR UPDATE", [uid]
          )
          if (!user) throw ledgerError('INITIALIZATION_REQUIRED')
          const current = user.nickname || ''
          if (current !== data.previousNickname && current !== nickname) throw ledgerError('CONFLICT')
          if (current !== nickname) {
            await connection.execute('UPDATE catledger_users SET nickname=? WHERE uid=?', [nickname, uid])
          }
          return { nickname }
        }
      })
    }
  }
}

module.exports = { createProfileService, normalizeNickname }
