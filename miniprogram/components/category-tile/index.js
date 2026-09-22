const palette = require('../../utils/category-palette')

Component({
  properties: {
    systemKey: { type: String, value: '' },
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
    initial: '',
    icon: ''
  },
  observers: {
    'name, color, systemKey': function (name, color, systemKey) {
      this.setData({
        resolvedColor: color || palette.colorNameFor(name, systemKey),
        initial: name ? name.slice(0, 1) : '',
        icon: palette.iconFor(name, systemKey)
      })
    }
  }
})
