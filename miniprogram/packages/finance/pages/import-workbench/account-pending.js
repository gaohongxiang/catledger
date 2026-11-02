// 当前页的计数不能代表全批。离页的未确认输入仍须阻止继续和入账，
// 但这只是 UI 门禁，不把输入伪装成已保存的账户决定。
function count(page, pending = 0, updateId = page.data.update?.updateId) {
  const session = page._draftSession
  if (!session || session.state?.updateId !== updateId) return Number(pending || 0)
  // 旧联网草稿的摘要可能仍在同步，不能覆盖页面已经确认的本地投影。
  const globalPending = session.isLocal ? Number(session.view?.workbench?.accountStepSummary?.pending || 0) : 0
  const drafts = page._accountUiDrafts ? [...page._accountUiDrafts.values()] : Object.values(session.state.drafts || {})
  const unconfirmed = drafts.some(draft => draft?.dirty && !draft.localConfirmed)
  return Math.max(Number(pending || 0), globalPending, unconfirmed ? 1 : 0)
}

module.exports = { count }
