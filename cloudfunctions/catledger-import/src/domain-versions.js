// 领域版本在服务端维护，通过 import-local-rules 脚本同步本机规则镜像。
// local_v3 恢复按客户端版本核对快照；联网时再读取服务端 requiresReorganization。
// 整理规则变化时递增：已核对草稿按新规则从原文重算，本机按稳定键迁移原决定。
const PLAN_VERSION = 'organizer-plan-v43'
const EVENT_KEY_VERSION = 'economic-event-key-v2'
const RELATION_KEY_VERSION = 'economic-relation-key-v2'
const REVIEW_ISSUE_VERSION = 'review-issue-v13'

module.exports = {
  EVENT_KEY_VERSION,
  PLAN_VERSION,
  RELATION_KEY_VERSION,
  REVIEW_ISSUE_VERSION
}
