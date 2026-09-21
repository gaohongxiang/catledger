const TILE_COLORS = Object.freeze({
  orange: { soft: '#f6e3d4', ink: '#a0511f', solid: '#c97a45' },
  green: { soft: '#e2ebdc', ink: '#4f6b45', solid: '#7a9a6c' },
  blue: { soft: '#dfe8f0', ink: '#3f5e7a', solid: '#6f8fae' },
  purple: { soft: '#e9e3f2', ink: '#655084', solid: '#9b87c0' },
  yellow: { soft: '#f3ead0', ink: '#7a5f22', solid: '#cfa94f' },
  red: { soft: '#f3deda', ink: '#9c463a', solid: '#bf6252' },
  teal: { soft: '#dcebe7', ink: '#2f6b60', solid: '#57a08e' },
  grey: { soft: '#eae6e4', ink: '#6e6560', solid: '#a89f98' }
})

const COLOR_BY_NAME = Object.freeze({
  '餐饮': 'orange',
  '交通': 'blue',
  '购物': 'purple',
  '住房': 'teal',
  '医疗': 'red',
  '教育': 'yellow',
  '娱乐': 'green'
})

const ICON_BY_NAME = Object.freeze({
  '餐饮': 'dining',
  '交通': 'transport',
  '购物': 'shopping',
  '住房': 'housing',
  '医疗': 'medical',
  '教育': 'education',
  '娱乐': 'entertainment',
  '其他': 'other'
})

function colorNameFor(name) {
  return COLOR_BY_NAME[name] || 'grey'
}

function bandColorFor(name) {
  return TILE_COLORS[colorNameFor(name)].solid
}

function iconFor(name) {
  const stem = ICON_BY_NAME[name]
  return stem ? '/assets/icons/categories/' + stem + '.svg' : ''
}

module.exports = {
  TILE_COLORS: TILE_COLORS,
  COLOR_BY_NAME: COLOR_BY_NAME,
  ICON_BY_NAME: ICON_BY_NAME,
  colorNameFor: colorNameFor,
  bandColorFor: bandColorFor,
  iconFor: iconFor
}
