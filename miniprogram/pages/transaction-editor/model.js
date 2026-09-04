function needsEditingTransaction(mode) {
  return mode === 'edit' || mode === 'link-refund'
}

module.exports = { needsEditingTransaction }
