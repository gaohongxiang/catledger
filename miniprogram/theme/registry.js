const DEFAULT_THEME_ID = 'warm-ledger'

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
      surface: '#FFFDF9', surfaceMuted: '#F3EEE6', ink: '#29231E', textMuted: '#746A60', textSubtle: '#958B82',
      accent: '#CF7439', accentStrong: '#B85F2E', accentSoft: '#F6E5D8', onAccent: '#FFFAF1',
      secondary: '#64705D', secondarySoft: '#E8EADF', line: 'rgba(41,35,30,.09)', border: 'rgba(111,88,65,.10)',
      heroStart: '#ECA33D', heroEnd: '#DF7F35', heroInk: '#29231E', heroMuted: 'rgba(41,35,30,.62)',
      income: '#64705D', expense: '#B25E36', danger: '#A95132', dangerSoft: '#F4E1D6',
      shadowSoft: '0 8rpx 24rpx rgba(74,50,30,.06)', shadowLifted: '0 14rpx 34rpx rgba(145,87,36,.14)',
      radiusLarge: '26rpx', radiusMedium: '22rpx', radiusSmall: '16rpx', navBackground: '#F8F3EA', navFront: '#000000'
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
      secondary: '#B88A27', secondarySoft: '#F5EBCB', line: 'rgba(23,35,29,.10)', border: 'rgba(11,143,104,.14)',
      heroStart: '#27A77F', heroEnd: '#0B8F68', heroInk: '#F8FFFC', heroMuted: 'rgba(248,255,252,.76)',
      income: '#0B8F68', expense: '#B9673F', danger: '#A94739', dangerSoft: '#F6E3DE',
      shadowSoft: '0 8rpx 22rpx rgba(20,78,58,.07)', shadowLifted: '0 14rpx 32rpx rgba(11,143,104,.16)',
      radiusLarge: '22rpx', radiusMedium: '18rpx', radiusSmall: '14rpx', navBackground: '#F2F7F3', navFront: '#000000'
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
      accent: '#C84B3E', accentStrong: '#A93830', accentSoft: '#F8E1DC', onAccent: '#FFFDFC',
      secondary: '#6D736B', secondarySoft: '#ECEEEA', line: 'rgba(42,33,31,.10)', border: 'rgba(200,75,62,.14)',
      heroStart: '#D85D4F', heroEnd: '#B93D34', heroInk: '#FFFDFC', heroMuted: 'rgba(255,253,252,.76)',
      income: '#557262', expense: '#C84B3E', danger: '#A93830', dangerSoft: '#F8E1DC',
      shadowSoft: '0 7rpx 22rpx rgba(92,49,43,.06)', shadowLifted: '0 14rpx 32rpx rgba(169,56,48,.14)',
      radiusLarge: '18rpx', radiusMedium: '14rpx', radiusSmall: '10rpx', navBackground: '#F9F4F1', navFront: '#000000'
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
      secondary: '#D97732', secondarySoft: '#F5E5D8', line: 'rgba(39,39,42,.11)', border: 'rgba(39,39,42,.12)',
      heroStart: '#66666F', heroEnd: '#3F3F46', heroInk: '#FFFFFF', heroMuted: 'rgba(255,255,255,.72)',
      income: '#5E7565', expense: '#B35F42', danger: '#9C4236', dangerSoft: '#F3E1DC',
      shadowSoft: '0 3rpx 12rpx rgba(39,39,42,.05)', shadowLifted: '0 9rpx 22rpx rgba(39,39,42,.10)',
      radiusLarge: '14rpx', radiusMedium: '10rpx', radiusSmall: '8rpx', navBackground: '#F4F4F2', navFront: '#000000'
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
      secondary: '#819086', secondarySoft: '#EDF1ED', line: 'rgba(43,48,44,.09)', border: 'rgba(74,93,82,.12)',
      heroStart: '#718579', heroEnd: '#4A5D52', heroInk: '#FCFFFC', heroMuted: 'rgba(252,255,252,.74)',
      income: '#4A6C5A', expense: '#A7644B', danger: '#934E3D', dangerSoft: '#F1E3DE',
      shadowSoft: '0 6rpx 20rpx rgba(50,68,57,.045)', shadowLifted: '0 12rpx 28rpx rgba(50,68,57,.10)',
      radiusLarge: '24rpx', radiusMedium: '18rpx', radiusSmall: '12rpx', navBackground: '#F4F7F3', navFront: '#000000'
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
      secondary: '#D6A33A', secondarySoft: '#F5E8BD', line: 'rgba(26,26,24,.16)', border: 'rgba(26,26,24,.42)',
      heroStart: '#E3B84F', heroEnd: '#D19A2E', heroInk: '#1A1A18', heroMuted: 'rgba(26,26,24,.64)',
      income: '#2F7658', expense: '#B25C38', danger: '#984532', dangerSoft: '#F2DED3',
      shadowSoft: '5rpx 5rpx 0 rgba(26,26,24,.10)', shadowLifted: '8rpx 8rpx 0 rgba(26,26,24,.15)',
      radiusLarge: '8rpx', radiusMedium: '6rpx', radiusSmall: '4rpx', navBackground: '#F4F0E4', navFront: '#000000'
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
  TOKEN_NAMES: TOKEN_NAMES,
  getTheme: getTheme,
  getThemePresentation: getThemePresentation,
  listThemes: listThemes,
  normalizeThemeId: normalizeThemeId,
  serializeTokens: serializeTokens
}
