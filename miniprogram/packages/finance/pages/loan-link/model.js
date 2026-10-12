// 转接层：原 pages/loan-link/model.js 的展示逻辑已提升至主包 services/loan-link-view.js。
// 保留本文件作为分包内 ./model 的兼容入口（分包→主包引用，合法）。
module.exports = require('../../../../services/loan-link-view')
