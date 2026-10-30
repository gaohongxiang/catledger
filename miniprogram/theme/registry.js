const DEFAULT_THEME_ID = 'gilded-ledger'

// 财务语义色：表达收/支与方向（收绿支红），与「主题色 / 强调色」(accent) 物理隔离——
// accent 表达品牌，语义色只表达含义。新增主题时只能引用本对象，不得另写一份硬编码。
//
// 深浅底两套同色相等价色：红永远是支出红、绿永远是收入绿，改变的只是同一个色相在
// 不同亮度背景上的可读性（#2F7A4E 压在 #100F0D 上只有 3.4:1，小字读不清）。
// 主题用 semanticTone 声明自己站在哪一侧，默认浅底。
const SEMANTIC_TOKENS = Object.freeze({
  income: '#2F7A4E',
  expense: '#B23A2A'
})

const SEMANTIC_DARK_TOKENS = Object.freeze({
  income: '#6FB08A',
  expense: '#DE8571'
})

const TOKEN_NAMES = [
  'page',
  'canvasTop',
  'canvasMid',
  'canvasBottom',
  'surface',
  'surfaceMuted',
  'ink',
  'textMuted',
  'textSubtle',
  'accent',
  'accentStrong',
  'accentSoft',
  'onAccent',
  'secondary',
  'secondarySoft',
  'line',
  'border',
  // 警示（逾期、待确认的脏行、负担等级）：跨页面的系统语义，不是某一页的私色。
  'warning',
  'warningSoft',
  'heroStart',
  'heroEnd',
  'heroInk',
  'heroValueInk',
  'heroMuted',
  'danger',
  'dangerSoft',
  'shadowSoft',
  'shadowLifted',
  // 骨架屏扫光的高光。深底上不能用白光扫（那是一道刺眼的白），改用主题色的极淡提亮。
  'shimmer',
  'radiusXl',
  'radiusLarge',
  'radiusMedium',
  'radiusSmall',
  'navBackground',
  'navFront'
]

// 三套主题各承担一种角色，不再按色相堆数量：
// 玄金账簿是唯一的深色方案（通用），藏蓝手账偏男性、香芋紫笺偏女性的明亮方案。
const THEMES = [
  {
    id: 'gilded-ledger',
    name: '玄金账簿',
    eyebrow: 'GILDED LEDGER',
    description: '墨黑底、暗金与暖白，像一册压过金箔的账簿。',
    // 唯一站在深色底上的主题：收支红绿改用同色相的提亮版，小字才读得清。
    semanticTone: 'dark',
    tokens: {
      page: '#100F0D', canvasTop: '#14120F', canvasMid: '#100F0D', canvasBottom: '#14120F',
      surface: '#1C1915', surfaceMuted: '#262016', ink: '#F4EBDC', textMuted: '#A99B85', textSubtle: '#8B7F6C',
      accent: '#D8B25E', accentStrong: '#EFD79A', accentSoft: '#2A2318', onAccent: '#14120F',
      secondary: '#C9A55C', secondarySoft: '#262016', line: '#332C22', border: '#4A3E2C',
      heroStart: '#171410', heroEnd: '#2A2114', heroInk: '#F4EBDC', heroValueInk: '#E7C77E', heroMuted: '#A99672',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#F0B45E', warningSoft: '#2E2416', danger: '#E08A6F', dangerSoft: '#3A2118',
      shadowSoft: '0 10rpx 30rpx rgba(0,0,0,.45)', shadowLifted: '0 10rpx 24rpx rgba(0,0,0,.55)', shimmer: 'rgba(216,178,94,.16)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#100F0D', navFront: '#ffffff'
    }
  },
  {
    id: 'navy-ledger',
    name: '藏蓝手账',
    eyebrow: 'NAVY LEDGER',
    description: '藏蓝与雾白，克制利落，白天高频翻看也不刺眼。',
    tokens: {
      page: '#EFF4FA', canvasTop: '#F3F7FC', canvasMid: '#EFF4FA', canvasBottom: '#F3F7FC',
      surface: '#FFFFFF', surfaceMuted: '#E4ECF6', ink: '#17212E', textMuted: '#566375', textSubtle: '#64707F',
      accent: '#2F5A87', accentStrong: '#24486E', accentSoft: '#DCE8F5', onAccent: '#FFFFFF',
      secondary: '#4A6E92', secondarySoft: '#E4ECF6', line: '#DDE7F2', border: '#C2D2E4',
      heroStart: '#2F5A87', heroEnd: '#3E6E9F', heroInk: '#FFFFFF', heroValueInk: '#FFFFFF', heroMuted: '#DCE8F5',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#B45309', warningSoft: '#FFF3E6', danger: '#A94739', dangerSoft: '#F6E3DE',
      shadowSoft: '0 8rpx 28rpx rgba(47,90,135,.07)', shadowLifted: '0 8rpx 22rpx rgba(36,72,110,.10)', shimmer: 'rgba(255,255,255,.7)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#EFF4FA', navFront: '#000000'
    }
  },
  {
    id: 'taro-note',
    name: '香芋紫笺',
    eyebrow: 'TARO NOTE',
    description: '香芋紫配淡紫纸，柔和但不含糊。',
    tokens: {
      page: '#F6F1FA', canvasTop: '#F9F5FC', canvasMid: '#F6F1FA', canvasBottom: '#F9F5FC',
      surface: '#FFFFFF', surfaceMuted: '#F0E8F7', ink: '#2A2330', textMuted: '#6E6179', textSubtle: '#7C7086',
      accent: '#8E6F9F', accentStrong: '#7A5C8B', accentSoft: '#EFE4F5', onAccent: '#FFFFFF',
      secondary: '#7A6B85', secondarySoft: '#F0E8F7', line: '#EAE0F0', border: '#D5C6DF',
      heroStart: '#826795', heroEnd: '#9E83B0', heroInk: '#FFFFFF', heroValueInk: '#FFFFFF', heroMuted: '#F0E8F7',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#B45309', warningSoft: '#FFF3E6', danger: '#A94739', dangerSoft: '#F6E3DE',
      shadowSoft: '0 8rpx 28rpx rgba(142,111,159,.08)', shadowLifted: '0 8rpx 22rpx rgba(122,92,139,.10)', shimmer: 'rgba(255,255,255,.7)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F6F1FA', navFront: '#000000'
    }
  }
]

const THEME_BY_ID = THEMES.reduce(function (result, theme) {
  result[theme.id] = theme
  return result
}, Object.create(null))

function toCssName(name) {
  return name.replace(/[A-Z]/g, function (letter) { return '-' + letter.toLowerCase() })
}

function normalizeThemeId(themeId) {
  return typeof themeId === 'string' && Object.prototype.hasOwnProperty.call(THEME_BY_ID, themeId)
    ? themeId : DEFAULT_THEME_ID
}

function getTheme(themeId) {
  return THEME_BY_ID[normalizeThemeId(themeId)]
}

function semanticTokens(tone) {
  return tone === 'dark' ? SEMANTIC_DARK_TOKENS : SEMANTIC_TOKENS
}

// 原始配置保留基础语义规范；CSS、图表、预览和原生外壳只消费这份有效快照。
const EFFECTIVE_TOKEN_CACHE = Object.create(null)

function getThemeTokens(themeId) {
  const theme = getTheme(themeId)
  if (!EFFECTIVE_TOKEN_CACHE[theme.id]) {
    EFFECTIVE_TOKEN_CACHE[theme.id] = Object.freeze(Object.assign({}, theme.tokens, semanticTokens(theme.semanticTone)))
  }
  return EFFECTIVE_TOKEN_CACHE[theme.id]
}

function serializeTokens(tokens, prefix) {
  const variablePrefix = prefix || '--theme-'
  return TOKEN_NAMES.map(function (name) {
    return variablePrefix + toCssName(name) + ':' + tokens[name]
  }).join(';') + ';'
}

// 语义色全局变量（--sem-*）。与主题 token 分开命名、分开取值，绝不互相引用；
// 但和主题变量一起挂在页面根节点的同一条 style 上——小程序没有别的注入通道，
// 分成两条 style 反而会出现"某个页面漏绑一条"的错色。
// 深浅两套只按主题的 semanticTone 切换，色相与含义不变。
function serializeSemanticColors(tokens, prefix) {
  const variablePrefix = prefix || '--sem-'
  return Object.keys(SEMANTIC_TOKENS).map(function (name) {
    return variablePrefix + toCssName(name) + ':' + tokens[name]
  }).join(';') + ';'
}

function serializeSemanticTokens(prefix, tone) {
  return serializeSemanticColors(semanticTokens(tone), prefix)
}

// 底色亮度决定「下拉 loading 与小字号该用深色还是浅色」。
// 由 page 色算而不是逐主题声明，是为了新增深色主题时不必再记一条配置。
function isDarkColor(hex) {
  const channels = String(hex).replace('#', '').match(/[\da-f]{2}/gi)
  if (!channels) return false
  const luminance = (0.299 * parseInt(channels[0], 16) + 0.587 * parseInt(channels[1], 16) + 0.114 * parseInt(channels[2], 16)) / 255
  return luminance < 0.5
}

// 页面外壳（page 根节点、窗口背景、导航栏）只能吃字面色值：
// 原生属性与 page 根节点都不在 var(--theme-*) 的继承链上——变量只挂在页面子树里。
// 因此这一组值必须与 themeStyle 从同一份有效快照派生。
function systemChrome(tokens) {
  const dark = isDarkColor(tokens.page)
  return {
    themePageColor: tokens.page,
    themeCanvasBottom: tokens.canvasBottom,
    themePageStyle: 'background:' + tokens.page + ';color:' + tokens.ink + ';',
    themeBackgroundTextStyle: dark ? 'light' : 'dark',
    themeNavBackground: tokens.navBackground,
    themeNavFront: tokens.navFront
  }
}

// 主题展示数据按 themeId 缓存，供定义初值和实例同步复用。
const PRESENTATION_CACHE = Object.create(null)

function getThemePresentation(themeId) {
  const theme = getTheme(themeId)
  if (!PRESENTATION_CACHE[theme.id]) {
    const tokens = getThemeTokens(theme.id)
    const semantic = serializeSemanticColors(tokens)
    PRESENTATION_CACHE[theme.id] = Object.freeze(Object.assign({
      themeId: theme.id,
      themeName: theme.name,
      themeClass: 'theme-' + theme.id,
      themeStyle: serializeTokens(tokens) + semantic,
      semanticStyle: semantic,
      themeIconRoot: '/assets/icons/themes/' + theme.id
    }, systemChrome(tokens)))
  }
  return PRESENTATION_CACHE[theme.id]
}

function listThemes() {
  return THEMES.map(function (theme) {
    const tokens = getThemeTokens(theme.id)
    return {
      id: theme.id,
      name: theme.name,
      eyebrow: theme.eyebrow,
      description: theme.description,
      previewStyle: serializeTokens(tokens, '--preview-') + serializeSemanticColors(tokens, '--preview-')
    }
  })
}

module.exports = {
  DEFAULT_THEME_ID: DEFAULT_THEME_ID,
  SEMANTIC_DARK_TOKENS: SEMANTIC_DARK_TOKENS,
  SEMANTIC_TOKENS: SEMANTIC_TOKENS,
  TOKEN_NAMES: TOKEN_NAMES,
  getTheme: getTheme,
  getThemeTokens: getThemeTokens,
  getThemePresentation: getThemePresentation,
  isDarkColor: isDarkColor,
  listThemes: listThemes,
  serializeSemanticTokens: serializeSemanticTokens,
  normalizeThemeId: normalizeThemeId,
  serializeTokens: serializeTokens
}
