const DEFAULT_AVATAR_URL = '/assets/catledger-logo.png'

function displayAvatarUrl(loggedIn, profile) {
  if (!loggedIn || !profile || !profile.avatarUrl) {
    return DEFAULT_AVATAR_URL
  }
  return String(profile.avatarUrl)
}

module.exports = {
  DEFAULT_AVATAR_URL: DEFAULT_AVATAR_URL,
  displayAvatarUrl: displayAvatarUrl
}
