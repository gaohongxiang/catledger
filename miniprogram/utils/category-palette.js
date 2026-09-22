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
  '住房': 'teal', '居住': 'teal', '生活缴费': 'yellow', '人情': 'red', '工资': 'teal', '奖金': 'yellow', '兼职': 'blue', '理财收益': 'green', '礼金': 'red', '通讯': 'blue', '金融保险': 'teal',
  '医疗': 'red',
  '教育': 'yellow',
  '娱乐': 'green'
})

const ICON_BY_NAME = Object.freeze({
  '餐饮': 'dining',
  '交通': 'transport',
  '购物': 'shopping',
  '住房': 'housing', '居住': 'housing', '生活缴费': 'utilities', '人情': 'social', '工资': 'salary', '奖金': 'bonus', '兼职': 'part-time', '理财收益': 'investment', '礼金': 'gift', '通讯': 'communication', '金融保险': 'finance', '其他支出': 'other', '其他收入': 'other',
  '医疗': 'medical',
  '教育': 'education',
  '娱乐': 'entertainment',
  '其他': 'other'
})

const STYLE_BY_KEY = Object.freeze({
  food: ['dining', 'orange'], transport: ['transport', 'blue'], shopping: ['shopping', 'purple'],
  housing: ['housing', 'teal'], utilities: ['utilities', 'yellow'], medical: ['medical', 'red'],
  education: ['education', 'yellow'], entertainment: ['entertainment', 'green'], social: ['social', 'red'],
  communication: ['communication', 'blue'], finance: ['finance', 'teal'], other_expense: ['other', 'grey'],
  salary: ['salary', 'teal'], bonus: ['bonus', 'yellow'], part_time: ['part-time', 'blue'],
  investment: ['investment', 'green'], gift: ['gift', 'red'], other_income: ['other', 'grey']
})
function styleFor(systemKey) { return STYLE_BY_KEY[String(systemKey || '').split('__')[0]] }
function colorNameFor(name, systemKey) {
  const style = styleFor(systemKey)
  return style ? style[1] : COLOR_BY_NAME[name] || 'grey'
}
function bandColorFor(name, systemKey) { return TILE_COLORS[colorNameFor(name, systemKey)].solid }
function iconFor(name, systemKey) {
  const style = styleFor(systemKey), stem = style ? style[0] : ICON_BY_NAME[name] || 'other'
  return '/assets/icons/categories/' + stem + '.svg'
}
module.exports = { TILE_COLORS, COLOR_BY_NAME, ICON_BY_NAME, STYLE_BY_KEY, colorNameFor, bandColorFor, iconFor }
