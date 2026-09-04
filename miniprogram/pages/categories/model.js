function prepare(rows, kind, archived) {
  const filtered = rows.filter(function (item) { return item.kind === kind && item.archived === archived })
  return filtered.map(function (item, index) {
    return Object.assign({}, item, {
      orderText: String(index + 1).padStart(2, '0'),
      positionIndex: index
    })
  })
}

function resolveDrag(index, startY, currentY, rowHeight, total) {
  if (!Number.isInteger(index) || total < 1 || !(rowHeight > 0)) return { offset: 0, target: index }
  const rawOffset = currentY - startY
  const minOffset = -index * rowHeight
  const maxOffset = (total - 1 - index) * rowHeight
  const offset = Math.max(minOffset, Math.min(maxOffset, rawOffset))
  const target = Math.max(0, Math.min(total - 1, index + Math.round(offset / rowHeight)))
  return { offset: offset, target: target }
}

function reorder(items, from, to) {
  if (!Array.isArray(items) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return Array.isArray(items) ? items.slice() : []
  }
  const next = items.slice()
  const moved = next.splice(from, 1)[0]
  next.splice(to, 0, moved)
  return next.map(function (item, index) {
    return Object.assign({}, item, {
      orderText: String(index + 1).padStart(2, '0'),
      positionIndex: index
    })
  })
}

module.exports = { prepare: prepare, resolveDrag: resolveDrag, reorder: reorder }
