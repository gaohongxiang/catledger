// Pure view model. Preserve the caller's index so selections do not drift after sorting/search.
function key(row) { return row.id !== undefined ? row.id : row.categoryId }
function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase().trim() }
function labelRows(rows) {
  const byId = new Map((rows || []).map(row => [key(row), row]))
  return (rows || []).map(row => {
    const parent = row.parentId && byId.get(row.parentId)
    const parentName = parent ? parent.name : row.parentName || ''
    return Object.assign({}, row, { parentName, displayName: parentName ? parentName + ' / ' + row.name : row.name })
  })
}
function selectionGroups(rows, query, expanded, selectedIndex) {
  const options = labelRows(rows).map((row, index) => Object.assign({}, row, { optionIndex: index, key: String(key(row) == null ? 'none-' + index : key(row)) }))
  const byId = new Map(options.map(row => [key(row), row]))
  const groups = [], q = normalize(query)
  options.filter(row => !row.archived && !row.archivedAt && (!row.parentId || !byId.has(row.parentId))).forEach(row => {
    const children = options.filter(child => child.parentId && child.parentId === key(row) && !child.archived && !child.archivedAt)
    const parentMatches = normalize(row.displayName).includes(q)
    const matches = children.filter(child => parentMatches || normalize(child.displayName).includes(q))
    if (q && !parentMatches && !matches.length) return
    groups.push(Object.assign({}, row, { children: matches, hasChildren: children.length > 0,
      expanded: Boolean(Object.prototype.hasOwnProperty.call(expanded, row.key) ? expanded[row.key] : q || children.some(child => child.optionIndex === selectedIndex)) }))
  })
  return groups
}
module.exports = { key, labelRows, selectionGroups }
