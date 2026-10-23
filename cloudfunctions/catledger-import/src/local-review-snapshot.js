// Snapshot-only wire format. Tables omit repeated column names and immutable
// nested facts share dictionary entries. Decoding preserves all values; there
// is no lossy truncation of source evidence or domain fields.
const FORMAT = 'catledger-review-facts-v1'
const TABLES = ['events','rows','raw','evidence','members','relations','links','accounts','accountDrafts','categories','loans','contracts','charges','actions','history','historyGroups','refundCandidates','paymentMappings','issues']
function* textParts(nodes, root) {
  yield '{"format":'+JSON.stringify(FORMAT)+',"nodes":['
  for(let index=0;index<nodes.length;index++) {
    yield (index?',':'')+nodes[index]
    nodes[index]=null
  }
  yield '],"root":'+JSON.stringify(root)+'}'
}
function encode(facts, { consume = false, text = false, parts = false } = {}) {
  const nodes=[], byValue=new Map(), strings=new Map()
  function record(encoded, deduplicate = true) {
    const key=deduplicate?JSON.stringify(encoded):null
    let id=key===null?undefined:byValue.get(key)
    if(id===undefined){id=nodes.length;nodes.push(text?(key===null?JSON.stringify(encoded):key):encoded);if(key!==null)byValue.set(key,id)}
    return[id]
  }
  function node(value) {
    if(value===undefined)return []
    if(typeof value==='string'&&value.length>=6){let id=strings.get(value);if(id===undefined){id=nodes.length;nodes.push(text?JSON.stringify([2,value]):[2,value]);strings.set(value,id)}return[id]}
    if(value===null||typeof value!=='object')return value
    const encoded=Array.isArray(value)?[0,value.map(node)]:[1,Object.entries(value).filter(([,item])=>item!==undefined).map(([key,item])=>[key,node(item)])]
    return record(encoded)
  }
  const tables=[]
  for(const name of TABLES){
    const values=facts[name]||[],keys=new Set()
    for(const row of values)for(const key of Object.keys(row))keys.add(key)
    const columns=[...keys].sort(),encodedRows=[]
    for(let index=0;index<values.length;index++){
      encodedRows.push(record([0,columns.map(column=>node(values[index][column]))],false))
      // Server snapshot facts belong only to this capture. Release each source
      // row as it is encoded instead of retaining facts + table copies + wire.
      // Default callers keep their original immutable fixtures unchanged.
      if(consume)values[index]=null
    }
    tables.push([name,record([1,[['columns',node(columns)],['values',record([0,encodedRows],false)]]],false)])
    if(consume)facts[name]=null
  }
  // Table-only dictionary lookup indexes are no longer needed while encoding
  // metadata. References already written into nodes remain valid.
  if(text){byValue.clear();strings.clear()}
  const metadata=node(Object.fromEntries(Object.entries(facts).filter(([key])=>!TABLES.includes(key))))
  if(consume)for(const key of Object.keys(facts))delete facts[key]
  const root=record([1,[['metadata',metadata],['tables',record([1,tables],false)]]],false)
  byValue.clear();strings.clear()
  // The server can retain serialized dictionary entries instead of a second
  // object graph. Each entry has already passed JSON serialization once.
  if(!text)return{format:FORMAT,nodes,root}
  const serialized=textParts(nodes,root)
  return parts?serialized:[...serialized].join('')
}
function encodeText(facts,options={}){return encode(facts,{...options,text:true})}
function encodeTextParts(facts,options={}){return encode(facts,{...options,text:true,parts:true})}
function incomplete(){throw Object.assign(new Error('草稿编码不完整'),{code:'SNAPSHOT_INCOMPLETE',publicCode:'SNAPSHOT_INCOMPLETE'})}
function decoder() {
  const nodes=[]
  function value(item){if(!Array.isArray(item))return item
    if(item.length===0)return undefined
    if(item.length!==1||!Number.isSafeInteger(item[0])||item[0]<0||item[0]>=nodes.length)incomplete()
    return nodes[item[0]]
  }
  function push(entry){
    if(nodes.length>=1500000||!Array.isArray(entry)||entry.length!==2||![0,1,2].includes(entry[0])||(entry[0]===2?typeof entry[1]!=='string':!Array.isArray(entry[1])))incomplete()
    if(entry[0]===1&&entry[1].some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'))incomplete()
    nodes.push(entry[0]===2?entry[1]:entry[0]===0?entry[1].map(value):Object.fromEntries(entry[1].map(([key,item])=>[key,value(item)])))
  }
  function finish(reference){
    const root=value(reference)
    if(!root||!root.metadata||!root.tables)incomplete()
    const facts={...root.metadata}
    // The root now owns every reachable fact. Drop dictionary-only references
    // before replacing row arrays with objects, keeping only one table copy.
    nodes.length=0
    for(const name of TABLES){const table=root.tables[name];if(!table||!Array.isArray(table.columns)||!Array.isArray(table.values))incomplete()
      for(let index=0;index<table.values.length;index++){
        const row=table.values[index]
        if(!Array.isArray(row)||row.length!==table.columns.length)incomplete()
        table.values[index]=Object.fromEntries(table.columns.map((column,position)=>[column,row[position]]).filter(([,item])=>item!==undefined))
      }
      facts[name]=table.values;delete root.tables[name]
    }
    return facts
  }
  return {push,finish}
}
function decode(wire) {
  if(!wire||wire.format!==FORMAT||!Array.isArray(wire.nodes)||wire.nodes.length>1500000)incomplete()
  const reader=decoder()
  for(let index=0;index<wire.nodes.length;index++){reader.push(wire.nodes[index]);wire.nodes[index]=null}
  return reader.finish(wire.root)
}
// Read the canonical envelope emitted by encode/encodeText one dictionary entry
// at a time. JSON.parse still validates each entry, but never allocates an
// additional graph for the complete snapshot. Chunks can come directly from
// verified local files or immutable database rows and are released as consumed.
function decodeParts(parts) {
  const iterator=parts[Symbol.iterator](),reader=decoder()
  let chunk='',position=0,ended=false
  function available(){
    while(position===chunk.length&&!ended){const next=iterator.next();ended=next.done;if(!ended){if(typeof next.value!=='string')incomplete();chunk=next.value;position=0}}
    return !ended
  }
  function expect(text){for(let index=0;index<text.length;index++){if(!available()||chunk[position++]!==text[index])incomplete()}}
  function array(){
    if(!available()||chunk[position]!=='[')incomplete()
    let depth=0,quoted=false,escaped=false
    const pieces=[]
    while(available()){
      const start=position
      while(position<chunk.length){
        const char=chunk[position++]
        if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false}
        else if(char==='"')quoted=true
        else if(char==='['||char==='{')depth++
        else if(char===']'||char==='}')depth--
        if(depth===0){pieces.push(chunk.slice(start,position));try{return JSON.parse(pieces.join(''))}catch(_){incomplete()}}
      }
      pieces.push(chunk.slice(start,position))
    }
    incomplete()
  }
  expect('{"format":'+JSON.stringify(FORMAT)+',"nodes":[')
  if(!available())incomplete()
  if(chunk[position]!==']'){
    while(true){reader.push(array());if(!available())incomplete();if(chunk[position]===']')break;expect(',')}
  }
  expect('],"root":');const root=array();expect('}')
  if(available())incomplete()
  chunk=''
  return reader.finish(root)
}
// 表计数只统计行集合。refundCandidates 现在带覆盖标记，是 { items, covered, ... }，
// 若仍按数组取 length 会在准备快照时直接抛错，导致整批整理失败。
function tableRows(facts, key) {
  const value = facts[key]
  if (key === 'refundCandidates' && value && !Array.isArray(value)) return value.items || []
  return value || []
}
function counts(facts) { return Object.fromEntries(['sources',...TABLES].map(key=>[key,tableRows(facts,key).length])) }
function validateFacts(facts,header) {
  const expected=header.counts||header.metadata?.counts
  if(facts.protocolVersion!==header.protocolVersion||facts.ruleVersion!==header.ruleVersion||facts.snapshotId!==header.objectId||
    facts.update.updateId!==header.updateId||facts.update.version!==header.baseVersion||!expected||
    Object.entries(counts(facts)).some(([key,value])=>expected[key]!==value))
    throw Object.assign(new Error('完整草稿的身份、版本或记录数量不一致'),{code:'SNAPSHOT_INCOMPLETE',publicCode:'SNAPSHOT_INCOMPLETE'})
  return facts
}
module.exports={FORMAT,encode,encodeText,encodeTextParts,decode,decodeParts,counts,validateFacts}
