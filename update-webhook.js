
////////////////// LINE /////////////////////
const line = require("@line/bot-sdk");
const client = new line.Client(require('./.runtimeconfig.json').secrets.lineClientConfig);

const axios = require('axios');

// client.setWebhookEndpointUrl();

async function main() {
    const response = await axios.get('http://localhost:4040/api/tunnels');
    console.log(response.data);
    const public_url = response.data.tunnels[0].public_url;
    console.log('public_url', public_url);
    await client.setWebhookEndpointUrl(`${public_url}/titanium-backend/asia-east1/LineMessAPI`);
}

main();
