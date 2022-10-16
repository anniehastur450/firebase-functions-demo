/* eslint-disable */

const path = require('path');
const fs = require('fs');
const request = require('request');
const printf = require('printf');

////////////////// FIREBASE /////////////////////
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const region = 'asia-east1';
const spec = { memory: "1GB" };
admin.initializeApp(functions.config().firebase)
const db = admin.firestore();
const bucket = admin.storage().bucket();

////////////////// LINE /////////////////////
/* for locals, create a .runtimeconfig.json file for functions.config() to read */
const channelToken = functions.config().secrets.lineClientConfig.channelAccessToken;
const channelSecret = functions.config().secrets.lineClientConfig.channelSecret;
const line = require("@line/bot-sdk");
const config = {
    channelAccessToken: channelToken,
    channelSecret: channelSecret,
};
const client = new line.Client(config);

const LINE_HEADER = {
    "Content-Type": "application/json",
    "Authorization": "Bearer {'" + channelToken + "'}"
}

var msgId; // used it as naming standard for audio records, only message type has it, not postback type
var userText; // only message type has it
var userAction; // event.type for postback type, evenet.message.type for message type

// quickReply has 1 extra attribute => "quickReply"
// https://developers.line.biz/en/docs/messaging-api/using-quick-reply/#set-quick-reply-buttons

createRichMenu();

exports.publicizeLocalFile = functions.region(region).runWith(spec).https.onRequest((request, respond) => {
    console.log('request.query', request.query)
    console.log('req host', request.get('host'))
    console.log('req origin', request.get('origin'))

    var a = request.query.fileName;
    if (!a) {
        respond.sendStatus(404)
        return
    }
    respond.setHeader('Content-Type', 'audio/mp4');

    (async () => {
        var file = bucket.file(a)
        var [buffer] = await file.download()
        respond.send(buffer)
    })().catch(err => {
        console.error(err);
        respond.sendStatus(404)
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
exports.LineMessAPI = functions.region(region).runWith(spec).https.onRequest(async (request, respond) => {

    // decipher Webhook event sent by LineBot, that triggered by every user input
    var event = request.body.events[0]
    userId = event.source.userId;
    replyToken = event.replyToken;
    timestamp = event.timestamp;
    var userText = null;
    var d = new Date(timestamp);
    datetime = timeParser(d)

    console.log(
        "\n\n", "----------------------------------------------------------------------------\n",
        "time: ", datetime, "\n\n",
        event, "\n\n"
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

    // proceed LineBot differently according to user input (aka. userAction)
    if (userAction == "text") {
        replyTextMsg(replyToken, `HelloText ${name}, ${userText}`)
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
            replyConfirmTemplate(replyToken,confBackendData[0])
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
            ( event.postback.data.includes("setVoice=yes") ||
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
        else if (latestPb !== null && event.postback.data.includes("setting=yes")){
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

    return respond.status(200).send(request.method);
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
    })

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

async function createRichMenu() {

    // delete all richmenu, to update the new richmenu
    var richmenus = await client.getRichMenuList()

    for (let i = 0; i < richmenus.length; i++) {
        var rm = richmenus[i].richMenuId
        // console.log(rm)
        client.deleteRichMenu(rm)
    }

    data = fs.readFileSync('richmenu_data.json');
    json_data = JSON.parse(data)

    const richmenu = {
        "size": {
            "width": json_data["width"],
            "height": json_data["height"]
        },
        "selected": true,
        "name": "Nice richmenu",
        "chatBarText": "tap to open",
        "areas": [
            {
                "bounds": json_data["bound1"],
                "action": {
                    "type": "postback",
                    "label": "notifyToRecordAlarm",
                    "data": "recordVoice",
                    "displayText": "",
                    "inputOption": "openVoice",
                }
            },
            {
                "bounds": json_data["bound2"],
                "action": {
                    "type": "message",
                    "label": "2",
                    "text": "2"
                }
            },
            {
                "bounds": json_data["bound3"],
                "action": {
                    "type": "message",
                    "label": "3",



                    "text": "3"
                }
            },

        ]
    }

    const richMenuId = await client.createRichMenu(richmenu)
    // console.log("richMenuId: " + richMenuId)
    await client.setRichMenuImage(richMenuId, fs.readFileSync(path.join(__dirname, "./richmenu.png")))
    await client.setDefaultRichMenu(richMenuId)

}

function replyFlexMsg(replytoken, flex_data) {
    console.log("token used in ", arguments.callee.name, ": ", replytoken)
    return request.post({
        uri: `https://api.line.me/v2/bot/message/reply`,
        headers: LINE_HEADER,
        body: JSON.stringify({
            replyToken: replytoken,
            messages: [
                {
                    "type": "flex",
                    "altText": "this is a flex message",
                    "contents": flex_data

                }
            ]
        })
    });
}

function pushMsg(userId, textPrompt) {
    return request.post({
        uri: `https://api.line.me/v2/bot/message/push`,
        headers: LINE_HEADER,
        body: JSON.stringify({
            "to": userId,
            messages: [
                {
                    "type": "text",
                    "text": textPrompt
                }
            ]
        })
    });
}


function replyTextMsg(replytoken, textfrom) {
    return request.post({
        uri: `https://api.line.me/v2/bot/message/reply`,
        headers: LINE_HEADER,
        body: JSON.stringify({
            replyToken: replytoken,
            messages: [
                {
                    type: "text",
                    text: textfrom
                }
            ]
        })
    });
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
    return request.post({
        uri: `https://api.line.me/v2/bot/message/reply`,
        headers: LINE_HEADER,
        body: JSON.stringify({
            replyToken: replytoken,
            messages: [
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
            ]
        })
    });
}


function replyAudioMsg(replytoken, textfrom, audio_url, audio_duration) {
    return request.post({
        uri: `https://api.line.me/v2/bot/message/reply`,
        headers: LINE_HEADER,
        body: JSON.stringify({
            replyToken: replytoken,
            messages: [
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
        })
    });
}

/////////////////////////////// PROCESS AUDIO MSG ///////////////////////////////

async function getLatestAudioMsgData(request) {
    var [files] = await bucket.getFiles();
    var filename = files[files.length - 1].metadata.name
    var url = getPubUrl(request, filename)
    return [filename, url]
}

async function uploadAudioMsg(msgId, filename, duration) {
    var stream = await client.getMessageContent(msgId);

    var pathname = await new Promise((resolve, reject) => {
        // console.log('getting audio message...');
        var pathname = `/tmp/${filename}`; //
        const writable = fs.createWriteStream(pathname);
        stream.pipe(writable);
        stream.on('end', () => resolve(pathname));
        stream.on('error', reject);
    });
    // console.log(`uploading audio message to ${pathname}...`);

    var pathname_dest = pathname.slice(pathname.lastIndexOf('/') + 1);

    // console.log(pathname);
    // console.log(pathname_dest);

    await bucket.upload(pathname, {
        destination: pathname_dest,
        metadata: {
            contentType: "audio/mp4",
        },
        customMetadata: duration
    })

    // console.log(`done uploading.`);

    var url = await getAudioMsgUrl(filename);

    return url;

}

async function getAudioMsgUrl(filename) {
    var pathname = `/tmp/${filename}`;
    var pathname_dest = pathname.slice(pathname.lastIndexOf('/') + 1);

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
    var host = request.get('host')
    var url = `https://${host}/linemsgapi-v2/asia-east1/publicizeLocalFile?fileName=${filename}`
    // console.log(filename, ": ", url)
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

