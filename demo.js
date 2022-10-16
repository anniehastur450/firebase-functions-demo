
const i18n = require('./i18n');

var __;

__ = i18n.translate('zh')

console.log(__('areyouok'))
console.log(__('hellomsg'))
console.log(__('hellomsg', 'customer'))

__ = i18n.translate('en')

console.log(__('areyouok'))
console.log(__('hellomsg'))
console.log(__('hellomsg', 'customer'))

const printf = require('printf')

console.log(printf('%2$s %1$s', 'a', 'b'))
