// 紧急止损只关闭持久化，读取与写入仍使用同一版本契约；不恢复旧协议。
module.exports = Object.freeze({ persistentSnapshots: true })
