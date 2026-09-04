const { importError } = require('./errors')

function objectKeyFromFileId(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://') || fileID.includes('?')) return null
  const separator = fileID.indexOf('/', 'cloud://'.length)
  if (separator < 0) return null
  try {
    return decodeURIComponent(fileID.slice(separator + 1))
  } catch (error) {
    return null
  }
}

function createStorageGateway(cloud) {
  return {
    async downloadExact(fileID, expectedObjectKey) {
      if (objectKeyFromFileId(fileID) !== expectedObjectKey) throw importError('FILE_NOT_UPLOADED')
      try {
        const result = await cloud.downloadFile({ fileID })
        if (!result || !Buffer.isBuffer(result.fileContent)) throw importError('FILE_NOT_UPLOADED')
        return result.fileContent
      } catch (error) {
        if (error.publicCode) throw error
        throw importError('FILE_NOT_UPLOADED', error)
      }
    },

    async remove(fileID) {
      if (!fileID) return false
      try {
        const result = await cloud.deleteFile({ fileList: [fileID] })
        const item = result && result.fileList && result.fileList[0]
        return Boolean(item && (!item.status || item.status === 0 || item.status === 'success'))
      } catch (error) {
        return false
      }
    }
  }
}

module.exports = {
  createStorageGateway,
  objectKeyFromFileId
}
