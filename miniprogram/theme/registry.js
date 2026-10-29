const DEFAULT_THEME_ID = 'warm-ledger'

// 财务语义色：表达收/支与方向（收绿支红），与「主题色 / 强调色」(accent) 物理隔离——
// accent 表达品牌，语义色只表达含义。新增主题时只能引用本对象，不得另写一份硬编码。
//
// 深浅底两套同色相等价色：红永远是支出红、绿永远是收入绿，改变的只是同一个色相在
// 不同亮度背景上的可读性（#477153 压在 #100F0D 上只有 3.3:1，小字读不清）。
// 主题用 semanticTone 声明自己站在哪一侧，默认浅底。
const SEMANTIC_TOKENS = Object.freeze({
  income: '#477153',
  expense: '#B54738'
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

const THEMES = [
  {
    id: 'warm-ledger',
    name: '暖橘手账',
    eyebrow: 'WARM LEDGER',
    description: '暖白、陶橘与轻灰，清秀而有温度。',
    tokens: {
      page: '#FAF8F4', canvasTop: '#FAF8F4', canvasMid: '#FAF8F4', canvasBottom: '#FAF8F4',
      surface: '#FFFEFD', surfaceMuted: '#F4EEE3', ink: '#2C2823', textMuted: '#70685F', textSubtle: '#79716A',
      accent: '#BE5B24', accentStrong: '#A34D20', accentSoft: '#F0E2CE', onAccent: '#FFFFFF',
      secondary: '#70685F', secondarySoft: '#F4EEE3', line: '#EAE4DC', border: '#D4CCC3',
      heroStart: '#BE5B24', heroEnd: '#BE5B24', heroInk: '#FFFFFF', heroValueInk: '#FFFFFF', heroMuted: '#FFFFFF',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#B07726', warningSoft: '#FBEFD9', danger: '#A95132', dangerSoft: '#F6E4D4',
      shadowSoft: '0 8rpx 28rpx rgba(190,91,36,.07)', shadowLifted: '0 8rpx 22rpx rgba(145,87,36,.10)', shimmer: 'rgba(255,255,255,.62)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#FAF8F4', navFront: '#000000'
    }
  },
  {
    id: 'emerald-list',
    name: '青绿清单',
    eyebrow: 'EMERALD LIST',
    description: '从薄荷浅绿到浓郁青绿，适合高频查看与整理。',
    tokens: {
      page: '#F2F7F3', canvasTop: '#F7FAF7', canvasMid: '#EEF5F0', canvasBottom: '#F5F8F4',
      surface: '#FFFFFF', surfaceMuted: '#E6F5EC', ink: '#17231D', textMuted: '#526E60', textSubtle: '#607C6E',
      accent: '#087D5B', accentStrong: '#087654', accentSoft: '#CFEBDD', onAccent: '#F8FFFC',
      secondary: '#2F7258', secondarySoft: '#E0F1E7', line: '#CBE5D8', border: '#9DCFB9',
      heroStart: '#197858', heroEnd: '#197858', heroInk: '#F8FFFC', heroValueInk: '#EAF6EF', heroMuted: '#E5F3EC',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#96701A', warningSoft: '#FAF2DA', danger: '#A94739', dangerSoft: '#F6E3DE',
      shadowSoft: '0 8rpx 28rpx rgba(8,125,91,.07)', shadowLifted: '0 8rpx 22rpx rgba(11,143,104,.10)', shimmer: 'rgba(255,255,255,.7)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F2F7F3', navFront: '#000000'
    }
  },
  {
    id: 'red-editorial',
    name: '红印编辑',
    eyebrow: 'RED EDITORIAL',
    description: '克制的砖红与纸白，像一本有批注的财务月刊。',
    tokens: {
      page: '#F9F4F1', canvasTop: '#FFFCFA', canvasMid: '#F8F1EE', canvasBottom: '#FCF7F4',
      surface: '#FFFEFC', surfaceMuted: '#F7E3E3', ink: '#2A211F', textMuted: '#795F59', textSubtle: '#8A6D64',
      accent: '#B74F43', accentStrong: '#9F4137', accentSoft: '#ECC7C4', onAccent: '#FFFDFC',
      secondary: '#96584D', secondarySoft: '#F2DADA', line: '#E8CDCC', border: '#D3A29F',
      heroStart: '#AD493E', heroEnd: '#AD493E', heroInk: '#FFFDFC', heroValueInk: '#FBEAE4', heroMuted: '#FAEBE7',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#9E7326', warningSoft: '#FAF0DC', danger: '#A93830', dangerSoft: '#F8E1DC',
      shadowSoft: '0 8rpx 28rpx rgba(183,79,67,.07)', shadowLifted: '0 8rpx 20rpx rgba(159,65,55,.09)', shimmer: 'rgba(255,255,255,.62)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F9F4F1', navFront: '#000000'
    }
  },
  {
    id: 'graphite-order',
    name: '石墨秩序',
    eyebrow: 'GRAPHITE ORDER',
    description: '低饱和石墨灰，强调数字、层级与安静的留白。',
    tokens: {
      page: '#F4F4F2', canvasTop: '#FAFAF8', canvasMid: '#F3F3F1', canvasBottom: '#F7F7F5',
      surface: '#FFFFFF', surfaceMuted: '#EBECF0', ink: '#27272A', textMuted: '#626675', textSubtle: '#747887',
      accent: '#52525B', accentStrong: '#3F3F46', accentSoft: '#DCDEE5', onAccent: '#FFFFFF',
      secondary: '#6B6E7D', secondarySoft: '#E7E8EE', line: '#DADCE3', border: '#BABEC9',
      heroStart: '#626269', heroEnd: '#626269', heroInk: '#FFFFFF', heroValueInk: '#F0EFED', heroMuted: '#F0F0F3',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#86682F', warningSoft: '#F5EFE2', danger: '#9C4236', dangerSoft: '#F3E1DC',
      shadowSoft: '0 8rpx 28rpx rgba(63,63,70,.07)', shadowLifted: '0 7rpx 18rpx rgba(39,39,42,.08)', shimmer: 'rgba(255,255,255,.75)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F4F4F2', navFront: '#000000'
    }
  },
  {
    id: 'zen-ink',
    name: '墨绿留白',
    eyebrow: 'ZEN INK',
    description: '墨绿、米白与细线，让账目有更舒展的呼吸感。',
    tokens: {
      page: '#F4F7F3', canvasTop: '#FAFCF9', canvasMid: '#F1F5F0', canvasBottom: '#F7F9F6',
      surface: '#FEFFFC', surfaceMuted: '#E8EFE4', ink: '#2B302C', textMuted: '#5C7159', textSubtle: '#70836B',
      accent: '#4A5D52', accentStrong: '#394940', accentSoft: '#D7E3D3', onAccent: '#FCFFFC',
      secondary: '#536D4F', secondarySoft: '#E4ECDF', line: '#CFDDC9', border: '#B0C3AA',
      heroStart: '#526B55', heroEnd: '#526B55', heroInk: '#FCFFFC', heroValueInk: '#EEF3EF', heroMuted: '#EDF3E9',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#87692B', warningSoft: '#F6F1E0', danger: '#934E3D', dangerSoft: '#F1E3DE',
      shadowSoft: '0 8rpx 28rpx rgba(74,93,82,.07)', shadowLifted: '0 7rpx 18rpx rgba(50,68,57,.07)', shimmer: 'rgba(255,255,255,.65)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F4F7F3', navFront: '#000000'
    }
  },
  {
    id: 'ticket-proof',
    name: '票据凭证',
    eyebrow: 'TICKET PROOF',
    description: '黑底、暗金与暖白，像一叠压印过金箔的凭证。',
    // 唯一站在深色底上的主题：收支红绿改用同色相的提亮版，小字才读得清。
    semanticTone: 'dark',
    tokens: {
      page: '#100F0D', canvasTop: '#14120F', canvasMid: '#100F0D', canvasBottom: '#14120F',
      surface: '#1C1915', surfaceMuted: '#262016', ink: '#F4EBDC', textMuted: '#A99B85', textSubtle: '#8B7F6C',
      accent: '#D8B25E', accentStrong: '#EFD79A', accentSoft: '#2A2318', onAccent: '#14120F',
      secondary: '#C9A55C', secondarySoft: '#262016', line: '#332C22', border: '#4A3E2C',
      heroStart: '#171410', heroEnd: '#2A2114', heroInk: '#F4EBDC', heroValueInk: '#E7C77E', heroMuted: '#A99672',
      income: SEMANTIC_TOKENS.income, expense: SEMANTIC_TOKENS.expense,
      warning: '#E0A65C', warningSoft: '#2E2416', danger: '#E08A6F', dangerSoft: '#3A2118',
      shadowSoft: '0 10rpx 30rpx rgba(0,0,0,.45)', shadowLifted: '0 10rpx 24rpx rgba(0,0,0,.55)', shimmer: 'rgba(216,178,94,.16)',
      radiusXl: '32rpx', radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#100F0D', navFront: '#ffffff'
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
