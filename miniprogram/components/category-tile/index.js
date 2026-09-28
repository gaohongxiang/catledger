const palette = require('../../utils/category-palette')

Component({
  properties: {
    systemKey: { type: String, value: '' },
    iconKind: { type: String, value: '' },
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
    'name, color, systemKey, iconKind': function (name, color, systemKey, iconKind) {
      this.setData({
        resolvedColor: color || palette.colorNameFor(name, systemKey, iconKind),
        initial: name ? name.slice(0, 1) : '',
        icon: palette.iconFor(name, systemKey, iconKind)
      })
    }
  }
})
