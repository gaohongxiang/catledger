const COLOR_BY_NAME = {
  '餐饮': 'orange',
  '交通': 'blue',
  '购物': 'purple',
  '住房': 'teal',
  '医疗': 'red',
  '教育': 'yellow',
  '娱乐': 'green'
}

Component({
  properties: {
    name: {
      type: String,
      value: ''
    },
    color: {
      type: String,
      value: ''
    },
    size: {
      type: String,
      value: 'normal'
    },
    hideName: {
      type: Boolean,
      value: false
    }
  },
  data: {
    resolvedColor: 'grey',
    initial: ''
  },
  observers: {
    'name, color': function (name, color) {
      this.setData({
        resolvedColor: color || COLOR_BY_NAME[name] || 'grey',
        initial: name ? name.slice(0, 1) : ''
      })
    }
  },
  options: {
    multipleSlots: true
  }
})
