const policy = require('./organizer-plan-policy')
const { randomUUID } = require('node:crypto')
module.exports = { ...policy, buildOrganizePlan: ({ idFactory = randomUUID, ...options }) => policy.buildOrganizePlan({ ...options, idFactory }) }
