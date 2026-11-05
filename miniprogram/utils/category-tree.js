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
// 选择目录先按一级的顺序排，再把二级跟在自己的一级后面。不按编号穿插。
function orderedSelectionGroups(rows, query, expanded) {
  const list = rows || []
  const byId = new Map(list.map(row => [key(row), row]))
  const order = row => Number(row && row.sortOrder) || 0
  const name = row => String(row && row.name || '')
  const sorted = list.slice().sort((a, b) => {
    const ap = a.parentId && byId.get(a.parentId)
    const bp = b.parentId && byId.get(b.parentId)
    const aHead = ap || a
    const bHead = bp || b
    return order(aHead) - order(bHead)
      || name(aHead).localeCompare(name(bHead), 'zh')
      || String(key(aHead)).localeCompare(String(key(bHead)))
      || Number(Boolean(ap)) - Number(Boolean(bp))
      || order(a) - order(b)
      || name(a).localeCompare(name(b), 'zh')
  })
  return { items: sorted, groups: selectionGroups(sorted, query, expanded || {}, -1) }
}
module.exports = { key, labelRows, selectionGroups, orderedSelectionGroups }
