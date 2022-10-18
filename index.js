
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

/*
user doc data object structure (to store lang, states, etc)

    {
        lang: null, 'en' or 'zh'    // null mean unset
        stateHolder: null or 'alarm-setter'
        stateData: (holder specific data)
        stateReplies: {             // store quick reply its corresponding tag
            [key = text]: [value = tag]
        }
    }

alarm-setter data

    {
        audio: null or filename
        alarmTime: null or timestamp (utc)
        state: 'waitTime', 'waitAudio'
    }

*/

class DbUser {
    /**
     * @param {line.WebhookEvent} event
     */
    constructor(event) {
        this.event = event;
        this.userId = event.source.userId ?? unexpected('null userId');
        this.replyToken = event.replyToken;
    }

    // backgroundJobs = [];

    get db() {
        return db.collection('users').doc(this.userId);
    }

    getTranslator() {
        if (!this.__) {
            var userLang = this.storedData.lang ?? 'en';
            this.__ = i18n.translate(userLang);
        }
        return this.__;
    }

    // async get(fieldPath) {
    //     var snapshot = await this.snapshotPromise;
    //     return snapshot.get(fieldPath);
    // }

    // async save(obj) {
    //     return await this.db.set(obj, { merge: true });
    // }
    async save() {
        return await this.db.set(this.storedData);
    }

    replyTextMsg(textfrom) {
        return client.replyMessage(this.replyToken,
            {
                type: "text",
                text: textfrom
            }
        );
    }

    replyTextMsg2(textfrom, quickReply) {
        return client.replyMessage(this.replyToken,
            {
                type: "text",
                text: textfrom,
                quickReply: {
                    'items': quickReply
                }
            }
        );
    }

    async setLang(lang) {
        var __ = await this.getTranslator();

        this.storedData.lang = lang;
        __.lang = lang;
        return await this.replyTextMsg(__('reply.chosenLang'));
    }

    async changeLang() {
        await this.setLang(this.storedData.lang != 'zh' ? 'zh' : 'en');
    }

    async doAction(userAction) {
        const event = this.event;
        var __ = await this.getTranslator();

        switch (userAction) {
            case 'text':
                var userText = event.message.text;
                if (userText == 'lang') {
                    await this.changeLang();
                } else {
                    if (this.storedData.stateHolder != null
                        && this.storedData.stateReplies.hasOwnProperty(userText)
                    ) {
                        var tag = this.storedData.stateReplies[userText];
                        switch (this.storedData.stateHolder) {
                            case 'alarm-setter':
                                /* abort setting alarm */
                                this.storedData.stateHolder = null;
                                this.storedData.stateData = null;
                                this.storedData.stateReplies = {};
                                await this.replyTextMsg(__('reply.okay'));
                                break;
                            default:
                                unexpected('unhandled state holder ' + this.storedData.stateHolder)
                        }
                    } else {
                        await this.replyTextMsg(__('reply.hellomsg', event.message.text));
                    }
                }
                break;
            case 'postback':
                if (this.storedData.stateHolder == 'alarm-setter') {
                    /* clear setting alarm */
                    this.storedData.stateHolder = null;
                    this.storedData.stateData = null;
                    this.storedData.stateReplies = {};
                    await this.replyTextMsg(__('reply.youHaveSet', event.postback.params.datetime));

                }
                break;
            case 'audio':
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
                // await this.getAlarmSetter().process();
                if (this.storedData.stateHolder == null) {
                    this.storedData.stateHolder = 'alarm-setter'
                }
                this.storedData.stateHolder = 'alarm-setter';
                this.storedData.stateReplies = {
                    [__('label.noThanks')]: 'label.noThanks'
                };
                this.storedData.stateData = {
                    audio: filename,
                    alarmTime: null,
                    state: 'waitTime'
                }
                console.log(123)
                await this.replyTextMsg2(__('reply.sentAudio'),
                    [
                        {
                            type: 'action',
                            action: {
                                type: 'datetimepicker',
                                label: __('label.pickATime'),
                                data: 'alarm-setter',
                                mode: 'datetime'
                            }
                        },
                        {
                            type: 'action',
                            action: {
                                type: 'message',
                                label: __('label.noThanks'),
                                text: __('label.noThanks')
                            }
                        }
                    ]
                );
        }
    }

    async init() {  // called by startProcessing()
        /* the data in db if exists else empty obj */
        this.storedData = (await this.db.get()).data() ?? {};
    }

    async startProcessing() {
        await this.init();

        const event = this.event;

        if (event.type == 'message') {
            await this.doAction(event.message.type);
        } else if (event.type == 'postback') {
            await this.doAction('postback');
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

            console.log(userObj.storedData)

            await userObj.save();

            return response.status(200).send(request.method);

        }

    } catch (err) {
        console.error(err);
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

