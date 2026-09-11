function needsEditingTransaction(mode) {
  return mode === 'edit' || mode === 'link-refund' || mode === 'import' || mode === 'view'
}

module.exports = { needsEditingTransaction }
