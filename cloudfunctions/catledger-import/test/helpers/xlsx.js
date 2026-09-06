const yazl = require('yazl')
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function columnName(index) {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  return result
}
function sheetXml(rows) {
  return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.map((values, i) =>
    `<row r="${i + 1}">` + values.map((value, j) => `<c r="${columnName(j)}${i + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('') + '</row>'
  ).join('') + '</sheetData></worksheet>'
}
function buildSyntheticXlsx(rows, extraSheets = []) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(), sheets = [rows, ...extraSheets]
    zip.addBuffer(Buffer.from('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((_, i) => `<sheet name="${i === 0 ? '账单' : `账单${i + 1}`}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'), 'xl/workbook.xml')
    zip.addBuffer(Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'), 'xl/_rels/workbook.xml.rels')
    sheets.forEach((sheet, i) => zip.addBuffer(Buffer.from(sheetXml(sheet)), `xl/worksheets/sheet${i + 1}.xml`))
    const chunks = []
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.once('error', reject)
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)))
    zip.end()
  })
}
module.exports = { buildSyntheticXlsx }
