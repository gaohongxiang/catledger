// 仅由本机合成基准调用。SQL/绑定值留在内存；输出只含访问路径和估算行数。
async function inspectSelect(pool, operation) {
  const queries = []
  await operation({ async execute(sql, values) { queries.push({ sql, values }); return [[]] } })
  const connection = await pool.getConnection()
  const plans = []
  try {
    for (const { sql, values } of queries) {
      if (!/^\s*SELECT\b/.test(sql)) throw new Error('explain expects read query')
      const [rows] = await connection.execute('EXPLAIN FORMAT=JSON ' + sql, values)
      const tables = []
      function visit(node) {
        if (!node || typeof node !== 'object') return
        if (node.table_name) tables.push({ table: node.table_name, access: node.access_type, key: node.key,
          keyParts: node.used_key_parts, rowsPerScan: node.rows_examined_per_scan, rowsProduced: node.rows_produced_per_join })
        for (const value of Object.values(node)) visit(value)
      }
      visit(JSON.parse(rows[0].EXPLAIN)); plans.push(tables)
    }
    return plans
  } finally { connection.release() }
}
module.exports = { inspectSelect }
