const STORAGE_KEY = 'catledger_pending_import_parse_v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function normalizePendingParse(value, now) {
  if (!value || typeof value !== 'object') return null
  const createdAt = Number(value.createdAt)
  const current = Number(now)
  if (!Number.isFinite(createdAt) || !Number.isFinite(current) || current - createdAt > MAX_AGE_MS || createdAt > current + 60000) {
    return null
  }
  const required = ['importId', 'fileID', 'requestId', 'fileName']
  if (required.some(function (key) { return typeof value[key] !== 'string' || !value[key] })) return null
  const fileSize = Number(value.fileSize)
  const version = Number(value.version)
  if (!Number.isSafeInteger(fileSize) || fileSize < 1 || !Number.isSafeInteger(version) || version < 1) return null
  return {
    importId: value.importId,
    fileID: value.fileID,
    requestId: value.requestId,
    fileName: value.fileName,
    fileSize: fileSize,
    version: version,
    createdAt: createdAt
  }
}

function readPendingParse() {
  try {
    const value = normalizePendingParse(wx.getStorageSync(STORAGE_KEY), Date.now())
    if (!value) wx.removeStorageSync(STORAGE_KEY)
    return value
  } catch (error) {
    return null
  }
}

function savePendingParse(value) {
  const normalized = normalizePendingParse(value, Date.now())
  if (!normalized) return false
  try {
    wx.setStorageSync(STORAGE_KEY, normalized)
    return true
  } catch (error) {
    return false
  }
}

function clearPendingParse(importId) {
  try {
    if (!importId) {
      wx.removeStorageSync(STORAGE_KEY)
      return
    }
    const current = normalizePendingParse(wx.getStorageSync(STORAGE_KEY), Date.now())
    if (!current || current.importId === importId) wx.removeStorageSync(STORAGE_KEY)
  } catch (error) {}
}

module.exports = {
  clearPendingParse: clearPendingParse,
  normalizePendingParse: normalizePendingParse,
  readPendingParse: readPendingParse,
  savePendingParse: savePendingParse
}
