
/* to use gcloud service, you will need credentials json

1. go to https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk
    and download credentials json

2. create a file ".env", contains path to the json just download

GOOGLE_APPLICATION_CREDENTIALS=titanium-backend-firebase-adminsdk-XXXXX-XXXXXXXXXX.json
PROJECT_ID=titanium-backend

3. don't forget to enable Cloud Translation API

*/

// https://medium.com/analytics-vidhya/how-to-use-google-cloud-translation-api-with-nodejs-6bdccc0c2218
// process.env.GOOGLE_APPLICATION_CREDENTIALS = tokenPath;
require('dotenv').config()

const { Translate } = require('@google-cloud/translate').v2;

const projectId = process.env.PROJECT_ID;

// Instantiates a client
const translate = new Translate({ projectId });

async function quickStart() {
    // The text to translate
    const text = 'Hello, world!';

    // The target language
    const target = 'zh';

    // Translates some text into Russian
    const [translation] = await translate.translate(text, target);
    console.log(`Text: ${text}`);
    console.log(`Translation: ${translation}`);

    {
        const [translation] = await translate.translate(['Hello', 'Goodbye', 'Are you ok?'], target);
        console.log(`Text: ${text}`);
        console.log(`Translation: ${translation}`);
    }

    {
        const [languages] = await translate.getLanguages();
        const name = languages.filter(x => x.code == 'zh');
        console.log(`name`, name);
    }
    {
        const [languages] = await translate.getLanguages('zh');
        const name = languages.filter(x => x.code == 'zh');
        console.log(`name`, name);
    }
    {
        const [languages] = await translate.getLanguages('ja');
        let name = languages.filter(x => x.code == 'zh');
        console.log(`name`, name);
        name = languages.filter(x => x.code == 'ja');
        console.log(`name`, name);
    }
}

quickStart()
