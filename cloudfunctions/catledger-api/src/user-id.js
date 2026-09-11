const { randomInt } = require('node:crypto')

function createUserId() {
  return String(randomInt(1000000000, 10000000000))
}

module.exports = { createUserId }
