const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { filesystem, packed } = require('./local-review')
const fileStore = require('../../miniprogram/packages/finance/services/import-local-files')
const factory = require('../../miniprogram/packages/finance/services/import-local-session')
const { runtime } = require('./paged-workbench')

// The Page, public import API, main-package router and draft manager are real.
// Only platform I/O is replaced; every attempted network call is counted.
async function localWorkbench(t, facts) {
  const lab = filesystem(); t.after(lab.cleanup)
  const wire = packed(facts), files = fileStore.create({ ...lab, scope:'test:1234567890',updateId:facts.update.updateId })
  await files.download(wire.header,wire.call)
  const network=[]
  const blocked = (...args) => { network.push(args);throw Object.assign(Error('Local review attempted network'),{code:'TEST_NETWORK_FORBIDDEN'}) }
  const session = factory.create({files,restored:files.restore(),requestId:randomUUID,callNetwork:blocked,
    saveReceipt(){},cleanup(){},queueAbandon(){}})
  const h=runtime({summary:session.view,events:facts.events,issues:facts.issues},{
    realImportApi:true,realLocalManager:true,realDraftManager:true,
    wx:{env:{USER_DATA_PATH:lab.root},getFileSystemManager:()=>lab.fs,
      cloud:{callFunction:blocked,uploadFile:blocked,downloadFile:blocked},request:blocked,uploadFile:blocked,downloadFile:blocked,connectSocket:blocked},
    beforePage(h,load){load(path.resolve(__dirname,'../../miniprogram/services/import-local-router.js')).bind(session)}
  })
  t.after(()=>h.page.onUnload())
  return {...h,local:session,network,files,lab}
}
module.exports={localWorkbench}
