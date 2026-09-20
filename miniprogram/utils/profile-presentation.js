const DEFAULT_AVATAR_URL = '/assets/catledger-logo.png'
const NICKNAME_MAX_LENGTH = 6
const DEFAULT_NICKNAMES = [
  '晒太阳的小猫', '橘子汽水', '听雨的阿橘', '慢悠悠的小猫',
  '月亮小鱼干', '抱着云朵', '奶油小饼干', '午后猫薄荷',
  '口袋里的糖', '窗边小橘', '海盐布丁', '一颗小栗子',
  '软软的饭团', '晚风里的猫', '小鱼晒太阳', '桃子乌龙',
  '草莓吐司', '偷懒的阿喵', '捡贝壳的小猫', '星星便利店',
  '猫爪棉花糖', '半杯热可可', '芝麻小汤圆', '会打盹的云'
]

function randomNickname(current) {
  const choices = DEFAULT_NICKNAMES.filter(function (name) { return name !== current })
  return choices[Math.floor(Math.random() * choices.length)]
}

function withDefaultProfile(profile, fallback) {
  profile = profile || {}
  fallback = fallback || {}
  // 已存昵称只复用，不在展示或更换头像时截短旧值。
  const nickname = String(profile.nickname || '').trim()
    || String(fallback.nickname || '').trim()
    || randomNickname()
  return {
    nickname: nickname,
    avatarUrl: String(profile.avatarUrl || fallback.avatarUrl || DEFAULT_AVATAR_URL)
  }
}

function displayUserId(uid) {
  return String(uid || '')
}

function displayAvatarUrl(loggedIn, profile) {
  if (!loggedIn || !profile || !profile.avatarUrl) {
    return DEFAULT_AVATAR_URL
  }
  return String(profile.avatarUrl)
}

module.exports = {
  NICKNAME_MAX_LENGTH: NICKNAME_MAX_LENGTH,
  displayUserId: displayUserId,
  randomNickname: randomNickname,
  withDefaultProfile: withDefaultProfile,
  DEFAULT_AVATAR_URL: DEFAULT_AVATAR_URL,
  displayAvatarUrl: displayAvatarUrl
}
