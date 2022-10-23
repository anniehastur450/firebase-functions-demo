
/* private property */
const inner = Symbol();

function unexpected(errorMessage) {
    throw new Error(errorMessage);
}

function isPromise(item) {
    return typeof item === 'object' && typeof item.then === 'function';
}

class ChatBot {
    static data(bot) {
        return bot.#data;
    }

    static handlers(type, bots) {
        const ret = [];
        for (const bot of bots) {
            if (bot.#data.canHandle[type]) {
                ret.push({
                    name: bot.#data.name,
                    opt: bot.#data.canHandle[type],
                });
            }
        }
        return ret;
    }

    #data = {
        name: null,
        canHandle: {
            text: null,
            audio: null,
            postback: null,
            datetimePicker: null,
        },
        onEnters: null,
    }

    constructor(name) {
        this.#data.name = name;
    }

    #setCanHandle(type, fnName, options) {
        /* check already exist */
        if (this.#data.canHandle[type]) {
            unexpected(`${fnName} shouldn't be called more than once`)
        }
        this.#data.canHandle[type] = options;
        return this;
    }

    canHandleText(options) {
        /* check support */
        const supportedKeys = ['match', 'default'];
        for (const key of Object.keys(options)) {
            if (!supportedKeys.includes(key)) {
                unexpected(`${key} is not in supported keys [${supportedKeys}]`);
            }
        }

        return this.#setCanHandle('text', this.canHandleText.name, options);
    }

    canHandleAudio(options) {
        /* check support */
        const supportedKeys = ['default'];
        for (const key of Object.keys(options)) {
            if (!supportedKeys.includes(key)) {
                unexpected(`${key} is not in supported keys [${supportedKeys}]`);
            }
        }

        return this.#setCanHandle('audio', this.canHandleAudio.name, options);
    }

    canHandlePostback(options) {
        /* check support */
        const supportedKeys = ['match', 'default', 'startsWith'];
        for (const key of Object.keys(options)) {
            if (!supportedKeys.includes(key)) {
                unexpected(`${key} is not in supported keys [${supportedKeys}]`);
            }
        }

        return this.#setCanHandle('postback', this.canHandlePostback.name, options);
    }

    canHandleDatetimePicker(options) {
        this.#data.canHandle.datetimePicker = options;
        return this;
    }

    registerDbToUse(options) {

        return this;
    }

    firstThingToDoAfter___changeTo_this___Is(func) {
        this.#data.onEnters = func;
        return this;
    }

    lastThingToDoIs(options) {

        return this;
    }
}

async function matchHandlerAsync(text, match, name, preHook, postHook) {
    if (!match) return;
    for (const key in match) {
        if (text == key) {
            await preHook(name);
            await match[key](text);
            await postHook(name);
            return true;
        }
    }
}

async function startsWithHandlerAsync(text, startsWith, name, preHook, postHook) {
    if (!startsWith) return;
    for (const key in startsWith) {
        if (text.startsWith(key)) {
            await preHook(name);
            let subText = text.slice(key.length);
            await startsWith[key](subText);
            await postHook(name);
            return true;
        }
    }
}

async function defaultsHandlerAsync(defaults, text, __err_type, preHook, postHook) {
    if (defaults.length == 0) {
        console.warn(`no default handler for ${__err_type} ${text}`);
        return;
    }
    if (defaults.length > 1) {
        console.warn(`more than one (found ${defaults.length}) default ${__err_type} handler, mistaken?`);
    }
    const { name, d } = defaults[0];
    await preHook(name);
    await d(text);
    await postHook(name);
}

////////////////// CHATBOTS /////////////////////

exports.ofChatBot = function () {
    const bots = [];
    const botsMap = {};
    let currentBot = null;  // save bot name

    let changeToChain = [];
    let pendingPromises = [];

    function preHook(name) {
        currentBot = name;
    }

    function postHook(name) {
        if (currentBot == null) {
            return;
        }
        if (currentBot == name) {
            currentBot = null;
        } else if (changeToChain.length == 0) {
            console.error('post hook 1 some unknown error happened');
        } else if (changeToChain.slice(-1)[0] != currentBot) {
            console.error('post hook 2 some unknown error happened');
        }
    }

    function chatbot(name) {
        const bot = new ChatBot(name);
        bots.push(bot);
        if (botsMap.hasOwnProperty(name)) {
            unexpected(`chatbot ${name} already exists`);
        }
        botsMap[name] = bot;
        return bot;
    }

    // chatbot.saveTheFollowingSubDataForThisChatBot = function () {

    // }

    // chatbot.giveMeTheNameOfThisChatBot = function () {

    // }

    chatbot.changeTo = function (name) {
        if (!currentBot) {
            unexpected(`no chatbot is running when changeTo(${name})`);
        }
        if (botsMap.hasOwnProperty(name)) {
            changeToChain.push(currentBot);
            changeToChain.push(name);
            currentBot = name;
            let r = ChatBot.data(botsMap[name]).onEnters?.();
            if (isPromise(r)) {
                pendingPromises.push(r);
            }
        } else {
            unexpected(`ChatBot ${name} not found`)
        }
    }

    /**
     * @param {import("@line/bot-sdk").WebhookEvent} event
     */
    async function processAsync(event) {
        const userAction = (() => {
            if (event.type == 'message') {
                return event.message.type;
            } else if (['postback'].includes(event.type)) {
                return event.type;
            } else {
                console.warn(`unhandled event type ${event.type}`);
            }
            return null;
        })();

        const actions = {
            'text': async () => {
                const handlers = ChatBot.handlers('text', bots);
                const text = event.message.text;

                /* handle text async */
                await (async () => {
                    const defaults = [];
                    for (const handler of handlers) {
                        const { name, opt } = handler;
                        if (await matchHandlerAsync(text, opt.match, name, preHook, postHook)) return;
                        if (opt.default) {
                            defaults.push({ name, d: opt.default });
                        }
                    }
                    await defaultsHandlerAsync(defaults, text, 'text', preHook, postHook);
                })();
            },
            'postback': async () => {
                const handlers = ChatBot.handlers('postback', bots);
                const data = event.postback.data;

                /* handle postback async */
                await (async () => {
                    const defaults = [];
                    for (const handler of handlers) {
                        const { name, opt } = handler;
                        if (await matchHandlerAsync(data, opt.match, name, preHook, postHook)) return;
                        if (await startsWithHandlerAsync(data, opt.startsWith, name, preHook, postHook)) return;
                        if (opt.default) {
                            defaults.push({ name, d: opt.default });
                        }
                    }
                    await defaultsHandlerAsync(defaults, data, 'postback', preHook, postHook);
                })();
            },
            'audio': async () => {
                

            }
        };

        if (userAction in actions) {
            await actions[userAction]();
        } else {
            console.warn(`haven't implement ${key}() method yet`);
        }

        /* wait for unfinished promises */
        await Promise.all(pendingPromises);
    }

    chatbot[inner] = {
        processAsync,
    };

    return chatbot;
}

////////////////// REPLIES /////////////////////

exports.ofReplies = function () {
    const messages = [];

    return {
        text(text) {
            messages.push({
                type: 'text',
                text: text,
            });
        },
        [inner]: {
            async processAsync(event, client, labels) {
                const replyToken = event.replyToken;

                /* add quick replies */
                const items = [];
                for (const lb of labels) {
                    if (lb.LINE_action == null) {
                        unexpected(`no action found for label ${lb.label}`);
                    }
                    items.push({
                        type: 'action',
                        action: lb.LINE_action
                    });
                }
                if (labels.length != 0) {
                    if (messages.length == 0) {
                        console.warn('no messages, cannot do quick reply');
                    } else {
                        messages[messages.length - 1].quickReply = { items };
                    }
                }

                /* do reply using line sdk */
                console.log('quickReply', items);
                console.log('reply messages', messages);
                if (messages.length == 0) {
                    console.warn('no messages, nothing will be replied');
                }
                await client.replyMessage(replyToken, messages);
            }
        }
    };
}

////////////////// QUICK REPLIES /////////////////////

class QuickReplyLabel {
    constructor(label) {
        this.label = label;
        this.LINE_action = null;
    }

    post(data) {
        this.LINE_action = {
            type: 'postback',
            label: this.label,
            data: data,
            displayText: this.label,
        };
    }
}

exports.ofQuickReplies = function () {
    const labels = [];

    return {
        label(label) {
            let lb = new QuickReplyLabel(label);
            labels.push(lb);
            return lb;
        },
        [inner]: {
            labels,
        }
    };
}

////////////////// START PROCESSING /////////////////////

exports.startProcessingAsync = async function (options) {
    const {
        event,
        client,
        replies,
        quickReplies,
        chatbot
    } = options;

    await chatbot[inner].processAsync(event);
    await replies[inner].processAsync(event, client, quickReplies[inner].labels);
}
