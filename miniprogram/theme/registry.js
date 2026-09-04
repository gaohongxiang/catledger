const DEFAULT_THEME_ID = 'warm-ledger'

const FINANCIAL_SEMANTICS = Object.freeze({
  income: '#477153',
  expense: '#B54738'
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
  'heroStart',
  'heroEnd',
  'heroInk',
  'heroValueInk',
  'heroMuted',
  'income',
  'expense',
  'danger',
  'dangerSoft',
  'shadowSoft',
  'shadowLifted',
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
    description: '暖橘与灰绿，像一本常翻常新的生活手账。',
    tokens: {
      page: '#F8F3EA', canvasTop: '#FBF7F0', canvasMid: '#F7F1E7', canvasBottom: '#F9F4EC',
      surface: '#FFFDF9', surfaceMuted: '#F8E8DC', ink: '#29231E', textMuted: '#746A60', textSubtle: '#958B82',
      accent: '#D97732', accentStrong: '#B85F2E', accentSoft: '#F5DDCB', onAccent: '#FFFAF1',
      secondary: '#64705D', secondarySoft: '#E8EADF', line: 'rgba(41,35,30,.09)', border: 'rgba(111,88,65,.10)',
      heroStart: '#D97732', heroEnd: '#D97732', heroInk: '#29231E', heroValueInk: '#633921', heroMuted: 'rgba(41,35,30,.66)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#A95132', dangerSoft: '#F4E1D6',
      shadowSoft: '0 3rpx 14rpx rgba(74,50,30,.035)', shadowLifted: '0 8rpx 22rpx rgba(145,87,36,.10)',
      radiusLarge: '22rpx', radiusMedium: '16rpx', radiusSmall: '10rpx', navBackground: '#F8F3EA', navFront: '#000000'
    }
  },
  {
    id: 'emerald-list',
    name: '青绿清单',
    eyebrow: 'EMERALD LIST',
    description: '清醒的青绿配一抹麦黄，适合高频查看与整理。',
    tokens: {
      page: '#F2F7F3', canvasTop: '#F7FAF7', canvasMid: '#EEF5F0', canvasBottom: '#F5F8F4',
      surface: '#FFFFFF', surfaceMuted: '#E9F2EC', ink: '#17231D', textMuted: '#5D6E64', textSubtle: '#87958D',
      accent: '#0B8F68', accentStrong: '#087654', accentSoft: '#DDF1E9', onAccent: '#F8FFFC',
      secondary: '#987728', secondarySoft: '#F3EACD', line: 'rgba(23,35,29,.08)', border: 'rgba(11,143,104,.11)',
      heroStart: '#2F9E7A', heroEnd: '#2F9E7A', heroInk: '#F8FFFC', heroValueInk: '#EAF6EF', heroMuted: 'rgba(248,255,252,.78)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#A94739', dangerSoft: '#F6E3DE',
      shadowSoft: '0 3rpx 14rpx rgba(20,78,58,.035)', shadowLifted: '0 8rpx 22rpx rgba(11,143,104,.10)',
      radiusLarge: '21rpx', radiusMedium: '16rpx', radiusSmall: '10rpx', navBackground: '#F2F7F3', navFront: '#000000'
    }
  },
  {
    id: 'red-editorial',
    name: '红印编辑',
    eyebrow: 'RED EDITORIAL',
    description: '克制的砖红与纸白，像一本有批注的财务月刊。',
    tokens: {
      page: '#F9F4F1', canvasTop: '#FFFCFA', canvasMid: '#F8F1EE', canvasBottom: '#FCF7F4',
      surface: '#FFFEFC', surfaceMuted: '#F8ECE8', ink: '#2A211F', textMuted: '#76645E', textSubtle: '#9B8881',
      accent: '#BF574A', accentStrong: '#9F4137', accentSoft: '#F5E3DF', onAccent: '#FFFDFC',
      secondary: '#6D736B', secondarySoft: '#ECEEEA', line: 'rgba(42,33,31,.08)', border: 'rgba(191,87,74,.11)',
      heroStart: '#C65D50', heroEnd: '#C65D50', heroInk: '#FFFDFC', heroValueInk: '#FBEAE4', heroMuted: 'rgba(255,253,252,.78)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#A93830', dangerSoft: '#F8E1DC',
      shadowSoft: '0 3rpx 13rpx rgba(92,49,43,.035)', shadowLifted: '0 8rpx 20rpx rgba(159,65,55,.09)',
      radiusLarge: '20rpx', radiusMedium: '15rpx', radiusSmall: '9rpx', navBackground: '#F9F4F1', navFront: '#000000'
    }
  },
  {
    id: 'graphite-order',
    name: '石墨秩序',
    eyebrow: 'GRAPHITE ORDER',
    description: '低饱和石墨灰，强调数字、层级与安静的留白。',
    tokens: {
      page: '#F4F4F2', canvasTop: '#FAFAF8', canvasMid: '#F3F3F1', canvasBottom: '#F7F7F5',
      surface: '#FFFFFF', surfaceMuted: '#ECECEA', ink: '#27272A', textMuted: '#626267', textSubtle: '#929297',
      accent: '#52525B', accentStrong: '#3F3F46', accentSoft: '#E7E7EA', onAccent: '#FFFFFF',
      secondary: '#C36F35', secondarySoft: '#F3E5D9', line: 'rgba(39,39,42,.08)', border: 'rgba(39,39,42,.10)',
      heroStart: '#626269', heroEnd: '#626269', heroInk: '#FFFFFF', heroValueInk: '#F0EFED', heroMuted: 'rgba(255,255,255,.76)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#9C4236', dangerSoft: '#F3E1DC',
      shadowSoft: '0 2rpx 10rpx rgba(39,39,42,.03)', shadowLifted: '0 7rpx 18rpx rgba(39,39,42,.08)',
      radiusLarge: '18rpx', radiusMedium: '14rpx', radiusSmall: '8rpx', navBackground: '#F4F4F2', navFront: '#000000'
    }
  },
  {
    id: 'zen-ink',
    name: '墨绿留白',
    eyebrow: 'ZEN INK',
    description: '墨绿、米白与细线，让账目有更舒展的呼吸感。',
    tokens: {
      page: '#F4F7F3', canvasTop: '#FAFCF9', canvasMid: '#F1F5F0', canvasBottom: '#F7F9F6',
      surface: '#FEFFFC', surfaceMuted: '#EAF0E9', ink: '#2B302C', textMuted: '#68736C', textSubtle: '#929C95',
      accent: '#4A5D52', accentStrong: '#394940', accentSoft: '#E0E8E2', onAccent: '#FCFFFC',
      secondary: '#77867C', secondarySoft: '#EDF1ED', line: 'rgba(43,48,44,.075)', border: 'rgba(74,93,82,.10)',
      heroStart: '#6D8074', heroEnd: '#6D8074', heroInk: '#FCFFFC', heroValueInk: '#EEF3EF', heroMuted: 'rgba(252,255,252,.78)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#934E3D', dangerSoft: '#F1E3DE',
      shadowSoft: '0 2rpx 12rpx rgba(50,68,57,.03)', shadowLifted: '0 7rpx 18rpx rgba(50,68,57,.07)',
      radiusLarge: '22rpx', radiusMedium: '16rpx', radiusSmall: '10rpx', navBackground: '#F4F7F3', navFront: '#000000'
    }
  },
  {
    id: 'ticket-proof',
    name: '票据凭证',
    eyebrow: 'TICKET PROOF',
    description: '纸张、墨线与硬朗编号，像一叠整理妥当的凭证。',
    tokens: {
      page: '#F4F0E4', canvasTop: '#FFFDF3', canvasMid: '#F7F2E5', canvasBottom: '#FBF7EC',
      surface: '#FFFEF8', surfaceMuted: '#EFEBDD', ink: '#1A1A18', textMuted: '#68665E', textSubtle: '#8F8B80',
      accent: '#2F7658', accentStrong: '#245D46', accentSoft: '#DDEADF', onAccent: '#FFFEF8',
      secondary: '#A98532', secondarySoft: '#F2E8C8', line: 'rgba(26,26,24,.10)', border: 'rgba(26,26,24,.18)',
      heroStart: '#D9B45D', heroEnd: '#D9B45D', heroInk: '#1A1A18', heroValueInk: '#3C311B', heroMuted: 'rgba(26,26,24,.66)',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#984532', dangerSoft: '#F2DED3',
      shadowSoft: '0 2rpx 10rpx rgba(26,26,24,.035)', shadowLifted: '0 7rpx 18rpx rgba(26,26,24,.08)',
      radiusLarge: '18rpx', radiusMedium: '14rpx', radiusSmall: '8rpx', navBackground: '#F4F0E4', navFront: '#000000'
    }
  }
]

const THEME_BY_ID = THEMES.reduce(function (result, theme) {
  result[theme.id] = theme
  return result
}, {})

function toCssName(name) {
  return name.replace(/[A-Z]/g, function (letter) { return '-' + letter.toLowerCase() })
}

function normalizeThemeId(themeId) {
  return THEME_BY_ID[themeId] ? themeId : DEFAULT_THEME_ID
}

function getTheme(themeId) {
  return THEME_BY_ID[normalizeThemeId(themeId)]
}

function serializeTokens(tokens, prefix) {
  const variablePrefix = prefix || '--theme-'
  return TOKEN_NAMES.map(function (name) {
    return variablePrefix + toCssName(name) + ':' + tokens[name]
  }).join(';') + ';'
}

function getThemePresentation(themeId) {
  const theme = getTheme(themeId)
  return {
    themeId: theme.id,
    themeName: theme.name,
    themeClass: 'theme-' + theme.id,
    themeStyle: serializeTokens(theme.tokens)
  }
}

function listThemes() {
  return THEMES.map(function (theme) {
    return {
      id: theme.id,
      name: theme.name,
      eyebrow: theme.eyebrow,
      description: theme.description,
      previewStyle: serializeTokens(theme.tokens, '--preview-')
    }
  })
}

module.exports = {
  DEFAULT_THEME_ID: DEFAULT_THEME_ID,
  FINANCIAL_SEMANTICS: FINANCIAL_SEMANTICS,
  TOKEN_NAMES: TOKEN_NAMES,
  getTheme: getTheme,
  getThemePresentation: getThemePresentation,
  listThemes: listThemes,
  normalizeThemeId: normalizeThemeId,
  serializeTokens: serializeTokens
}
