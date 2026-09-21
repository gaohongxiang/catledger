const palette = require('../../utils/category-palette')

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
    initial: '',
    icon: ''
  },
  observers: {
    'name, color': function (name, color) {
      this.setData({
        resolvedColor: color || palette.colorNameFor(name),
        initial: name ? name.slice(0, 1) : '',
        icon: palette.iconFor(name)
      })
    }
  },
  options: {
    multipleSlots: true
  }
})
