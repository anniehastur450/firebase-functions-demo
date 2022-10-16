
const fs = require('fs');
const printf = require('printf');

var i18nContent = null;

function getI18nContent() {
    if (i18nContent == null) {
        i18nContent = JSON.parse(fs.readFileSync('i18n.json', 'utf-8'));
    }
    return i18nContent;
}

exports.translate = function(lang) {
    return function(tag, ...arg) {
        var key = `${tag}.${lang}`;
        var o = getI18nContent();
        if (o.hasOwnProperty(key)) {
            var val = o[key];
            return arg.length == 0 ? val : printf(val, ...arg);
        }
        return key;
    }
}
