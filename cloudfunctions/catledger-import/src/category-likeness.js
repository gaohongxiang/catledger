// 分类上算不算同一笔，只看收支性质、来源、对方和商品。
// 商品和对方原文里的发生日期、时刻先去掉；金额、账户、入账日期不参与。
// 两边去掉之后都没有文字，就无从判断是同一笔，不合并。原文不改。

function stripOccurrenceMarks(value) {
  return String(value || '').normalize('NFKC')
    .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/(^|[^\d])((?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?=$|[^\d])/g, '$1 ')
}

function categoryGoodsText(value) {
  return stripOccurrenceMarks(value).trim().toLowerCase().replace(/[\s\-—]+/g, '')
}

function categoryGoodsLabel(value) {
  return stripOccurrenceMarks(value)
    .replace(/\s*[-—]+\s*/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-—\s]+|[-—\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80)
}

function categoryLikenessKey(event) {
  if (!event) return ''
  const evidence = event.primaryEvidence || {}
  const merchant = categoryGoodsText(event.counterparty || evidence.counterparty)
  const item = categoryGoodsText(evidence.item)
  if (!merchant && !item) return ''
  return [event.economicNature || '', evidence.sourceType || '', merchant, item].join('\u001f')
}

module.exports = { categoryGoodsText, categoryGoodsLabel, categoryLikenessKey }
