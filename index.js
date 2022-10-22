
/* for locals, create a .runtimeconfig.json file for functions.config() to read,
with the following json format

{
    "secrets": {
        "lineClientConfig": {
            "channelAccessToken": {{ YOUR TOKEN }},
            "channelSecret": {{ YOUR SECRET }}
        }
    }
}

*/

const path = require('path');
const fs = require('fs');
const printf = require('printf');

////////////////// FIREBASE /////////////////////
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const region = 'asia-east1';
const spec = { memory: "1GB" };
admin.initializeApp();  // no need functions.config().firebase
const db = admin.firestore();
const bucket = admin.storage().bucket();
const project = process.env.GCLOUD_PROJECT;

////////////////// LINE /////////////////////
const line = require("@line/bot-sdk");
const client = new line.Client(functions.config().secrets.lineClientConfig);

////////////////// I18N /////////////////////
const i18n = require('./i18n');

////////////////// FLEX MESSAGE /////////////////////
const flexs = require('./flex-message');

////////////////// GLOBAL VARIABLES /////////////////////
var protocol = null;  // should be https
var host = null;      // the domain name

// quickReply has 1 extra attribute => "quickReply"
// https://developers.line.biz/en/docs/messaging-api/using-quick-reply/#set-quick-reply-buttons

exports.publicizeLocalFile = functions.region(region).runWith(spec).https.onRequest((request, response) => {
    console.log('request.query', request.query)
    console.log('req host', request.get('host'))
    console.log('req origin', request.get('origin'))

    var filename = request.query.file;
    if (!filename) {
        response.sendStatus(404)
        return
    }
    response.setHeader('Content-Type', 'audio/mp4');

    (async () => {
        var file = bucket.file(filename)
        var [buffer] = await file.download()
        response.send(buffer)
    })().catch(err => {
        console.error(err);
        response.sendStatus(404)
    })
})

/* datetime related */
// see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse
class DateUtility {
    static suffix(timezone) {  // timezone in hours
        if (!timezone) return 'Z';
        var sign = '-+'[+(timezone > 0)];
        var totalmin = Math.abs(timezone) * 60;
        var hr = Math.floor(totalmin / 60);
        return sign + printf('%02d:%02d', hr, totalmin % 60);
    }
    static toDatetimeString(timestamp, timezone) {
        var s = new Date(timestamp + timezone * 3600 * 1000).toISOString();
        return s.slice(0, -1) + this.suffix(timezone);
    }
    static parseDatetime(datetime, timezone) {
        /* datetime format look like 2017-12-25T01:00 */
        var ret = Date.parse(datetime + this.suffix(timezone));
        if (isNaN(ret)) {
            console.warn(`unexpected NaN: ${datetime + this.suffix(timezone)}`);
        }
        return ret;
    }
}

/* storage related */
async function uploadStreamFile(stream, filename, customMetadata) {
    var file = bucket.file(filename);
    var writeStream = file.createWriteStream({
        contentType: 'auto',
        metadata: {
            metadata: customMetadata
        }
    });

    // see https://googleapis.dev/nodejs/storage/latest/File.html#createWriteStream
    await new Promise((resolve, reject) => {
        console.log(`uploading ${filename}...`);
        stream.pipe(writeStream)
            .on('error', reject)
            .on('finish', resolve);
    });

    console.log(`done uploading ${filename}.`);
}

////////////////// CODE START /////////////////////

function unexpected(errorMessage) {
    throw new Error(errorMessage);
}

function firstLetterCaptialize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/* {} returns true, and [] returns false */
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

function applyDefault(sourceData, defaultData) {
    /* ref: https://stackoverflow.com/questions/27936772/how-to-deep-merge-instead-of-shallow-merge */

    /*  assign default to source when:
            source[key] not exist,
            default[key] is object but source[key] is not

        merge when:
            source[key] and default[key] is object

        other existing keys in source is ignored
    */

    for (const key in defaultData) {
        if (key in sourceData) {
            if (isObject(defaultData[key])) {
                if (isObject(sourceData[key])) {
                    applyDefault(sourceData[key], defaultData[key]);
                } else {
                    sourceData[key] = defaultData[key];
                }
            }
        } else {
            sourceData[key] = defaultData[key];
        }
    }

    return sourceData;
}

////////////////// CLASSES FOR DATA IN FIRESTORE /////////////////////

/* user doc data object structure (to store lang, states, etc) */

class TopLevelData {
    static default() {
        return {
            lang: null,   // or 'en', 'zh', null mean unset
            alarmCounter: 0,   // monotonic counter for alarm id
            timezone: 8,  // only support utc+8 for now, user selected time will minus this
            holder: null, // or 'alarm-setter', state holder
            /*
            subData look like this
            {
                'alarm-setter': {...},
                'alarm-watcher': {...},
                'lang-selector': {...},
                ... etc
            }

            */
            subData: {},  // (holder specific data)
        };
    }
}

/*
alarm-setter data

    {
        audio: null or filename
        alarmTime: null or timestamp (utc)
        state: 'sentAudio', 'sentTime'
    }

*/

/* Quick replies */

class DatetimePicker {
    constructor(data, label, options = {}) {
        this.data = data;    // line will reject empty string
        this.label = label
        this.mode = 'datetime';
        this.options = options;
    }

    toLINEObject() {  // return Action object
        return {
            type: 'datetimepicker',
            data: this.data,
            label: this.label,
            mode: this.mode,
            ...this.options
        };
    }

}

class PostbackAction {
    constructor(data, label, options = {}) {
        this.data = data;    // line will reject empty string
        this.label = label
        this.displayText = label;
        this.options = options;
    }

    toLINEObject() {  // return Action object
        return {
            type: 'postback',
            data: this.data,
            label: this.label,
            displayText: this.displayText,
            ...this.options
        };
    }

}

/* CHATBOT replies */
class TextMessage {
    constructor(text) {
        this.text = text;
    }

    toLINEObject() {  // return Message object
        return {
            type: 'text',
            text: this.text,
        };
    }

}

class AudioMessage {
    constructor(url, duration) {
        this.url = url;
        this.duration = duration;
    }

    toLINEObject() {
        return {
            type: "audio",
            originalContentUrl: this.url,
            duration: this.duration
        }
    }
}

class FlexMessage {
    constructor(flex, altText = 'this is a flex message') {
        this.flex = flex;
        this.altText = altText;
    }

    toLINEObject() {  // return Message object
        return {
            type: 'flex',
            altText: this.altText,
            contents: this.flex,
        };
    }

}

class ImageCarousel {
    constructor(flexArr, altText = 'your alarms') {
        console.log("imagecouresel flexArr:", flexArr)
        this.flexArr = flexArr;
        this.altText = altText;
        var flexObjs = []
        for (const flex of this.flexArr) {
            console.log("imagecouresel flex:", flex)
            flexObjs.push(flex)
        }
        this.flexObjs = flexObjs
        console.log("this.flexObjs:\n", this.flexObjs)
    }

    toLINEObject() { // return Message object
        return {
            "type": "carousel",
            "contents": this.flexObjs
        }
    }
}

////////////////// CHATBOT /////////////////////

function createChatBot(name, belongTo) {
    if (!chatbotsLookup.hasOwnProperty(name)) {
        console.warn(`chatbot ${name} not exists, set name to null`);
        name = null;
    }
    return new chatbotsLookup[name](belongTo);
}

/*
const chatbotsLookup is generated at runtime, which will look like this:
{
    'null': ChatBot,
    'alarm-setter': AlarmSetter,
    'lang-selector': LangSelector,
}

*/
const chatbotsLookup = {};
function register(name, theClass) {
    if (chatbotsLookup.hasOwnProperty(name)) {
        console.error(`name ${name} already exist`)
        throwRegisterFailure(theClass);
    }
    chatbotsLookup[name] = theClass;
    return name;
}
function throwRegisterFailure(theClass) {
    unexpected(`${theClass.name}.NAME should be declared as follows\n`
        + `    static NAME = ${register.name}('{{THE_BOT_NAME}}', this);`);
}

const langs = i18n.get('langs');

class BaseDbUserChatBot {
    /**
     * @param {DbUser} belongTo
     */
    constructor(belongTo) {
        this.belongTo = belongTo;
        if (!this.constructor.hasOwnProperty('NAME')) {
            throwRegisterFailure(this.constructor);
        }
    }

    get name() {
        return this.constructor.NAME;
    }

    get topLevelData() {
        return this.belongTo.dbData;
    }

    get subData() {
        let ret = this.topLevelData.subData[this.name];
        return ret ? ret : (this.topLevelData.subData[this.name] = {});
    }

    set subData(val) {
        this.topLevelData.subData[this.name] = val;
    }

    get translator() {
        return this.belongTo.translator;
    }

    get #replies() {
        return this.belongTo.replies;
    }

    get #quickReplies() {
        return this.belongTo.quickReplies;
    }

    get audio_filepathname() {
        // olny place where filepathname created
        return this.topLevelData.holderData.audio;
    }

    get watchOrder() {
        return this.topLevelData.watchOrder
    }

    get db() {
        return this.belongTo.db.collection('alarms');
    }
    async DBAlarmData() {
        // audio,duration,url, alarmTime, version, timerString
        return (await this.db.doc(this.alarmIdString).get()).data();
    }
    // async DBAlarmData(alarmIdString) {
    //     // audio,duration,url, alarmTime, version, timerString
    //     return (await this.db.doc(alarmIdString).get()).data();
    // }
    get alarmIdString() {
        return printf("%02d", this.topLevelData.alarmId);
    }
    async alarmUrl() {
        console.log("super class super async getters")
        return (await this.DBAlarmData()).url;
    }
    async alarmTime() {
        console.log("super class super async getters")
        return (await this.DBAlarmData()).alarmTime;
    }
    async alarmDuration() {
        console.log("super class super async getters")
        return (await this.DBAlarmData()).duration;
    }
    async alarmTimerString(key) {
        console.log("super class super async getters")
        if (key == 'long') {
            return (await this.DBAlarmData()).timerString;
        } else if (key == 'ui') {
            return (await this.DBAlarmData()).timerString.substring(5, 16).replace('T', '  ')
        }
        return (await this.DBAlarmData()).timerString.substring(0, 16).replace('T', ' ');
    }

    replyUntilAlarm(alarmId) {
        // const __ = this.translator;
        // const data = (await this.db.doc(printf("%02d", alarmId)).get()).data()
        // const timerString = data.timerString.substring(5, 16).replace('T', '  ')
        // const untilAlarm = Number.parseInt(Date.now()) - Number.parseInt(timerString)
        // console.log(Date.now(), timerString, Number.parseInt(Date.now()), Number.parseInt(timerString))
        // const d = new Date(untilAlarm)
        // this.replyText(__('reply.alarmScheduled', this.alarmId, timerString, d.getUTCDay() - 4, d.getUTCHours(), d.getUTCMinutes())); // reply.alarmScheduled //NOT SURE WHY IT'S MINUS 4
        this.replyText(`TODO replyUntilAlarm(${alarmId})`);
    }
    ////////////////// CHATBOT TRANSFORMER /////////////////////

    abort() {  // go to default chatbot
        if (`${this.name}` == 'null') {
            /* you cannot call abort on default chatbot */
            unexpected(`You cannot call abort() on ${this.constructor.name}!`)
        }
        this.onAbort();
        return this.belongTo.setHolder(null, this.onAbort());
    }

    ////////////////// CHATBOT REPLIES /////////////////////

    addQuickReply(...actions) {
        for (let action of actions) {
            if (action.toLINEObject) {
                action = action.toLINEObject();
            }
            this.#quickReplies.push({
                type: 'action',
                action: action
            })
        }
    }

    addQuickReplyText(label, text = label) {
        this.addQuickReply({
            type: 'message',
            label: label,
            text: text
        });
    }

    reply(...messages) {
        this.#replies.push(...messages);
    }

    replyText(...texts) {
        for (const text of texts) {
            this.#replies.push(new TextMessage(text));
        }
    }

    replyAudio(...audio_objs) {
        /**
         * @params {audio_objs} array of {url: x, duration: y} objects
         */
        for (const obj of audio_objs) {
            const url = obj['url'];
            const duration = obj['duration'];
            this.#replies.push(new AudioMessage(url, duration));
        }
    }

    replyAlarmWatcher() {
        return this.belongTo.setHolder('alarm-watcher').reactPostbackAsync();
    }

    ////////////////// EMPTY CHATBOT REACTS /////////////////////

    onAbort() {  // subclass override this to handle onAbort
        /* return set holder clear true or false, default clear = true */
        return true;
    }

    async reactTextAsync(text, tag) {
        return this.abort().reactTextAsync(...arguments);
    }

    async reactAudioAsync(filename) {
        return this.abort().reactAudioAsync(...arguments);
    }

    async reactPostbackAsync(data, params) {
        return this.abort().reactPostbackAsync(...arguments);
    }

}

class DefaultChatBot extends BaseDbUserChatBot {  /* take the db save/store logic out of reply logic */

    static NAME = register(null, this);

    ////////////////// CHATBOT REACTS /////////////////////

    async reactTextAsync(text, tag) { /* user text, and corresponding tag */
        const __ = this.translator;

        if (text == 'lang') {
            return this.belongTo.setHolder('lang-selector').changeLang();
        }
        if (!tag) {
            console.warn(`unhandled tag ${tag}, ${text}`);
        }
        return this.replyText(__('reply.hellomsg', text));
    }

    async reactAudioAsync(filename) {
        const __ = this.translator;

        return this.belongTo.setHolder('alarm-setter').setAudio(filename);
    }

    async reactPostbackAsync(data, params) {
        const __ = this.translator;

        let prefix = 'flex,edit=';
        if (data.startsWith(prefix)) {
            if (!params?.datetime) {
                console.warn('unexpected no datetime');
            } else {
                return this.belongTo.setHolder('alarm-watcher').reactPostbackAsync(data, params)
            }
        }

    }

}

class AlarmBase extends BaseDbUserChatBot {

    get db() {
        return this.belongTo.db.collection('alarms');
    }

    acquireAlarmId() {
        return `alarm_${this.topLevelData.alarmCounter++}`;
    }

    async alarmOneAsync(alarmId) {
        // var data = (await this.db.doc(printf("%02d", alarmId)).get()).data()
        // // const audio_filepathname = `${this.userId}/${audio_name}`
        // // const audio_md = (await getAudioMetadata(audio_filepathname))[0]
        // this.replyAudio({
        //     url: data.url,
        //     duration: data.duration
        // })
        this.replyText('TODO replyAudio')

        let doc = await this.db.doc(alarmId).get();

        await this.#_replyFlexAlarms(doc)
    }

    async alarmAllAsync() {
        const query = await this.db.get();
        this.#_replyFlexAlarms(...query.docs);
    }

    async #_replyFlexAlarms(...docs) {
        const __ = this.translator;

        var arr = []
        for (const doc of docs) {
            let alarmId = doc.id;
            let alarmData = doc.data();

            let flex = flexs.alarmScheduled(__, alarmData.alarmTime, this.topLevelData.timezone, alarmId);
            arr.push(flex)
        }
        this.reply(new FlexMessage(new ImageCarousel(arr).toLINEObject()));
    }

}

class AlarmWatcher extends AlarmBase {

    static NAME = register('alarm-watcher', this);

    #changeAlarmOrder() {
        this.subData.watchOrder = this.subData.watchOrder != '-' ? '-' : '+';
    }

    ////////////////// CHATBOT REACTS /////////////////////

    async reactPostbackAsync(data, params) {
        const __ = this.translator;

        let prefix;
        if (data == 'alarm-watcher,reverseOrder') {
            this.#changeAlarmOrder();
            this.replyText(__('reply.chgAlarmsOrder'));
            // keep looping for user to play "sorting" feature, no abort options
            return this.generateQuickRepliesAsync();
        } else if (data == 'alarm-watcher,seeAllAlarms') {
            await this.alarmAllAsync();
            return this.generateQuickRepliesAsync();

        } else if (data.startsWith(prefix = 'alarm-watcher,alarm=')) {
            let alarmId = data.slice(prefix.length);
            await this.alarmOneAsync(alarmId);
            return this.generateQuickRepliesAsync();
        }

        return super.reactPostbackAsync(...arguments);
    }

    /* --------------- CHATBOT SELF OWNED ------------------ */

    async generateQuickRepliesAsync() {
        /* showing all alarms in QuickReplies format, with sorting feature */
        const __ = this.translator;
        const query = await this.db.get();

        const alarms = [];  // list of alarmData
        for (const doc of query.docs) {
            alarms.push({
                alarmId: doc.id,
                alarmData: doc.data(),
            });
        }
        // TODO sort

        let __log_i = 0;
        for (let {alarmId, alarmData} of alarms) {
            /* the datetime here looks like 2022-10-22T15:29:00.000+08:00 */
            let datetime = this.belongTo.toDatetimeString(alarmData.alarmTime);
            let abbr = datetime.replace(/^....-(..-..)T(..:..).*$/, '$1 $2');
            console.log(`${__log_i++}.`, alarmId, 'datatime', datetime, 'abbr', abbr);

            let idxDigit = alarmId.replace(/^alarm_/, '')
            let label = `⏰ ${idxDigit}, ${abbr}`
            this.addQuickReply(new PostbackAction(`alarm-watcher,alarm=${alarmId}`, label));
        }
        this.addQuickReply(new PostbackAction('alarm-watcher,reverseOrder', __('label.reverseOrder')));
        this.addQuickReply(new PostbackAction('alarm-watcher,seeAllAlarms', __('label.seeAllAlarms')));
    }

}

class AlarmSetter extends AlarmBase {
    // only this class, using alarm id don't need to call super method
    static NAME = register('alarm-setter', this);

    ////////////////// CHATBOT REACTS /////////////////////

    async reactPostbackAsync(data, params) {
        const __ = this.translator;

        if (data == 'alarm-setter') {
            if (!params?.datetime) {
                console.warn('unexpected no datetime');
            } else {
                this.subData.alarmTime = this.belongTo.parseDatetime(params.datetime);
                this.subData.alarmId = this.acquireAlarmId();  // acquire a new alarm id
                this.subData.alarmData = this.#generateAlarmData(this.subData);  // TODO: to be removed

                // stat.watchOrder = '+'  // TODO: to be removed

                // stat.holderData.duration = (await getAudioMetadata(this.audio_filepathname))[0].duration  // TODO: to be removed
                // stat.holderData.url = await getAudioURL(this.audio_filepathname)  // TODO: to be removed
                // this.alarmData = stat.holderData;  // TODO: to be removed

                await this.#saveAndReply();
            }
            return this.belongTo.setHolder('alarm-watcher').generateQuickRepliesAsync();
        } else if (data == 'alarm-setter,noThanks') {
            this.replyText(__('reply.okay'));
            return this.abort();
        } else if (data == 'alarm-setter,seeAlarms' || data == 'sort-changer') {
            return this.belongTo.setHolder('alarm-watcher').reactPostbackAsync(data);
        }


        return super.reactTextAsync(...arguments);
    }

    /* --------------- CHATBOT SELF OWNED ------------------ */

    #generateAlarmData({ audio, duration, url, alarmTime, version, }) {
        version = (version || 0) + 1;
        return {
            audio,
            // duration,
            // url,
            alarmTime,
            version,
            __friendly_time: this.belongTo.toDatetimeString(alarmTime)
        };
    }

    async #saveAndReply() {
        if (!this.subData.alarmId || !this.subData.alarmData) {
            unexpected('alarmId or alarmData is not set')
        }

        await this.#_save();
        this.replyUntilAlarm(this.subData.alarmId);
    }

    async #_save() {
        const alarmData = this.#generateAlarmData(this.subData.alarmData);  // for recalculate __friendly_time
        await setAudioMetadata(alarmData.audio, alarmData.alarmTime, this.alarmId)
        return this.db.doc(this.subData.alarmId).set(alarmData);
    }



    setAudio(filename) {
        const __ = this.translator;

        this.subData = {
            audio: filename,
            alarmTime: null,
            state: 'userSentAudio',
            /* db save related */
            alarmId: null,
            alarmData: null
        };
        this.replyText(__('reply.userSentAudio'));
        this.addQuickReply(
            new DatetimePicker('alarm-setter', __('label.pickATime')),
            new PostbackAction('alarm-setter,noThanks', __('label.noThanks')),
            new PostbackAction('alarm-setter,seeAlarms', __('label.seeAlarms'))
        );
    }

    // BUG, FLEX MESSAGE BUG IS PROBABLY HERE AND #saveAndReply
    async loadEditAbort(alarmId, datetime) {  // load alarm, edit and save, and abort
        this.alarmId = alarmId;
        console.log("loadEditAbort alarm: ", alarmId)
        this.alarmData = (await this.db.doc(printf("%02d", alarmId)).get()).data();

        this.alarmData.alarmTime = this.belongTo.parseDatetime(datetime);
        await this.#saveAndReply();
        return this.abort();
    }

}

class LangSelector extends BaseDbUserChatBot {

    static NAME = register('lang-selector', this);

    ////////////////// CHATBOT REACTS /////////////////////

    async reactPostbackAsync(data, params) {
        const stat = this.topLevelData;
        const __ = this.translator;

        var prefix = 'lang-selector,';
        if (data.startsWith(prefix)) {
            const lang = data.slice(prefix.length);
            if (langs.includes(lang)) {
                this.#setLang(lang);
            } else {
                console.warn(`unknown lang ${lang}`);
            }
            return this.abort();
        }

        return super.reactPostbackAsync(...arguments);
    }

    /* --------------- CHATBOT SELF OWNED ------------------ */

    #setLang(lang) {
        const stat = this.topLevelData;
        const __ = this.translator;

        stat.lang = lang;
        __.lang = lang;
        this.replyText(__('reply.chosenLang'));
    }

    changeLang() {
        // return this.setLang(this.stat.lang != 'zh' ? 'zh' : 'en');

        const stat = this.topLevelData;
        const __ = this.translator;

        this.replyText(__('reply.chooseLang'));
        for (const lang of langs) {
            var displayText = i18n.get(`lang.${lang}`);
            this.addQuickReply(
                new PostbackAction(`lang-selector,${lang}`, displayText)
            );
        }
    }

}

// @typedef description see https://jsdoc.app/tags-typedef.html
// or https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html#typedef-callback-and-param
/**
 * Possible chatbots.
 * @typedef {(DefaultChatBot & AlarmSetter & AlarmWatcher & AlarmReplier & LangSelector)} ChatBotLike
 */

class DbUser {
    /**
     * @param {line.WebhookEvent} event
     */
    constructor(event) {
        this.event = event;
        this.userId = event.source.userId ?? unexpected('null userId');
        this.replyToken = event.replyToken;
        this.replies = [];
        this.quickReplies = [];
        this.__err_transform_count = 0;
    }

    // backgroundJobs = [];

    get db() {
        return db.collection('users').doc(this.userId);
    }

    #__;
    get translator() {
        if (!this.#__) {
            var userLang = this.dbData.lang ?? 'en';
            this.#__ = i18n.translate(userLang);
        }
        return this.#__;
    }

    /**
     * @returns {ChatBotLike}
     */
    get chatbot() {
        /* return chatbot by holder, null is deafult chatbot */
        return this.#getChatBot(this.dbData.holder ?? null);
    }
    #cachedBots = {};
    #getChatBot(name) {
        if (!this.#cachedBots[name]) {
            this.#cachedBots[name] = createChatBot(name, this);
        }
        return this.#cachedBots[name];
    }

    setHolder(name, clear = true) {
        this.__err_transform_count++;  /* accidentally infinite loop check */
        if (this.__err_transform_count > 100) {
            console.error('transform too many times!')
            console.error('is your program stuck?')
        }

        this.dbData.holder = name;
        if (clear) {
            /* TODO */
        }
        return this.chatbot;  // this.chatbot becomes new holder
    }

    /* ------- parseDatetime ------- */
    /**
     * @param {string} datetime
     * @returns {number} timestamp
     */
    parseDatetime(datetime) {
        /* datetime format look like 2017-12-25T01:00 */
        return DateUtility.parseDatetime(datetime, this.dbData.timezone);
    }
    toDatetimeString(timestamp) {
        return DateUtility.toDatetimeString(timestamp, this.dbData.timezone);
    }

    async save() {
        return await this.db.set(this.dbData);
    }

    async replyMessage() {
        var messages = this.replies.map(x => x.toLINEObject());
        if (this.quickReplies.length != 0) {
            if (messages.length == 0) {
                console.warn('no messages, cannot do quick reply');
            } else {
                messages[messages.length - 1].quickReply = {
                    items: this.quickReplies
                }
            }
        }
        console.log('reply messages', messages);
        if (messages.length == 0) {
            console.warn('no messages, nothing will be replied');
        }
        return client.replyMessage(this.replyToken, messages);
    }

    /* ------- onText, onAudio, onPostback ------- */

    async onText() {
        const event = this.event;

        var userText = event.message.text;
        var tag = null;  /* TODO tag */

        await this.chatbot.reactTextAsync(userText, tag);
        return this.replyMessage();
    }

    async onAudio() {
        const event = this.event;

        /* download audio */
        // TODO: send reply and download/upload simultaneously
        var duration = event.message.duration;
        var msgId = event.message.id;
        var filename = `${this.userId}/audio_${msgId}.m4a`;
        var stream = await client.getMessageContent(msgId);

        /* upload audio */
        await uploadStreamFile(stream, filename,
            {
                user: this.userId,
                audio: filename,
                duration: duration,
                __friendly_time: this.toDatetimeString(event.timestamp),
                alarmTime: null,
                alarmId: null,
                timestamp: this.timestamp
            }
        );

        /* reply message */
        await this.chatbot.reactAudioAsync(filename);
        return this.replyMessage();
    }

    async onPostback() {
        const event = this.event;
        console.log("onPostback", event.postback, "\n\n")

        await this.chatbot.reactPostbackAsync(event.postback.data, event.postback.params);
        return this.replyMessage();
    }

    async init() {  // called by startProcessing()
        /* the data in db if exists else empty obj */
        var userData = (await this.db.get()).data() ?? {};
        /** @type {ReturnType<typeof TopLevelData.default>} */
        this.dbData = applyDefault(userData, TopLevelData.default());
    }

    async startProcessing() {
        await this.init();

        const event = this.event;

        var userAction;
        if (event.type == 'message') {
            userAction = event.message.type;
        } else if (['postback'].includes(event.type)) {
            userAction = event.type;
        } else {
            return console.warn(`unhandled event type ${event.type}`)
        }

        /* onText, onAudio, onPostback */
        var key = 'on' + firstLetterCaptialize(userAction);
        if (key in this) {
            return this[key]();
        } else {
            return console.warn(`haven't implement ${key}() method yet`)
        }
    }
}

exports.LineMessAPI = functions.region(region).runWith(spec).https.onRequest(async (request, response) => {
    protocol = request.protocol;
    host = request.get('host');

    // decipher Webhook event sent by LineBot, that triggered by every user input

    // @type description https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html#type
    // line sdk types https://github.com/line/line-bot-sdk-nodejs/blob/master/lib/types.ts
    /** @type {line.WebhookRequestBody} */
    const body = request.body;

    try {
        console.log('\n\nevents length:', body.events.length);

        for (const event of body.events) {
            /* process webhook event now */

            var userObj = new DbUser(event);
            await userObj.startProcessing();

            // await originalProcessing(event, request, response);

            console.log('save storedData', userObj.dbData);
            await userObj.save();

            return response.status(200).send(request.method);

        }

    } catch (err) {
        if (err instanceof line.HTTPError) {
            /* it is line sdk error */
            console.error('line HTTPError', err.originalError.response.data);
        } else {
            console.error(err);
        }
        return response.sendStatus(400);  /* terminate processing */
    }

    return response.sendStatus(500);
});

/////////////////////////////// FIREBASE SEARCHING //////////////////////////////
async function getDocLatestIdx(belongTo, collectionName, toLogNext = true, toString = true) {
    /**
     * @param {DbUser} belongTo
     */
    const user = belongTo.db
    // get latest idx to log the next data into same collection directory
    var idx = (await user.collection(collectionName).get()).size + (+toLogNext);
    idx = toString ? printf("%02d", idx) : idx;
    console.log('idx', idx);
    return idx;
}

async function rearrangeDocNaming(belongTo, collectionName, sizeLoss, nameStartConvention = 1) {
    const size = getDocLatestIdx(belongTo, collectionName, false, false)
    for (let i = 0; i < size; i++) {
        const oldName = nameStartConvention + sizeLoss + i
        const newName = nameStartConvention + i
        const oldSlot = printf("%02d", oldName)
        const newSlot = printf("%02d", newName)
        var doc = await belongTo.db.collection(collectionName).doc(`${oldSlot}`).get()
        if (doc && doc.exists) {
            var data = doc.data();
            // saves the old data to new doc
            await belongTo.db.collection(collectionName).doc(`${newSlot}`).set(data)
            // deletes the old doc
            belongTo.db.collection(collectionName).doc(`${oldSlot}`).delete()
        }
    }
}

function deleteDocWithIdx(belongTo, collectionName, idx, nameStartConvention = 1) {
    slot = printf("%02d", nameStartConvention + idx)
    belongTo.db.collection(collectionName).doc(`${slot}`).delete()
    console.log(`${slot} deleted`)
    belongTo.stat.alarm_count--;
}

async function getDocWithIndex(belongTo, collectionName, idx, nameStartConvention = 1) {
    // to get first one, idx = 0
    /**
     * @param {DbUser} belongTo
     * @param {collectionName} string collection name u want to find
     * @param {idx} integer for indexing doc from collection
     * @param {nameStartConvention} integer the naming convention of alarms starts with zero to ease transition to UI string
     */
    const user = belongTo.db
    var size = (await user.collection(collectionName).get()).size
    if (size == 0) return null
    if (nameStartConvention + idx > size) {
        console.warn(`The collection doesn't have enough files for you to use such a big index!\nChoose smaller.`)
        return null
    }
    slot = printf("%02d", nameStartConvention + idx)
    return await user.collection(collectionName).doc(`${slot}`).get()
}

async function getStorageFilesWithIndex(belongTo, idx) {
    var [files] = await bucket.getFiles() //{prefix: `${userId}/`}
    var files_correct = []
    for (let i = 0; i < files.length; i++) {
        f = files[i]
        // console.log("get Files: ", f)
        var correct = f.metadata.name.startsWith(`${belongTo.userId}/`)
        if (correct) {
            files_correct.push(f)
        }
    }
    // var filename = files_correct[idx].metadata.name
    // var duration = files_correct[idx].metadata.metadata.duration
    var file_metadata = files_correct[idx].metadata
    return file_metadata
}

/////////////////////////////// PROCESS AUDIO MSG ///////////////////////////////

async function uploadAlarmToDatebase(belongTo, filepathname) {
    /**
     * @param {DbUser} belongTo
     * @param {alarm_metadata} object that stores metadata
     */
    // log alarm data into database
    const user = belongTo.db
    const metadata = (await getAudioMetadata(filepathname))[0] // datetime,duration,name,timer,url,user
    const idx = await getDocLatestIdx(belongTo, 'alarms', true, true)
    user.collection("alarms").doc(`${idx}`).set(
        {
            ...metadata,
            url: await getAudioURL(filepathname)
        },
        { merge: true })
}

async function getAudioMetadata(filepathname) {
    // md - metadata
    var [md_outer] = await bucket.file(filepathname).getMetadata() // only select 0th ele
    var contentType = md_outer.contentType
    var md_inner = md_outer.metadata
    // console.log(`\n\ngetting audio msg metadata (${filepathname}) in Storage...\n`)
    // console.log(printf("originally, content type: %s, metadata_inner: %s\n", contentType, JSON.stringify(md_inner)))
    return [md_inner, contentType]
}

async function setAudioMetadata(filepathname, alarmTime, alarmId) {
    // console.log(`\n\nupdating audio msg metadata (${filepathname}) in Storage...`)
    var data = await getAudioMetadata(filepathname)
    var md_inner = data[0]

    for (k in md_inner) {
        if (k == "alarmTime") {
            md_inner[k] = alarmTime
        } else if (k == "alarmId") {
            md_inner[k] = alarmId
        }
    }
    update = {
        contentType: data[2],
        metadata: md_inner
    }
    // console.log("updated data: ", JSON.stringify(update))
    // console.log(printf(`finished updating ${filepathname}...`))
    await bucket.file(filepathname).setMetadata(update)
}

async function getAudioURL(filepathname, locally = true) {
    let filename = filepathname.substring(filepathname.lastIndexOf('/') + 1, filepathname.length)
    if (locally) {
        var url = `https://${host}/linemsgapi-v2/asia-east1/publicizeLocalFile?file=${filepathname}`
        console.log(filename, ", local url", url)
        // var [files] = await bucket.getFiles();
        // var url = files[files.length - 1].metadata.mediaLink // get the latest1
    } else {
        const urlOptions = {
            version: "v4",
            action: "read",
            expires: Date.now() + 1000 * 60 * 10, // 10 minutes
        }
        var url = (await bucket.file(filepathname).getSignedUrl(urlOptions))[0]
        console.log(filename, ", online url", url)

    }
    return url;
}