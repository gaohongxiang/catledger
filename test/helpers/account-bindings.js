const { accountReferences, inferExactAccountMappings } = require('../../cloudfunctions/catledger-import/src/organizer-plan-policy')
const { confirmedBinding } = require('../../cloudfunctions/catledger-import/src/account-binding')

// 测试需要「已确认账户」时显式建立本批绑定；名称命中本身不再使事件可入账。
function confirmedBatchMappings(rows, mappings) {
  return accountReferences(rows).flatMap(reference => mappings.filter(mapping =>
    mapping.sourceType === reference.sourceType && mapping.paymentMethodKey === reference.paymentMethodKey)
    .map(mapping => ({ ...mapping, mappingScope: 'batch', paymentMethodKey: reference.bindingKey || reference.paymentMethodKey,
      paymentMethodHint: reference.label, binding: confirmedBinding(reference) })))
}

function confirmedNamedAccounts(rows, accounts) {
  return confirmedBatchMappings(rows, inferExactAccountMappings(rows, accounts))
}

module.exports = { confirmedBatchMappings, confirmedNamedAccounts }
