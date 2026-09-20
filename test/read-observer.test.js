const test = require('node:test')
const assert = require('node:assert/strict')
const observer = require('../miniprogram/services/read-observer')
test('读取观测白名单、不保留参数/金额/响应；关闭后无数据且有界', () => {
  observer.enable(true)
  for(let i=0;i<400;i++)observer.record('request',{action:'dashboard.get',ms:1,bytes:20,attempt:1,uid:'sensitive',amountMinor:'1234',response:{note:'secret'}})
  const output=observer.snapshot()
  assert.equal(output.length,300)
  assert.deepEqual(Object.keys(output[0]).sort(),['action','attempt','bytes','event','ms'])
  assert.equal(JSON.stringify(output).includes('secret'),false)
  observer.enable(false);observer.record('request',{action:'dashboard.get',ms:1});assert.deepEqual(observer.snapshot(),[])
})
test('setData 保持回调和 this；只测桥接回调，不冒充绘制完成', () => {
  observer.enable(true)
  let callback
  const page={route:'pages/index/index',setData(_patch,cb){callback=cb}}
  observer.attach(page)
  let called=false
  page.setData({message:'合成'},function(){assert.equal(this,page);called=true})
  assert.equal(called,false);callback();assert.equal(called,true)
  assert.equal(observer.snapshot()[0].event,'setData')
  assert.ok(observer.snapshot()[0].bytes>0)
  observer.enable(false)
})
