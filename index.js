
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
const langs = i18n.getTag('langs');

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
    ((topDb) => {
        const db = topDb.collection('alarms');

        function acquireAlarmId() {
            return `alarm_${dbData.alarmCounter++}`;
        }

        function replyUntilAlarm(alarmId) {
            replies.text(`TODO replyUntilAlarm(${alarmId})`);
        }

        function changeAlarmOrder() {
            dbData.watchOrder = dbData.watchOrder != '-' ? '-' : '+';
        }

        async function generateQuickRepliesAsync() {
            /* showing all alarms in QuickReplies format, with sorting feature */
            const query = await db.get();

            const alarms = [];  // list of alarmData
            for (const doc of query.docs) {
                alarms.push({
                    alarmId: doc.id,
                    alarmData: doc.data(),
                });
            }
            // TODO sort
            /* notice: this is not sort */
            if (dbData.watchOrder == '-') {
                alarms.reverse();
            }

            let __log_i = 0;
            for (let { alarmId, alarmData } of alarms) {
                /* the datetime here looks like 2022-10-22T15:29:00.000+08:00 */
                let datetime = DateUtility.toDatetimeString(alarmData.alarmTime, dbData.timezone);
                let abbr = datetime.replace(/^....-(..-..)T(..:..).*$/, '$1 $2');
                console.log(`${__log_i++}.`, alarmId, 'datatime', datetime, 'abbr', abbr);

                let idxDigit = alarmId.replace(/^alarm_/, '');
                let label = `⏰ ${idxDigit}, ${abbr}`;
                quickRe.label(label).post(`alarm-watcher,alarm=${alarmId}`);
            }
            quickRe.label(__('label.reverseOrder')).post('alarm-watcher,reverseOrder');
            quickRe.label(__('label.seeAllAlarms')).post('alarm-watcher,seeAllAlarms');
        }

        async function flexAlarmOneAsync(alarmId) {
            let doc = await db.doc(alarmId).get();

            let filename = doc.data().audio;
            let { metadata } = await getFileMetadata(filename);
            replies.audio(getPubUrl(filename), metadata.duration);

            _replyFlexAlarms([doc]);
        }

        async function flexAlarmAllAsync() {
            const query = await db.get();
            _replyFlexAlarms(query.docs);
        }

        function _replyFlexAlarms(docs) {
            const arr = []
            for (const doc of docs) {
                let alarmId = doc.id;
                let alarmData = doc.data();

                let flex = flexs.alarmScheduled(__, alarmData.alarmTime, dbData.timezone, alarmId);
                arr.push(flex);
            }
            replies.flexMulti(arr);
        }

        /* alarm-setter */
        chatbot('alarm-setter').canHandleAudio({
            default: async (msgId, duration) => {
                /* download audio */
                // TODO: send reply and download/upload simultaneously
                var filename = `${userId}/audio_${msgId}.m4a`;
                var stream = await client.getMessageContent(msgId);

                /* upload audio */
                await uploadStreamFile(stream, filename,
                    {
                        duration: duration,
                        timestamp: event.timestamp,
                        __friendly_time: DateUtility.toDatetimeString(event.timestamp, dbData.timezone),
                    }
                );

                /* reply message */
                dbData.subData['alarm-setter'] = {
                    audio: filename,
                    alarmTime: null,
                    state: 'userSentAudio',
                    /* db save related */
                    alarmId: null,
                    alarmData: null
                };
                replies.text(__('reply.userSentAudio'));
                quickRe.label(__('label.pickATime')).pickDatetime('alarm-setter');
                quickRe.label(__('label.noThanks')).post('alarm-setter,noThanks');
                quickRe.label(__('label.seeAlarms')).post('alarm-setter,seeAlarms');
            }
        }).canHandlePostback({
            match: {
                'alarm-setter,noThanks': () => {
                    replies.text(__('reply.okay'));
                },
                'alarm-setter,seeAlarms': () => {
                    chatbot.changeTo('alarm-watcher');
                },
                'flex,viewAlarms': () => {
                    chatbot.changeTo('alarm-watcher');
                }
            }
        }).canHandleDatetimePicker({
            match: {
                'alarm-setter': async (datetime) => {
                    const { audio } = dbData.subData['alarm-setter'];
                    const alarmTime = DateUtility.parseDatetime(datetime, dbData.timezone);
                    const alarmId = acquireAlarmId();
                    await db.doc(alarmId).set({
                        audio,
                        alarmTime,
                        version: 0,  // version is edited count
                        __friendly_time: DateUtility.toDatetimeString(alarmTime, dbData.timezone),
                    });
                    replyUntilAlarm(alarmId);
                    chatbot.changeTo('alarm-watcher');
                }
            },
            startsWith: {
                'flex,edit=': async (alarmId, datetime) => {
                    let {
                        audio,
                        alarmTime,
                        version,
                    } = (await db.doc(alarmId).get()).data();  // this is alarmData
                    alarmTime = DateUtility.parseDatetime(datetime, dbData.timezone);

                    await db.doc(alarmId).set({
                        audio,
                        alarmTime,
                        version: version + 1,  // version is edited count
                        __friendly_time: DateUtility.toDatetimeString(alarmTime, dbData.timezone),
                    });
                    replyUntilAlarm(alarmId);
                    chatbot.changeTo('alarm-watcher');
                }
            }
        });

        /* alarm-watcher */
        chatbot('alarm-watcher').lastThingToDo___if_last_changeTo_is_still_this___Is(
            async () => {
                /* if replies is empty, make flex message of all alarms */
                if (replies.size == 0) {
                    await flexAlarmAllAsync();
                }

                /* add quick replies of all alarms*/
                await generateQuickRepliesAsync();
            }
        ).canHandlePostback({
            match: {
                'alarm-watcher,reverseOrder': async () => {
                    changeAlarmOrder();
                    replies.text(__('reply.chgAlarmsOrder'));
                    await generateQuickRepliesAsync();
                },
                'alarm-watcher,seeAllAlarms': async () => {
                    await flexAlarmAllAsync();
                    await generateQuickRepliesAsync();
                }
            },
            startsWith: {
                'alarm-watcher,alarm=': async (alarmId) => {
                    await flexAlarmOneAsync(alarmId);
                    await generateQuickRepliesAsync();
                }
            }
        });

    })(db);

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
