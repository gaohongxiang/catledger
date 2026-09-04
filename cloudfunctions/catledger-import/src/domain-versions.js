// 领域版本只在服务端定义。客户端读取 requiresReorganization，不能复制版本常量。
const PLAN_VERSION = 'organizer-plan-v23'
const EVENT_KEY_VERSION = 'economic-event-key-v2'
const RELATION_KEY_VERSION = 'economic-relation-key-v2'
const REVIEW_ISSUE_VERSION = 'review-issue-v11'

module.exports = {
  EVENT_KEY_VERSION,
  PLAN_VERSION,
  RELATION_KEY_VERSION,
  REVIEW_ISSUE_VERSION
}
