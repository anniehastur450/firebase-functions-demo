
const printf = require('printf');

var i18nContent = require('./i18n.json');

exports.get = function(key) {
    return i18nContent[key];
}

exports.translate = function(lang) {
    var funcObj = function(tag, ...arg) {
        var key = `${tag}.${funcObj.lang}`;
        if (i18nContent.hasOwnProperty(key)) {
            var val = i18nContent[key];
            return arg.length == 0 ? val : printf(val, ...arg);
        }
        return key;
    }
    funcObj.lang = lang;
    funcObj.get = exports.get;
    return funcObj;
}
