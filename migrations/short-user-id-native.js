const { randomInt } = require('node:crypto')

const quote = value => '`' + String(value).replaceAll('`', '``') + '`'
const short = value => /^[1-9][0-9]{9}$/.test(value)
const legacy = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)

// 0011 的原生连接适配器：保留同一事务与验证，逐段更新降低单条语句内存，仍整体提交。
async function migrateShortUserIds(connection, { generateUid = () => String(randomInt(1000000000, 10000000000)), fixedMappings = null, commitChunks = false, afterBatch = null } = {}) {
  if (commitChunks && !Array.isArray(fixedMappings)) throw new Error('UID maintenance requires a durable mapping')
  let locked = false, started = false, stage = 'initial_state', failure = null
  const [[state]] = await connection.query('SELECT @@SESSION.foreign_key_checks AS foreignKeys, @@SESSION.autocommit AS autocommit')
  if (Number(state.foreignKeys) !== 1 || Number(state.autocommit) !== 1) throw new Error('UID migration requires a clean autocommit connection')
  try {
    stage = 'native_step_13'
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', ['catledger:schema-migrations'])
    if (Number(lock.acquired) !== 1) throw new Error('UID migration lock unavailable')
    locked = true
    stage = 'native_step_16'
    const [columns] = await connection.query(`SELECT table_name AS tableName,column_name AS columnName,
      data_type AS dataType,character_maximum_length AS capacity,extra AS extra
      FROM information_schema.columns WHERE table_schema=DATABASE() AND LEFT(table_name,10)='catledger_' ORDER BY table_name,ordinal_position`)
    const [engines] = await connection.query(`SELECT table_name AS tableName,engine AS engine,table_type AS tableType
      FROM information_schema.tables WHERE table_schema=DATABASE() AND LEFT(table_name,10)='catledger_'`)
    const tables = columns.filter(row => row.columnName === 'uid').map(row => ({ ...row, ...engines.find(table => table.tableName === row.tableName) }))
    if (tables.length !== 29 || tables.some(row => row.dataType !== 'char' || Number(row.capacity) !== 36 || row.engine !== 'InnoDB' || row.tableType !== 'BASE TABLE')) throw new Error('UID migration requires the complete 0010 schema')
    stage = 'native_step_24'
    const [[triggers]] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.triggers WHERE event_object_schema=DATABASE() AND LEFT(event_object_table,10)='catledger_'")
    if (Number(triggers.count)) throw new Error('UID migration requires review of existing triggers')
    stage = 'native_step_26'
    const [keys] = await connection.query(`SELECT table_name AS tableName,constraint_name AS constraintName,
      column_name AS columnName,referenced_table_schema AS parentSchema,referenced_table_name AS parentTable,
      referenced_column_name AS parentColumn FROM information_schema.key_column_usage
      WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL
      AND (LEFT(table_name,10)='catledger_' OR (referenced_table_schema=DATABASE() AND LEFT(referenced_table_name,10)='catledger_'))
      ORDER BY table_name,constraint_name,ordinal_position`)
    const groups = new Map()
    for (const key of keys) {
      const name = key.tableName + ':' + key.constraintName
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push(key)
    }
    if (!groups.size) throw new Error('UID migration found no foreign keys to validate')
    stage = 'native_step_39'
    await connection.query('CREATE TEMPORARY TABLE catledger_uid_migration_map (old_uid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,new_uid CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE) ENGINE=InnoDB')
    stage = 'native_step_40'
    await connection.beginTransaction()
    started = true
    stage = 'native_step_42'
    await connection.query('UPDATE catledger_user_identities SET uid=uid')
    stage = 'native_step_43'
    await connection.query('UPDATE catledger_users SET uid=uid,updated_at=updated_at')
    stage = 'native_step_44'
    const [users] = await connection.query('SELECT uid FROM catledger_users ORDER BY uid')
    const used = new Set(users.filter(row => short(row.uid)).map(row => row.uid))
    if (fixedMappings) {
      if (new Set(fixedMappings.map(row => row.oldUid)).size !== fixedMappings.length || new Set(fixedMappings.map(row => row.newUid)).size !== fixedMappings.length || fixedMappings.some(row => !legacy(row.oldUid) || !short(row.newUid))) throw new Error('UID maintenance mapping invalid')
      if (users.some(user => !short(user.uid) && !fixedMappings.some(row => row.oldUid === user.uid))) throw new Error('UID maintenance mapping incomplete')
    }
    let changedUsers = 0, changedRows = 0
    const mappings = []
    const sourceUsers = fixedMappings ? fixedMappings.map(row => ({ uid: row.oldUid })) : users
    for (const user of sourceUsers) {
      let next = user.uid
      if (fixedMappings) {
        next = fixedMappings.find(row => row.oldUid === user.uid).newUid
        changedUsers += 1
      } else if (!short(next)) {
        if (!legacy(next)) throw new Error('UID migration found an unexpected legacy UID format')
        let found = false
        for (let attempt = 0; attempt < 32; attempt += 1) {
          next = generateUid()
          if (!short(next)) throw new Error('UID migration generated an invalid ID')
          if (!used.has(next)) { found = true; break }
        }
        if (!found) throw new Error('UID allocation collision limit exceeded')
        used.add(next)
        changedUsers += 1
      }
      stage = 'native_step_61'
      await connection.execute('INSERT INTO catledger_uid_migration_map(old_uid,new_uid) VALUES(?,?)', [user.uid,next])
      if (user.uid !== next) mappings.push({ oldUid: user.uid, newUid: next })
    }
    stage = 'native_step_63'
    await connection.query('SET SESSION foreign_key_checks=0')
    for (const table of tables) {
      const name = quote(table.tableName)
      stage = 'count_' + table.tableName
      const expected = { count: 0 }
      for (const mapping of mappings) {
        const [[count]] = await connection.execute('SELECT COUNT(*) AS count FROM '+name+' WHERE uid=?', [mapping.oldUid])
        expected.count += Number(count.count)
      }
      const timestamps = columns.filter(row => row.tableName === table.tableName && /on update/i.test(row.extra))
        .map(row => ',t.'+quote(row.columnName)+'=t.'+quote(row.columnName)).join('')
      stage = 'update_' + table.tableName
      const batchSize = table.tableName === 'catledger_mutation_receipts' ? 1 : 128
      let affected = 0
      for (const mapping of mappings) {
        let changed
        do {
          const [updated] = await connection.execute('UPDATE '+name+' SET uid=?'+timestamps.replaceAll('t.', '')+' WHERE uid=? LIMIT '+batchSize, [mapping.newUid,mapping.oldUid])
          changed = Number(updated.affectedRows)
          affected += changed
          if (commitChunks) {
            await connection.commit()
            started = false
            if (afterBatch) await afterBatch()
            await connection.beginTransaction()
            started = true
          }
        } while (changed === batchSize)
      }
      if (affected !== Number(expected.count)) throw new Error('UID migration row coverage mismatch')
      changedRows += Number(expected.count)
      stage = 'native_step_72'
      const [[invalid]] = await connection.query('SELECT COUNT(*) AS count FROM '+name+" WHERE uid NOT REGEXP '^[1-9][0-9]{9}$'")
      if (Number(invalid.count)) throw new Error('UID migration found unmapped ownership')
    }
    for (const group of groups.values()) {
      const first = group[0]
      const join = group.map(key => 'c.'+quote(key.columnName)+'=p.'+quote(key.parentColumn)).join(' AND ')
      const notNull = group.map(key => 'c.'+quote(key.columnName)+' IS NOT NULL').join(' AND ')
      stage = 'native_step_79'
      const [[invalid]] = await connection.query('SELECT COUNT(*) AS count FROM '+quote(first.tableName)+' c LEFT JOIN '+quote(first.parentSchema)+'.'+quote(first.parentTable)+' p ON '+join+' WHERE '+notNull+' AND p.'+quote(first.parentColumn)+' IS NULL')
      if (Number(invalid.count)) throw new Error('UID migration foreign key validation failed')
    }
    stage = 'native_step_82'
    await connection.query('SET SESSION foreign_key_checks=1').catch(error => { if (!failure) throw error })
    stage = 'native_step_83'
    await connection.commit()
    started = false
    return { users_total: users.length, users_migrated: changedUsers, ownership_rows_updated: changedRows, tables_verified: tables.length, foreign_keys_verified: groups.size }
  } catch (error) {
    failure = error
    error.migrationStage = stage
    if (started) await connection.rollback().catch(() => {})
    throw error
  } finally {
    stage = 'native_step_90'
    await connection.query('SET SESSION foreign_key_checks=1').catch(error => { if (!failure) throw error })
    stage = 'native_step_91'
    await connection.query('DROP TEMPORARY TABLE IF EXISTS catledger_uid_migration_map').catch(error => { if (!failure) throw error })
    if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', ['catledger:schema-migrations']).catch(error => { if (!failure) throw error })
  }
}

module.exports = { migrateShortUserIds }
