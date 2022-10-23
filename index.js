
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

const dirtyJobsBehind = require('./dirtyJobsBehind.js');

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
        /* returning datetime format look like 2022-10-22T15:29:00.000+08:00 */
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

/**
 * customMetadata is (await getFileMetadata(filename)).metadata
 * set: https://cloud.google.com/storage/docs/json_api/v1/objects/insert#request_properties_JSON
 * get: https://cloud.google.com/storage/docs/json_api/v1/objects
 * @param {string} filename
 */
async function getFileMetadata(filename) {
    const file = bucket.file(filename);
    const [metadata] = await file.getMetadata();

    console.log(`metadata for ${filename}`, metadata);
    return metadata;
}

function getPubUrl(filename) {
    var url = `${protocol}://${host}/${project}/${region}/publicizeLocalFile?file=${encodeURIComponent(filename)}`;
    console.log(`${filename}:`, url);
    return url;
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

const langs = i18n.getTag('langs');

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
            this.reply(new TextMessage(text));
        }
    }

    replyAudio(url, duration) {
        this.reply(new AudioMessage(url, duration));
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
                let alarmId = data.slice(prefix.length);
                return this.belongTo.setHolder('alarm-setter').loadEditWatch(alarmId, params.datetime);
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

    async alarmOneAsync(alarmId) {
        let doc = await this.db.doc(alarmId).get();

        let filename = doc.data().audio;
        let { metadata } = await getFileMetadata(filename);
        this.replyAudio(getPubUrl(filename), metadata.duration);

        await this.#_replyFlexAlarms(doc);
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
        /* notice: this is not sort */
        if (this.subData.watchOrder == '-') {
            alarms.reverse();
        }

        let __log_i = 0;
        for (let { alarmId, alarmData } of alarms) {
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
        } else if (data == 'alarm-setter,seeAlarms') {
            let bot = this.belongTo.setHolder('alarm-watcher');
            await bot.alarmAllAsync();
            return bot.generateQuickRepliesAsync();
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

    async loadEditWatch(alarmId, datetime) {  // load alarm, edit and save, and abort
        this.subData.alarmId = alarmId;
        this.subData.alarmData = (await this.db.doc(alarmId).get()).data();

        this.subData.alarmData.alarmTime = this.belongTo.parseDatetime(datetime);
        await this.#saveAndReply();
        return this.belongTo.setHolder('alarm-watcher').generateQuickRepliesAsync();
    }

}

// @typedef description see https://jsdoc.app/tags-typedef.html
// or https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html#typedef-callback-and-param
/**
 * Possible chatbots.
 * @typedef {(DefaultChatBot & AlarmSetter & AlarmWatcher & LangSelector)} ChatBotLike
 */

class DbUser {
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

}

/**
 * @param {line.WebhookEvent} event
 * @param {admin.firestore.Firestore} topDb
 */
async function startProcessing(event, topDb) {
    const userId = event.source.userId ?? unexpected('null userId');
    const db = topDb.collection('users').doc(userId);
    /** @type {ReturnType<typeof TopLevelData.default>} */
    const dbData = applyDefault((await db.get()).data() ?? {}, TopLevelData.default());
    const __ = i18n.translate(dbData.lang ?? 'en');

    const replies = dirtyJobsBehind.ofReplies();
    const quickRe = dirtyJobsBehind.ofQuickReplies();
    const chatbot = dirtyJobsBehind.ofChatBot();

    /* default chat bot */
    chatbot('null').canHandleText({
        match: {
            'lang': () => {
                chatbot.changeTo('lang-selector');
            },
        },
        default: (text) => {
            replies.text(__('reply.hellomsg', text));
        }
    });

    /* lang-selector */
    chatbot('lang-selector').firstThingToDoAfter___changeTo_this___Is(
        () => {
            replies.text(__('reply.chooseLang'));
            for (const lang of langs) {
                let displayText = __.get(`lang.${lang}`);
                quickRe.label(displayText).post(`lang-selector,${lang}`);
            }
        }
    ).canHandlePostback({
        startsWith: {
            'lang-selector,': (lang) => {
                if (langs.includes(lang)) {
                    dbData.lang = lang;
                    __.lang = lang;
                    replies.text(__('reply.chosenLang'));
                } else {
                    console.warn(`unknown lang ${lang}`);
                }
            }
        }
    });

    /* alarm scope */
    if (false) {
        function acquireAlarmId() {
            return `alarm_${this.topLevelData.alarmCounter++}`;
        }

        function replyUntilAlarm(alarmId) {
            replies.text(`TODO replyUntilAlarm(${alarmId})`);
        }

        /* alarm-setter */
        chatbot('alarm-setter').canHandleAudio({
            default: (filename) => {
                chatbot.saveTheFollowingSubDataForThisChatBot({
                    audio: filename,
                    alarmTime: null,
                    state: 'userSentAudio',
                    /* db save related */
                    alarmId: null,
                    alarmData: null
                });
                replies.text(__('reply.userSentAudio'));
                quickRe.label(__('label.pickATime')).pickDatetime('alarm-setter');
                quickRe.namespaced(chatbot.giveMeTheNameOfThisChatBot())  // postback prefix is 'alarm-setter,'
                    .labelsByTranslator(__, 'label.')  // __, tag prefix is 'label.'
                    .add('noThanks')
                    .add('seeAlarms')
                    ;
            }
        }).canHandlePostback({
            namespaced: {
                match: {
                    'noThanks': () => {
                        replies.text(__('reply.okay'));
                    },
                    'seeAlarms': () => {
                        chatbot.changeTo('alarm-watcher');
                    }
                }
            }
        }).canHandleDatetimePicker({
            match: {
                'alarm-setter': async (datetime) => {
                    const { audio } = chatbot.giveMeTheSubDataForThisChatBot();
                    const alarmTime = DateUtility.parseDatetime(datetime, dbData.timezone);
                    const alarmId = acquireAlarmId();
                    await chatbot.doNowAsync.saveTheFollowingToTheDatabaseThisChatBotToUse({
                        docId: alarmId,
                        docData: {
                            audio,
                            alarmTime,
                            version: 0,  // version is edited count
                            __friendly_time: DateUtility.toDatetimeString(alarmTime, dbData.timezone),
                        }
                    });
                    replyUntilAlarm(alarmId);
                    chatbot.changeTo('alarm-watcher');
                }
            }
        }).registerDbToUse('alarms');

        /* alarm-watcher */
        chatbot('alarm-watcher').lastThingToDoIs(
            () => {
                /* if replies is empty, make flex message of all alarms */

                /* add quick replies of all alarms*/

            }
        ).canHandlePostback({
            namespaced: {
                match: {
                    'reverseOrder': () => {

                    },
                    'seeAllAlarms': () => {

                    }
                }
            },
            startsWith: {
                'alarm-watcher,alarm=': (alarmId) => {

                }
            }
        });

    }

    await dirtyJobsBehind.startProcessingAsync({
        event: event,
        client: client,
        replies: replies,
        quickReplies: quickRe,
        chatbot: chatbot,
    });

    /* save db */
    console.log('save dbData', dbData);
    await db.set(dbData);

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

            await startProcessing(event, db);
        }

        return response.status(200).send(request.method);

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

exports.publicizeLocalFile = functions.region(region).runWith(spec).https.onRequest((request, response) => {
    console.log(`publicizeLocalFile: ${request.query}`);

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
