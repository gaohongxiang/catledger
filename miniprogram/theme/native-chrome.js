// 原生窗口属于当前 Page，不属于主题订阅者。隐藏 Page/组件只能更新自己的视图。
// 在 Page 的最早生命周期发出配色，再由 page-meta 维护页面根节点与声明式外壳。
function createNativeChrome(getWx) {
  let activePage = null
  const attempts = new WeakMap()

  function apply(page, presentation) {
    if (page !== activePage) return
    const previous = attempts.get(page)
    if (previous && previous.themeId === presentation.themeId && !previous.failed) return
    const attempt = { themeId: presentation.themeId, failed: false }
    attempts.set(page, attempt)
    const api = getWx()
    const calls = [
      ['setBackgroundColor', {
        backgroundColor: presentation.themePageColor,
        backgroundColorTop: presentation.themePageColor,
        backgroundColorBottom: presentation.themeCanvasBottom
      }],
      ['setBackgroundTextStyle', { textStyle: presentation.themeBackgroundTextStyle }],
      ['setNavigationBarColor', {
        frontColor: presentation.themeNavFront,
        backgroundColor: presentation.themeNavBackground,
        animation: { duration: 0, timingFunc: 'linear' }
      }]
    ]
    calls.forEach(([name, values]) => {
      if (!api || typeof api[name] !== 'function') return
      const fail = () => {
        // 只让失败的那次失效；迟到回调不得使新页面/新主题重新应用旧色。
        if (attempts.get(page) === attempt) attempt.failed = true
      }
      try { api[name](Object.assign({}, values, { fail })) } catch (_) { fail() }
    })
  }

  return {
    activate(page, presentation) { activePage = page; apply(page, presentation) },
    update(presentation) { if (activePage) apply(activePage, presentation) },
    hide(page) { if (activePage === page) activePage = null },
    detach(page) { if (activePage === page) activePage = null; attempts.delete(page) }
  }
}

module.exports = { createNativeChrome }
