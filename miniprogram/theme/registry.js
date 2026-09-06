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
    description: '暖白、陶橘与轻灰，清秀而有温度。',
    tokens: {
      page: '#FAF8F4', canvasTop: '#FAF8F4', canvasMid: '#FAF8F4', canvasBottom: '#FAF8F4',
      surface: '#FFFEFD', surfaceMuted: '#F1EEE9', ink: '#2C2823', textMuted: '#70685F', textSubtle: '#79716A',
      accent: '#BE5B24', accentStrong: '#A34D20', accentSoft: '#FCEEE3', onAccent: '#FFFFFF',
      secondary: '#70685F', secondarySoft: '#F1EEE9', line: '#EAE4DC', border: '#D4CCC3',
      heroStart: '#BE5B24', heroEnd: '#BE5B24', heroInk: '#FFFFFF', heroValueInk: '#FFFFFF', heroMuted: '#FFFFFF',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#A95132', dangerSoft: '#F4E1D6',
      shadowSoft: '0 3rpx 14rpx rgba(74,50,30,.035)', shadowLifted: '0 8rpx 22rpx rgba(145,87,36,.10)',
      radiusLarge: '22rpx', radiusMedium: '16rpx', radiusSmall: '10rpx', navBackground: '#FAF8F4', navFront: '#000000'
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
      surface: '#FFFEFC', surfaceMuted: '#F7E3E3', ink: '#2A211F', textMuted: '#795F59', textSubtle: '#8A6D64',
      accent: '#B74F43', accentStrong: '#9F4137', accentSoft: '#ECC7C4', onAccent: '#FFFDFC',
      secondary: '#96584D', secondarySoft: '#F2DADA', line: '#E8CDCC', border: '#D3A29F',
      heroStart: '#AD493E', heroEnd: '#AD493E', heroInk: '#FFFDFC', heroValueInk: '#FBEAE4', heroMuted: '#FAEBE7',
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
      surface: '#FFFFFF', surfaceMuted: '#EBECF0', ink: '#27272A', textMuted: '#626675', textSubtle: '#747887',
      accent: '#52525B', accentStrong: '#3F3F46', accentSoft: '#DCDEE5', onAccent: '#FFFFFF',
      secondary: '#6B6E7D', secondarySoft: '#E7E8EE', line: '#DADCE3', border: '#BABEC9',
      heroStart: '#626269', heroEnd: '#626269', heroInk: '#FFFFFF', heroValueInk: '#F0EFED', heroMuted: '#F0F0F3',
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
      surface: '#FEFFFC', surfaceMuted: '#E8EFE4', ink: '#2B302C', textMuted: '#5C7159', textSubtle: '#70836B',
      accent: '#4A5D52', accentStrong: '#394940', accentSoft: '#D7E3D3', onAccent: '#FCFFFC',
      secondary: '#536D4F', secondarySoft: '#E4ECDF', line: '#CFDDC9', border: '#B0C3AA',
      heroStart: '#526B55', heroEnd: '#526B55', heroInk: '#FCFFFC', heroValueInk: '#EEF3EF', heroMuted: '#EDF3E9',
      income: FINANCIAL_SEMANTICS.income, expense: FINANCIAL_SEMANTICS.expense, danger: '#934E3D', dangerSoft: '#F1E3DE',
      shadowSoft: '0 2rpx 12rpx rgba(50,68,57,.03)', shadowLifted: '0 7rpx 18rpx rgba(50,68,57,.07)',
      radiusLarge: '22rpx', radiusMedium: '16rpx', radiusSmall: '10rpx', navBackground: '#F4F7F3', navFront: '#000000'
    }
  },
  {
    id: 'ticket-proof',
    name: '票据凭证',
    eyebrow: 'TICKET PROOF',
    description: '奶油纸色、麦金与赭棕，像一叠整理妥当的凭证。',
    tokens: {
      page: '#F4F0E4', canvasTop: '#FFFDF3', canvasMid: '#F7F2E5', canvasBottom: '#FBF7EC',
      surface: '#FFFEF8', surfaceMuted: '#F4EBD5', ink: '#1A1A18', textMuted: '#746445', textSubtle: '#837254',
      accent: '#956C24', accentStrong: '#76531C', accentSoft: '#EFDFB7', onAccent: '#FFFEF8',
      secondary: '#856522', secondarySoft: '#F3E8CD', line: '#E2D4B4', border: '#C8AF7B',
      heroStart: '#D9B45D', heroEnd: '#D9B45D', heroInk: '#1A1A18', heroValueInk: '#3C311B', heroMuted: '#574425',
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
    themeStyle: serializeTokens(theme.tokens),
    themeIconRoot: '/assets/icons/themes/' + theme.id
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
