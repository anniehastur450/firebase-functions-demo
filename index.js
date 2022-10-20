
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

var msgId; // used it as naming standard for audio records, only message type has it, not postback type
var userAction; // event.type for postback type, evenet.message.type for message type

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

function timeParser(timeObj) {
    let d = timeObj
    var hr = d.getUTCHours() + 8
    if (hr >= 24) hr = hr - 24
    datetime = printf("%d-%02d-%02d_%02d-%02d-%02d",
        d.getFullYear(), (d.getMonth() + 1), d.getDate(),
        hr, d.getMinutes(), d.getSeconds()
    )
    return datetime
}

async function originalProcessing(event, request, response) {

    userId = event.source.userId;
    replyToken = event.replyToken;
    timestamp = event.timestamp;
    var userText = null;
    var d = new Date(timestamp);
    datetime = timeParser(d)

    console.log(
        "\n\n----------------------------------------------------------------------------\n",
        "time: ", datetime, "\n\n",
        "event: ", event, "\n\n"
    )

    // decipher type of message user has sent, store into userAction variable
    if (event.type === "message") {
        userAction = event.message.type
        msgId = event.message.id;
        if (event.message.type === "text")
            userText = event.message.text
    } else {
        userAction = event.type
        if (userAction === "postback") {
            var eventPbCode = event.postback.data
        }
    }

    // store userdata to database (chat- & postback-history)
    var currUser = db.collection("users").doc(userId.toString())
    var pbLogs = await updateToDatebase(currUser, userId, userAction, userText, timestamp, datetime, eventPbCode, replyToken)
    var name = await checkUserInDatebase(userId)

    // check previous userAction contains postback or not
    var latestPb = null
    var idxPb = -1
    if (!pbLogs.empty) {
        idxPb = (await currUser.collection("postback-history").get()).size
        idxPb = printf("%02d", idxPb)
        var latestPb = await currUser.collection("postback-history").doc(`pb${idxPb}`).get()
    }

    // in case of user repeatedly making mistake of sending audio msg for a flex message,
    // by storing the previous replytoken in database, using this, we're able to only send flex message once,
    // bcuz the replytoken can only be used oncei
    if (latestPb !== null) {
        console.log("latest Postback: ", latestPb.data(), "\n\n")
        latestPb_replytoken = latestPb.data().replyToken
        latestPb_name = latestPb.data().name
    }

    var userLang = (await currUser.get())?.data();
    console.log('lang', userLang)
    userLang = userLang.lang ?? 'en';
    if (userText == 'change lang') {
        userLang = userLang == 'en' ? 'zh' : 'en';
        await currUser.set({ lang: userLang }, { merge: true });
    }

    var __ = i18n.translate(userLang);

    // proceed LineBot differently according to user input (aka. userAction)
    if (userAction == "text") {
        // replyTextMsg(replyToken, `HelloText ${name}, ${userText}`)
        replyTextMsg(replyToken, __('message.reply', name, userText))
    }
    else if (userAction == "audio") {
        // upload audio msg
        var duration = event.message.duration;
        var filename = `audio_${datetime}.m4a`
        var audio_url_online = await uploadAudioMsg(msgId, filename, duration)
        var audio_url_local = getPubUrl(request, filename)
        // console.log('audio_url: ', audio_url_local)
        // reply flex msg, if latest postback = "recordVoice"

        if (latestPb !== null && latestPb.data().pbCode === "recordVoice") {
            /*
            if the latest postback in database = "recordVoice", 
            meaning in this current request,
            user has already sent voice msg, 
            hence now ask user further questions,
            by using flex message
            */
            json = fs.readFileSync('flex_data.json');
            data = JSON.parse(json)
            // give identifier according to flex message postback
            // chg setVoice=yes Postback Data
            data["1"]["body"]["contents"][0]["contents"][1]["contents"][0]["action"]["data"] = `${latestPb_name}_setVoice=yes`
            // chg setVoice=no Postback Data
            data["1"]["body"]["contents"][0]["contents"][1]["contents"][1]["action"]["data"] = `${latestPb_name}_setVoice=no`
            // printing to check
            console.log(data["1"]["body"]["contents"][0]["contents"][1]["contents"][0]["action"]["data"])
            console.log(data["1"]["body"]["contents"][0]["contents"][1]["contents"][1]["action"]["data"])
            // chg setTimer=yes Postback Data
            data["1"]["body"]["contents"][1]["contents"][1]["action"]["data"] = `${latestPb_name}_setTimer=yes`
            console.log(data["1"]["body"]["contents"][1]["contents"][1]["action"]["data"])

            replyFlexMsg(latestPb_replytoken, data["1"])

        }
        else if (latestPb !== null && latestPb.data().pbCode.includes("setVoice=no")) {
            var data1 = await getLatestAudioMsgData(request)
            var alarm_name = data1[0]
            var alarm_url = data1[1]
            replyAudioMsg(latestPb_replytoken, `This is the alarm at same time, but new audio, correct?\n\n name: ${alarm_name}\n url: ${alarm_url}`, alarm_url, "10000")
            replyConfirmTemplate(replyToken, confBackendData[0])
        }
        // testing
        else if (latestPb === null) {
            replyAudioMsg(replyToken, `HelloVoice ${name}`, audio_url_local, duration)
        }
    }
    /* 
    !!!! 
    HERE to DECIPHER how user REACT to FLEX MSG, 
    since every question require button pressing,
    so every button creates "postback", 
    and from looking at "postback",
    we can decipher whether it is a yes or no, from every question
    !!!! 
    */
    else if (userAction === "postback") {

        if (latestPb !== null &&
            (event.postback.data.includes("setVoice=yes") ||
                event.postback.data.includes("resetVoice=yes")
            )) {
            var data1 = await getLatestAudioMsgData(request)
            var alarm_name = data1[0]
            var alarm_url = data1[1]
            var data2 = await logAudioAlarmToDatebase(currUser, userId, timestamp, datetime, alarm_name, alarm_url)
            // if all went correctly, must data1 === data2
            console.log(`data1, name: ${data1[0]}, url: ${data1[1]}`)
            console.log(`data2, name: ${data2[0]}, url: ${data2[1]}`)
            pushMsg(userId, `You have selected this as an alarm`)
        }
        else if (latestPb !== null && event.postback.data.includes("setVoice=no")) {
            pushMsg(userId, `Please record voice message now AGAIN :(... as an alarm`)
        }
        else if (latestPb !== null && event.postback.data.includes("setTimer=yes")) {
            // update jsondata here too, for setVoice=no, add the info of latest timer to the file naming
            console.log(`latest Postback = ${latestPb_name}, its pbCode = ${latestPb.data().pbCode}`)
            timer = event.postback.params.datetime
            var d2 = new Date(timer)
            // mm hh DD MM
            alarmtime_cron = printf("%02d %02d %02d %02d *",
                d2.getMinutes(), d2.getHours(), d2.getDate(), (d2.getMonth() + 1))
            var alarmtime_normal = timeParser(d2)
            console.log(alarmtime_cron)
            var alarmdata = await getLatestAudioMsgData(request);
            var alarm_name = alarmdata[0]
            var alarm_url = alarmdata[1]
            replyAudioMsg(latestPb_replytoken, `This is the alarm at ${alarmtime_normal}, correct?\n\n name: ${alarm_name}\n url: ${alarm_url}`, alarm_url, "10000")
        }
        else if (latestPb !== null && event.postback.data.includes("setting=yes")) {
            pushMsg(userId, `Congrats... you have sucessfully finished setting alarm :)`)
            var data1 = await getLatestAudioMsgData(request)
            var alarm_name = data1[0]
            var alarm_url = data1[1]
            replyAudioMsg(latestPb_replytoken, `Finally, your alarm at ${alarmtime_normal}, correct?\n\n name: ${alarm_name}\n url: ${alarm_url}`, alarm_url, "10000")
        }
        else if (eventPbCode === "recordVoice") {
            pushMsg(userId, `Please record voice message now... as an alarm`)
        }

    }

}

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

/* user doc data object structure (to store lang, states, etc) */
function defaultUserData() {
    return {
        lang: null,   // or 'en', 'zh', null mean unset
        timezone: 8,  // only support utc+8 for now, user selected time will minus this
        tags: {},     // store quick reply its corresponding tag
        holder: null, // or 'alarm-setter', state holder
        holderData: {},  // (holder specific data)
    };
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

////////////////// CHATBOT /////////////////////

/*
const chatbots is generated at runtime, which will look like this:
{
    'null': ChatBot,
    'alarm-setter': AlarmSetter,
    'lang-selector': LangSelector,
}

*/
const chatbots = {};
function register(name, theClass) {
    if (chatbots.hasOwnProperty(name)) {
        console.error(`name ${name} already exist`)
        throwRegisterFailure(theClass);
    }
    chatbots[name] = theClass;
    return name;
}
function throwRegisterFailure(theClass) {
    unexpected(`${theClass.name}.NAME should be declared as follows\n`
        + `    static NAME = ${register.name}('{{THE_BOT_NAME}}', this);`);
}

const langs = [
    'en',
    'zh',
    'jp',
]

class BaseDbUserChatBot {
    /**
     * @param {DbUser} belongTo
     */
    constructor(belongTo) {
        this.belongTo = belongTo;
        if (!this.constructor.hasOwnProperty('NAME')) {
            throwRegisterFailure(this.constructor);
        }
        /** @type {string} */
        this.name = this.constructor.NAME;
    }

    get stat() {
        return this.belongTo.storedData;
    }

    get translator() {
        return this.belongTo.translator;
    }

    get replies() {
        return this.belongTo.replies;
    }

    get quickReplies() {
        return this.belongTo.quickReplies;
    }

    ////////////////// CHATBOT TRANSFORMER /////////////////////

    abort() {  // go to fallback
        this.onAbort();
        return this.transformTo(null);
    }

    transformTo(name) {
        this.belongTo.__err_transform_count++;
        if (this.belongTo.__err_transform_count > 100) {
            console.error('transform too many times!')
            console.error('is your program stuck?')
        }
        this.stat.holder = name;
        return this.belongTo.getChatBot(name);
    }

    ////////////////// CHATBOT REPLIES /////////////////////

    addQuickReply(...actions) {
        for (let action of actions) {
            if (action.toLINEObject) {
                action = action.toLINEObject();
            }
            this.quickReplies.push({
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

    replyText(...texts) {
        for (const text of texts) {
            this.replies.push(new TextMessage(text));
        }
    }

    ////////////////// EMPTY CHATBOT SENDS /////////////////////

    __tmp_clear_state() {
        const stat = this.stat;

        stat.holder = null;
        stat.holderData = {};
        stat.tags = {};
    }

    onAbort() { unexpected('not implemented') }  // subclass except ChatBot must implement it

    async reactText(text, tag) {
        return this.abort().reactText(...arguments);
    }

    async reactAudio(filename) {
        return this.abort().reactAudio(...arguments);
    }

    async reactPostback(data, params) {
        return this.abort().reactPostback(...arguments);
    }

}

class ChatBot extends BaseDbUserChatBot {  /* take the db save/store logic out of reply logic */

    static NAME = register(null, this);

    ////////////////// CHATBOT SENDS /////////////////////

    async reactText(text, tag) { /* user text, and corresponding tag */
        const stat = this.stat;
        const __ = this.translator;

        if (text == 'lang') {
            return this.transformTo('lang-selector').changeLang();
        }
        if (tag != null) {
            console.warn(`unhandled tag ${tag}, ${text}`);
        }
        return this.replyText(__('reply.hellomsg', text));
    }

    async reactAudio(filename) {
        const stat = this.stat;
        const __ = this.translator;

        return this.transformTo('alarm-setter').setAudio(filename);
    }

    async reactPostback(data, params) {
        const stat = this.stat;
        const __ = this.translator;

        /* empty for now */
    }

}

class AlarmSetter extends BaseDbUserChatBot {

    static NAME = register('alarm-setter', this);

    ////////////////// CHATBOT SENDS /////////////////////

    onAbort() {
        __tmp_clear_state();
    }

    async reactText(text, tag) { /* user text, and corresponding tag */
        const stat = this.stat;
        const __ = this.translator;

        if (tag == 'label.noThanks') {
            /* clear setting alarm */
            this.__tmp_clear_state();
            return this.replyText(__('reply.okay'));
        }

        return super.reactText(...arguments);
    }

    async reactPostback(data, params) {
        const stat = this.stat;
        const __ = this.translator;

        if (params.datetime) {
            /* clear setting alarm */
            this.__tmp_clear_state();
            return this.replyText(__('reply.youHaveSet', params.datetime));
        }

        return super.reactText(...arguments);
    }

    /* --------------- CHATBOT SELF OWNED ------------------ */

    setAudio(filename) {
        const stat = this.stat;
        const __ = this.translator;

        stat.holder = 'alarm-setter';
        stat.tags = {
            [__('label.noThanks')]: 'label.noThanks'
        };
        stat.holderData = {
            audio: filename,
            alarmTime: null,
            state: 'sentAudio'
        };
        this.replyText(__('reply.sentAudio'));
        this.addQuickReply(new DatetimePicker('alarm-setter', __('label.pickATime')));
        this.addQuickReplyText(__('label.noThanks'));
    }

}

class LangSelector extends BaseDbUserChatBot {

    static NAME = register('lang-selector', this);

    ////////////////// CHATBOT SENDS /////////////////////

    onAbort() {
        this.__tmp_clear_state();
    }

    async reactText(text, tag) {
        if (langs.includes(tag)) {
            return this.setLang(tag);
        }
        return super.reactText(...arguments);
    }

    /* --------------- CHATBOT SELF OWNED ------------------ */

    setLang(lang) {
        const stat = this.stat;
        const __ = this.translator;

        stat.lang = lang;
        __.lang = lang;
        return this.replyText(__('reply.chosenLang'));
    }

    changeLang() {
        // return this.setLang(this.stat.lang != 'zh' ? 'zh' : 'en');

        const stat = this.stat;
        const __ = this.translator;

        for (const lang of langs) {
            var displayText = i18n.get(`lang.${lang}`);
            this.stat.tags[displayText] = lang;
            this.addQuickReplyText(displayText);
        }
        this.replyText(__('reply.chooseLang'));
    }

}

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
            var userLang = this.storedData.lang ?? 'en';
            this.#__ = i18n.translate(userLang);
        }
        return this.#__;
    }

    #cachedBots = {};
    getChatBot(name) {
        if (!this.#cachedBots[name]) {
            this.#cachedBots[name] = new chatbots[name](this);
        }
        return this.#cachedBots[name];
    }

    async save() {
        return await this.db.set(this.storedData);
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

    async onText() {
        const event = this.event;

        var userText = event.message.text;
        var tag = null;
        if (this.storedData.tags.hasOwnProperty(userText)) {
            tag = this.storedData.tags[userText];
        }
        await this.chatbot.reactText(userText, tag);
        return this.replyMessage();
    }

    async onAudio() {
        const event = this.event;

        /* download audio */
        // TODO: send reply and download/upload simultaneously
        var duration = event.message.duration;
        var msgId = event.message.id;
        var filename = `audio_${this.userId}_${msgId}.m4a`;
        var stream = await client.getMessageContent(msgId);

        /* upload audio */
        await uploadStreamFile(stream, filename,
            {
                duration: duration,
                datetime: timeParser(new Date(event.timestamp))
            }
        );

        /* reply message */
        await this.chatbot.reactAudio(filename);
        return this.replyMessage();
    }

    async onPostback() {
        const event = this.event;

        await this.chatbot.reactPostback(event.postback.data, event.postback.params);
        return this.replyMessage();
    }

    async init() {  // called by startProcessing()
        /* the data in db if exists else empty obj */
        var userData = (await this.db.get()).data() ?? {};
        /** @type {ReturnType<typeof defaultUserData>} */
        this.storedData = applyDefault(userData, defaultUserData());

        if (this.storedData.holder) {
            this.chatbot = this.getChatBot(this.storedData.holder);
        } else {
            this.chatbot = this.getChatBot(null);
        }
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

            console.log('save storedData', userObj.storedData);
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

function extractPbDataToArr(pbCode) {
    return pbCode.split("_")
}

async function logAudioAlarmToDatebase(currUser, userId, timestamp, datetime, name, url) {
    // log AudioAlarm URL into database
    var alarmLogs = await currUser.collection("audio-alarm").get()
    var idx
    if (alarmLogs.empty) {
        idx = 1;
    } else {
        idx = (await currUser.collection("postback-history").get()).size + 1;
    }
    idx = printf("%02d", idx)
    currUser.collection("audio-alarm").doc(`alarm${idx}`).set({
        "name": name,
        "userId": userId,
        "timestamp": timestamp,
        "datetime": datetime,
        "url": url
    })
    return [name, url];
}

async function reupdatePostbackDataToDatebase(currUser) {

}

async function updateToDatebase(currUser, userId, userAction, userText, timestamp, datetime, pbCode, replytoken) {
    // update user data to Firestore Database
    var profile = await client.getProfile(userId)
    profileName = profile.displayName;
    pictureUrl = profile.pictureUrl;

    // add User Data
    currUser.set({
        "name": profileName,
        "profile pic": pictureUrl,
    }, { merge: true })

    // add Chat History
    currUser.collection("chat-history").doc(datetime.toString()).set({
        "userId": userId,
        "userAction": userAction,
        "userText": userText,
        "timestamp": timestamp,
        "datetime": datetime
    })

    // add Postback History
    var pbLogs = await currUser.collection("postback-history").get()
    if (userAction === "postback") {
        var idx
        if (pbLogs.empty) {
            idx = 1;
        } else {
            idx = (await currUser.collection("postback-history").get()).size + 1;
        }
        idx = printf("%02d", idx)
        currUser.collection("postback-history").doc(`pb${idx}`).set({
            "name": `pb${idx}`,
            "userId": userId,
            "timestamp": timestamp,
            "datetime": datetime,
            "pbCode": pbCode,
            "replyToken": replytoken
        })
    }
    return pbLogs
}

async function checkUserInDatebase(userId) {
    // check if user already exist in database
    const userData = await db.collection("users").doc(userId).get()
    var name = "xxx"
    if (userData.exists)
        name = userData.data().name
    else
        replyTextMsg(replyToken, "You are not the customer yet, hence now you will automatically become one, and shall never see this message again.")
    return name;
}

function replyFlexMsg(replytoken, flex_data) {
    console.log("token used in ", arguments.callee.name, ": ", replytoken)
    return client.replyMessage(replytoken,
        {
            "type": "flex",
            "altText": "this is a flex message",
            "contents": flex_data
        }
    );
}

function pushMsg(userId, textPrompt) {
    return client.pushMessage(userId,
        {
            "type": "text",
            "text": textPrompt
        }
    );
}


function replyTextMsg(replytoken, textfrom) {
    return client.replyMessage(replytoken,
        {
            type: "text",
            text: textfrom
        }
    );
}

confBackendData = [
    [
        "Set this voice msg as alarm?",
        {
            "type": "postback",
            "label": "Yes",
            "data": "resetVoice=yes"
        },
        {
            "type": "postback",
            "label": "No",
            "data": "resetVoice=no"
        }
    ],
    []
]

function replyConfirmTemplate(replytoken, backendData) {
    promptMsg = backendData[0]
    yesAction = backendData[1]
    noAction = backendData[2]
    return client.replyMessage(replytoken,
        {
            "type": "template",
            "altText": "confirm template",
            "template": {
                "type": "confirm",
                "text": promptMsg,
                "actions": [
                    yesAction,
                    noAction
                ]
            }
        }
    );
}


function replyAudioMsg(replytoken, textfrom, audio_url, audio_duration) {
    return client.replyMessage(replytoken,
        [
            {
                type: "text",
                text: textfrom
            },
            {
                type: "audio",
                originalContentUrl: audio_url,
                duration: audio_duration
            }
        ]
    );
}

/////////////////////////////// PROCESS AUDIO MSG ///////////////////////////////

async function getLatestAudioMsgData(request) {
    var [files] = await bucket.getFiles();
    var filename = files[files.length - 1].metadata.name
    var url = getPubUrl(request, filename)
    return [filename, url]
}

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

async function uploadAudioMsg(msgId, filename, duration) {
    var stream = await client.getMessageContent(msgId);

    var file = bucket.file(filename);
    var writeStream = file.createWriteStream({
        metadata: {
            contentType: "audio/mp4",
            metadata: { duration }
        },
    });

    // see https://googleapis.dev/nodejs/storage/latest/File.html#createWriteStream
    await new Promise((resolve, reject) => {
        console.log(`uploading ${filename}...`);
        stream.pipe(writeStream)
            .on('error', reject)
            .on('finish', resolve);
    });

    console.log(`done uploading ${filename}.`);

    var url = await getAudioMsgUrl(filename);

    return url;

}

async function getAudioMsgUrl(filename) {

    // const urlOptions = {
    //     version: "v4",
    //     action: "read",
    //     expires: Date.now() + 1000 * 60 * 10, // 10 minutes
    // }
    // var url = (await bucket.file(pathname_dest)
    //     .getSignedUrl(urlOptions))[0]

    var [files] = await bucket.getFiles();
    // for (let i=0; i<media_token.length; i++) {
    //     var temp = media_token[i];
    //     console.log(temp)
    // }
    var url = files[files.length - 1].metadata.mediaLink // get the last one in storage, aka the most recent one

    // console.log("url: " + url)

    return url;
}

function getPubUrl(request, filename) {
    var protocol = request.protocol;
    var host = request.get('host');
    var url = `${protocol}://${host}/${project}/${region}/publicizeLocalFile?file=${encodeURIComponent(filename)}`
    console.log(filename, ": ", url)
    return url
}

async function findTargetedAudioMsg(msgId) {
    var getFilesResponse = await bucket.getFiles(); // GetFilesResponse = [File[], {}, Metadata];
    var files = getFilesResponse[0];
    var files_size = getFilesResponse[0].length;
    var files_unknown = getFilesResponse[1];
    var files_metadata = getFilesResponse[2];

    console.log(`files_size: ${files_size}, files_unknown: ${files_unknown}, files_metadata: ${files_metadata}`)

    files.forEach(async file => {
        if (file.name === `audio_${msgId}.m4a`) {
            var url = await getAudioMsgUrl(msgId);
            return url;
        }
    })
    return null;
}

/////////////////////////////// PROCESS AUDIO MSG ///////////////////////////////

