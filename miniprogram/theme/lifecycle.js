function invoke(handler, instance, args) {
  return typeof handler === 'function' ? handler.apply(instance, args) : undefined
}

// 显式适配原生生命周期，不替换全局 Page/Component，也不代理业务 setData。
function page(definition, controller) {
  return Object.assign({}, definition, {
    // clone 保持调用方的业务初值纯净，后续业务 reset 不会重新写入主题快照。
    data: Object.assign({}, JSON.parse(JSON.stringify(definition.data || {})), controller.initialData()),
    onLoad: function () {
      controller.attach(this)
      controller.activate(this)
      return invoke(definition.onLoad, this, arguments)
    },
    onShow: function () {
      controller.attach(this)
      controller.activate(this)
      return invoke(definition.onShow, this, arguments)
    },
    onHide: function () {
      controller.hide(this)
      return invoke(definition.onHide, this, arguments)
    },
    onUnload: function () {
      controller.detach(this)
      return invoke(definition.onUnload, this, arguments)
    }
  })
}

function component(definition, controller) {
  const lifetimes = definition.lifetimes || {}
  const attached = lifetimes.attached || definition.attached
  const detached = lifetimes.detached || definition.detached
  return Object.assign({}, definition, {
    data: Object.assign({}, JSON.parse(JSON.stringify(definition.data || {})), controller.initialData()),
    lifetimes: Object.assign({}, lifetimes, {
      attached: function () {
        controller.attach(this)
        return invoke(attached, this, arguments)
      },
      detached: function () {
        controller.detach(this)
        return invoke(detached, this, arguments)
      }
    })
  })
}

module.exports = { page, component }
