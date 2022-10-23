
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

    static handlers(userAction, bots) {
        const ret = [];
        for (const bot of bots) {
            if (bot.#data.canHandle[userAction]) {
                ret.push({
                    name: bot.#data.name,
                    opt: bot.#data.canHandle[userAction],
                });
            }
        }
        ret.userAction = userAction;
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
        // const supportedKeys = ['match', 'default', 'startsWith', 'namespaced'];
        const supportedKeys = ['match', 'default', 'startsWith'];
        for (const key of Object.keys(options)) {
            if (!supportedKeys.includes(key)) {
                unexpected(`${key} is not in supported keys [${supportedKeys}]`);
            }
        }

        return this.#setCanHandle('postback', this.canHandlePostback.name, options);
    }

    canHandleDatetimePicker(options) {
        const supportedKeys = ['match', 'default', 'startsWith'];
        for (const key of Object.keys(options)) {
            if (!supportedKeys.includes(key)) {
                unexpected(`${key} is not in supported keys [${supportedKeys}]`);
            }
        }

        return this.#setCanHandle('datetimePicker', this.canHandleDatetimePicker.name, options);
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

function findHandler(handlers, text, types) {  // types is array like ['match', 'startsWith']
    /*
    this function will return the following object
    {
        func: null, // the found function
        args: [], // func args
        name: null, // bot name
        type: null, // 'match', 'startsWith' or 'default'
    }

    */

    const a = {
        match: (match) => {
            if (!match) return;
            for (const key in match) {
                if (text == key) {
                    return {
                        func: match[key],
                        args: [],
                    };
                }
            }
        },
        startsWith: (startsWith) => {
            if (!startsWith) return;
            for (const key in startsWith) {
                if (text.startsWith(key)) {
                    let subText = text.slice(key.length);
                    return {
                        func: startsWith[key],
                        args: [subText],
                    };
                }
            }
        }
    };

    const defaults = [];
    for (const { name, opt } of handlers) {  // opt.match, opt.startsWith, opt.default
        for (const type of types) {
            let r;
            if (r = a[type](opt[type])) {
                r.name = name;
                r.type = type;
                return r;
            }
        }
        if (opt.default) {
            defaults.push({ name, func: opt.default });
        }
    }

    /* fall back to default */
    if (defaults.length == 0) {
        console.warn(`no default handler for ${handlers.userAction} ${text}`);
        return;
    }
    if (defaults.length > 1) {
        console.warn(`more than one (found ${defaults.length}) default ${handlers.userAction} handler, mistaken?`);
    }

    return {
        ...defaults[0],
        args: [text],
        type: 'default',
    }
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
                    const res = findHandler(handlers, text, ['match']);
                    await preHook(res.name);
                    await res.func(...res.args);
                    await postHook(res.name);
                })();
            },
            'postback': async () => {
                if (event.postback.params?.datetime) {
                    /* datetime picker */
                    const handlers = ChatBot.handlers('datetimePicker', bots);
                    const data = event.postback.data;
                    const datetime = event.postback.params.datetime;

                    /* handle datetime picker async */
                    await (async () => {
                        const res = findHandler(handlers, data, ['match', 'startsWith']);
                        await preHook(res.name);
                        await res.func(...res.args, datetime);
                        await postHook(res.name);
                    })();
                } else {
                    /* pure postback */
                    const handlers = ChatBot.handlers('postback', bots);
                    const data = event.postback.data;

                    /* handle postback async */
                    await (async () => {
                        const res = findHandler(handlers, data, ['match', 'startsWith']);
                        await preHook(res.name);
                        await res.func(...res.args);
                        await postHook(res.name);
                    })();
                }

            },
            'audio': async () => {
                const handlers = ChatBot.handlers('audio', bots);
                var msgId = event.message.id;
                var duration = event.message.duration;

                /* handle audio async */
                await (async () => {
                    const res = findHandler(handlers, null, []);
                    await preHook(res.name);
                    await res.func(msgId, duration);
                    await postHook(res.name);
                })();
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

    pickDatetime(data, options) {
        this.LINE_action = {
            type: 'datetimepicker',
            label: this.label,
            data: data,
            mode: 'datetime',
            ...options,
        };
    }
}

exports.ofQuickReplies = function () {
    const labels = [];

    const quickRe = {
        label(label) {
            let lb = new QuickReplyLabel(label);
            labels.push(lb);
            return lb;
        },
        // namespaced(name) {
        //     return {
        //         labelsByTranslator(__, prefix) {
        //             return {
        //                 add(tag) {
        //                     quickRe.label(__(prefix + tag)).post(`${name},${tag}`);
        //                     return this;
        //                 }
        //             }
        //         }
        //     }
        // },
        [inner]: {
            labels,
        }
    };

    return quickRe;
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
