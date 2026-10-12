// 转接层：原 pages/loans/model.js 的展示逻辑已提升至主包 services/loan-present.js。
// 保留本文件作为分包内 ./model 与 ../loans/model 的兼容入口（分包→主包引用，合法）。
module.exports = require('../../../../services/loan-present')
