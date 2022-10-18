
const fs = require('fs');
const runtimeconfig = JSON.parse(fs.readFileSync('.runtimeconfig.json'));

////////////////// LINE /////////////////////
const line = require('@line/bot-sdk')
const client = new line.Client(runtimeconfig.secrets.lineClientConfig);

(async () => {
    const texts = [
        'Pick a time',
        'text2',
        'text3',
        'text4',
        'text5',
        'Set Bot Language',
    ]

    console.log(await client.getRichMenuList())

    // delete all richmenu, to update the new richmenu
    var richmenus = await client.getRichMenuList()

    for (let i = 0; i < richmenus.length; i++) {
        var rm = richmenus[i].richMenuId
        // console.log(rm)
        client.deleteRichMenu(rm)
    }

    var width = 810;
    var height = 250;

    var rows = 2;
    var cols = 3;

    const richmenu = {
        "size": {
            "width": width,
            "height": height
        },
        "selected": true,
        "name": "Nice richmenu",
        "chatBarText": "Freq use funcs",
        "areas": []
    }

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            var w = width / cols << 0;
            var h = height / rows << 0;
            var x = j * w;
            var y = i * h;
            var text = texts[i * cols + j];

            richmenu.areas.push({
                bounds: {width: w, height: h, x, y},
                "action": {
                    "type": "message",
                    "label": text,
                    "text": text
                }
            })
        }
    }

    richmenu.areas[5].action = {
        "type": "postback",
        "label": "Set Bot Language",
        "data": "Set Bot Language",
        "displayText": "Set Bot Language",
      }

    console.log('new rich menu', richmenu)

    const richMenuId = await client.createRichMenu(richmenu)
    console.log("richMenuId: " + richMenuId)
    await client.setRichMenuImage(richMenuId, fs.readFileSync("./richmenu.png"))
    await client.setDefaultRichMenu(richMenuId)

})();

