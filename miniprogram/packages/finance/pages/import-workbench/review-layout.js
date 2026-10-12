// 原生 scroll-view 的内部视口不会跟随 flex 压缩；按内容和实际剩余空间给出明确高度。
function schedule(page) {
  page._issueLayoutToken = page.data.directorySheet || page.data.currentIssue && !page.data.evidenceSheet ? {} : null
  if (!page._issueLayoutToken || page._issueLayoutTick || typeof page.createSelectorQuery !== 'function') return
  page._issueLayoutTick = true
  wx.nextTick(function () {
    page._issueLayoutTick = false
    const token = page._issueLayoutToken, directory = Boolean(page.data.directorySheet)
    const subject = directory ? page.data.directorySheet : page.data.currentIssue
    if (!token || !subject || page._viewActive === false) return
    const query = page.createSelectorQuery()
    query.select(directory ? '.directory-sheet' : '.review-editor-sheet').fields({ size: true, computedStyle: ['max-height'] })
    query.select(directory ? '.directory-list' : '.review-editor-body').fields({ size: true, computedStyle: ['max-height'] })
    query.select(directory ? '.directory-list-content' : '.review-editor-content').boundingClientRect()
    query.exec(function (rects) {
      if (page._issueLayoutToken !== token || (directory ? page.data.directorySheet : page.data.currentIssue) !== subject || page._viewActive === false) return
      const [sheet, body, content] = rects || []
      const maximum = sheet && parseFloat(sheet['max-height'])
      if (!sheet || !body || !content || !Number.isFinite(maximum)) return
      const bodyMaximum = parseFloat(body['max-height'])
      const height = Math.max(1, Math.floor(Math.min(content.height, maximum - (sheet.height - body.height),
        Number.isFinite(bodyMaximum) ? bodyMaximum : maximum)))
      const property = directory ? 'directoryBodyLayout' : 'issueBodyLayout', key = directory ? 'target' : 'issueId'
      const previous = page.data[property]
      if (previous && previous[key] === subject[key] && previous.height === height) return
      page.setData({ [property]: { [key]: subject[key], height } })
    })
  })
}

module.exports = { schedule }
