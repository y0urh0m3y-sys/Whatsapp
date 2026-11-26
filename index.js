const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');

// =====================================================================
// 1. RENDER HTTP HEALTH SERVER & ENVIRONMENT KEYS
// =====================================================================
const app = express();
const PORT = process.env.PORT || 10000;

const API_KEYS = {
    GROQ: process.env.GROQ_API_KEY || "",
    CEREBRAS: process.env.CEREBRAS_API_KEY || "",
    OPENROUTER: process.env.OPENROUTER_API_KEY || ""
};

const AI_MODELS = [
    { name: "Groq Llama-3.1-8B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.1-8b-instant" },
    { name: "Cerebras Llama-3.1-8B", provider: "CEREBRAS", url: "https://api.cerebras.ai/v1/chat/completions", model: "llama3.1-8b" },
    { name: "Groq Llama-3.3-70B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    { name: "OpenRouter Gemini-2.0-Flash", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemini-2.0-flash-exp:free" },
    { name: "Groq Gemma2-9B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "gemma2-9b-it" },
    { name: "Cerebras Llama-3.3-70B", provider: "CEREBRAS", url: "https://api.cerebras.ai/v1/chat/completions", model: "llama-3.3-70b" },
    { name: "OpenRouter Llama-3.1-8B", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.1-8b-instruct:free" },
    { name: "Groq Mixtral-8x7B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "mixtral-8x7b-32768" }
];

const modelCooldowns = new Map();
let activeAiCount = 0;
const MAX_CONCURRENT_AI = 2;

app.get('/', (req, res) => {
    const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
    res.status(200).json({
        status: 'healthy',
        service: 'WhatsApp Selective 8-AI Userbot',
        ram_usage_mb: `${memUsage} MB`,
        uptime_sec: Math.floor(process.uptime())
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 [Render Server] Listening on port ${PORT}`);
});

// =====================================================================
// 2. PERSISTENT STATE & SETTINGS
// =====================================================================
const SETTINGS_FILE = './settings.json';

let state = {
    aiGlobalAll: false,
    aiChats: [],
    aiTargets: {},
    aiSystemPrompt: "You are replying on WhatsApp on behalf of the user. Keep replies short, natural, casual Hinglish/English, max 1-2 sentences.",
    gcReplies: [
        "Hello! Currently away, will reply shortly ⚡",
        "Active in group, message acknowledged 👍",
        "Busy at the moment, checking notifications later 🚀",
        "Auto-reply active. Stay tuned! 💬",
        "Ping received. I will review this soon 🔥"
    ],
    dmReplies: [
        "Hey! Currently away from DM, will respond soon ⚡",
        "Message received in private chat 👍",
        "Please hold on, reviewing DMs shortly 🚀",
        "Auto-responder active for direct messages 💬",
        "Thanks for reaching out! Will get back to you soon 🔥"
    ],
    ncTitles: [
        "🔥 ALPHA ZONE 🔥",
        "⚡ THUNDER REIGN ⚡",
        "👑 APEX EMPIRE 👑",
        "💎 NITRO KINGS 💎",
        "🚀 SUPREME RULE 🚀"
    ],
    replyAllDms: false,
    replyDms: [],
    replyAllGcs: false,
    replyGcs: [],
    targetReplies: {},
    muteAllDms: false,
    unmuteExempts: [],
    muteChats: [],
    lockChats: [],
    targetMutes: {},
    targetLocks: {},
    pinAll: false,
    pinChats: [],
    pinExempts: [],
    targetNcReply: {},
    targetNcMute: {},
    targetNcLock: {}
};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        state = { ...state, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch (e) {}
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

const gcIndex = new Map();
const dmIndex = new Map();
const lastReplyTime = new Map();
const ncIntervals = new Map();
const COOLDOWN_MS = 2500;

// =====================================================================
// 3. 45-SECOND RAM & MEMORY AUTO-CLEANER (< 512MB SAFE)
// =====================================================================
setInterval(() => {
    const now = Date.now();
    for (const [k, t] of lastReplyTime.entries()) {
        if (now - t > 45000) lastReplyTime.delete(k);
    }
    for (const [m, exp] of modelCooldowns.entries()) {
        if (now > exp) modelCooldowns.delete(m);
    }
    if (gcIndex.size > 300) gcIndex.clear();
    if (dmIndex.size > 300) dmIndex.clear();
    if (global.gc) {
        try { global.gc(); } catch (e) {}
    }
}, 45000);

// =====================================================================
// 4. 8-MODEL AI FALLBACK GENERATOR
// =====================================================================
async function generateAIReply(userMessage, senderName, isGroup) {
    if (activeAiCount >= MAX_CONCURRENT_AI) return null;

    activeAiCount++;
    const now = Date.now();

    try {
        for (const cfg of AI_MODELS) {
            const apiKey = API_KEYS[cfg.provider];
            if (!apiKey) continue;

            const cooldownUntil = modelCooldowns.get(cfg.name) || 0;
            if (now < cooldownUntil) continue;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            try {
                const response = await fetch(cfg.url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: cfg.model,
                        messages: [
                            { role: "system", content: `${state.aiSystemPrompt} Replying to ${senderName} in a ${isGroup ? 'group' : 'DM'}.` },
                            { role: "user", content: userMessage.slice(0, 300) }
                        ],
                        max_tokens: 90,
                        temperature: 0.7
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeout);

                if (response.status === 429 || response.status === 402 || response.status === 503) {
                    modelCooldowns.set(cfg.name, Date.now() + 60000);
                    continue;
                }
                if (!response.ok) {
                    modelCooldowns.set(cfg.name, Date.now() + 30000);
                    continue;
                }

                const data = await response.json();
                const reply = data?.choices?.[0]?.message?.content?.trim();
                if (reply) return reply;
            } catch (err) {
                clearTimeout(timeout);
                modelCooldowns.set(cfg.name, Date.now() + 20000);
                continue;
            }
        }
    } finally {
        activeAiCount--;
    }
    return null;
}

// =====================================================================
// 5. WHATSAPP CLIENT (LOW-RAM PUPPETEER SETUP)
// =====================================================================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n📱 SCAN THIS QR CODE IN WHATSAPP (Linked Devices):\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Selective 8-AI & Full Control Userbot Ready!');
});

// =====================================================================
// 6. REMOTE TARGET & GROUP RESOLVERS
// =====================================================================
function normalizeNumber(raw) {
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    return digits ? `${digits}@c.us` : null;
}

async function resolveTargetUser(msg, query) {
    if (msg.hasQuotedMsg && !query) {
        const quoted = await msg.getQuotedMessage();
        return quoted.author || quoted.from;
    }
    const mentions = await msg.getMentions();
    if (mentions && mentions.length > 0) return mentions[0].id._serialized;

    const cleanNum = query.replace(/[@\s+-]/g, '');
    if (/^\d{10,15}$/.test(cleanNum)) return normalizeNumber(cleanNum);

    const contacts = await client.getContacts();
    const search = query.replace(/^@/, '').toLowerCase().trim();
    if (!search) return null;
    const found = contacts.find(c =>
        (c.name && c.name.toLowerCase().includes(search)) ||
        (c.pushname && c.pushname.toLowerCase().includes(search))
    );
    return found ? found.id._serialized : null;
}

async function resolveGroup(groupQuery) {
    const chats = await client.getChats();
    const search = groupQuery.replace(/^@/, '').toLowerCase().trim();
    if (!search) return null;
    const group = chats.find(c => c.isGroup && c.name.toLowerCase().includes(search));
    return group ? { id: group.id._serialized, name: group.name, chatObj: group } : null;
}

async function parseUserAndGroup(msg, arg, currentChat) {
    let targetGroupId = currentChat.isGroup ? currentChat.id._serialized : 'GLOBAL';
    let targetGroupName = currentChat.isGroup ? currentChat.name : 'All Groups';
    let userPart = arg;

    const atMatches = arg.match(/@[^@]+/g);
    if (atMatches && atMatches.length >= 2) {
        const potentialGroup = atMatches[atMatches.length - 1].trim();
        const grp = await resolveGroup(potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, arg.lastIndexOf(potentialGroup)).trim();
        }
    } else if (arg.includes('@') && !arg.startsWith('@')) {
        const splitIdx = arg.indexOf('@');
        const potentialGroup = arg.slice(splitIdx).trim();
        const grp = await resolveGroup(potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, splitIdx).trim();
        }
    }
    const targetUserId = await resolveTargetUser(msg, userPart);
    return { targetUserId, targetGroupId, targetGroupName };
}

// =====================================================================
// 7. CONTINUOUS NAME CHANGER (NC) ENGINE
// =====================================================================
function startNcLoop(chatObj, chatId, titles) {
    stopNcLoop(chatId);
    let idx = 0;
    const interval = setInterval(async () => {
        try {
            const nextTitle = titles[idx % titles.length];
            idx++;
            await chatObj.setSubject(nextTitle);
        } catch (e) {
            stopNcLoop(chatId);
        }
    }, 4000);
    ncIntervals.set(chatId, interval);
}

function stopNcLoop(chatId) {
    if (ncIntervals.has(chatId)) {
        clearInterval(ncIntervals.get(chatId));
        ncIntervals.delete(chatId);
    }
}

// =====================================================================
// 8. UNIFIED MESSAGE & REMOTE COMMAND HANDLER
// =====================================================================
client.on('message_create', async (msg) => {
    const text = (msg.body || '').trim();
    const chat = await msg.getChat();
    const chatId = chat.id._serialized;

    if (msg.fromMe) {
        if (!text.startsWith('*')) {
            const shouldPin = (state.pinAll && !state.pinExempts.includes(chatId)) || state.pinChats.includes(chatId);
            if (shouldPin && typeof msg.pin === 'function') {
                msg.pin(604800).catch(() => {});
            }
            return;
        }

        const cmd = text.slice(1).trim();
        const cl = cmd.toLowerCase();

        const fb = async (replyText, autoDel = true) => {
            try {
                const sent = await msg.reply(replyText);
                if (autoDel) setTimeout(() => sent.delete(true).catch(() => {}), 4500);
            } catch (e) {}
        };

        // --- HELP ---
        if (['help', 'commands', 'cmds'].includes(cl)) {
            return await fb(
                `📋 *WHATSAPP SELECTIVE 8-AI USERBOT COMMANDS*\n\n` +
                `🤖 *Selective 8-Model AI (Run from ANY chat):*\n` +
                `• \`*ai on\` / \`*ai off\` ➔ Current chat me AI reply ON/OFF\n` +
                `• \`*ai on 9876543210\` ➔ Specific DM me AI reply ON\n` +
                `• \`*ai off 9876543210\` ➔ Specific DM me AI reply OFF\n` +
                `• \`*ai on @GroupName\` ➔ Specific Group me AI reply ON\n` +
                `• \`*ai off @GroupName\` ➔ Specific Group me AI reply OFF\n` +
                `• \`*target ai @user/num [@group]\` ➔ Target ke liye AI ON\n` +
                `• \`*stop target ai @user/num [@group]\` ➔ Target ke liye AI OFF\n` +
                `• \`*ai all on\` / \`*ai all off\` ➔ Global AI ON/OFF\n` +
                `• \`*aiprompt <text>\` ➔ Change AI behavior\n` +
                `• \`*aistatus\` ➔ Active AI chats, models & RAM\n\n` +
                `🎯 *Normal 5-Slot Target & Chat Replies:*\n` +
                `• \`*target reply @user/num [@group]\` / \`*stop target reply...\`\n` +
                `• \`*reply [num/name]\` / \`*stop reply [num/name]\`\n` +
                `• \`*reply all [@group]\` / \`*reply all dm\`\n` +
                `• \`*gcmsgs\` / \`*dmmsgs\` / \`*setgc 1-5\` / \`*setdm 1-5\`\n\n` +
                `🔇 *Mute, Lock, NC & Pin:*\n` +
                `• \`*mute\` / \`*unmute\` / \`*muteall\` / \`*mutegc\` / \`*lock\` / \`*lockall\`\n` +
                `• \`*target mute @user [@group]\` / \`*target lock @user [@group]\`\n` +
                `• \`*nc [n1 | n2]\` / \`*stopnc\` / \`*pin\` / \`*pinall\`\n` +
                `• \`*status\` / \`*stopall\``,
                false
            );
        }

        // --- GLOBAL AI ALL ON/OFF ---
        if (cl === 'ai all on' || cl === 'aiall on') {
            state.aiGlobalAll = true;
            saveSettings();
            return await fb('🤖 *Global AI ON* (Sabhi active reply chats me AI reply jayega)');
        }
        if (cl === 'ai all off' || cl === 'aiall off') {
            state.aiGlobalAll = false;
            saveSettings();
            return await fb('🛑 *Global AI OFF* (Ab AI sirf selected chats/targets me chalega)');
        }

        // --- TARGET AI ---
        if (cl.startsWith('target ai') || cl.startsWith('stop target ai')) {
            const isStop = cl.startsWith('stop');
            const arg = cmd.replace(/^(stop\s+)?target\s+ai\s*/i, '').trim();
            const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(msg, arg, chat);
            if (!targetUserId) return await fb('⚠️ Target user nahi mila! Number ya @naam check karein.');

            if (!state.aiTargets[targetGroupId]) state.aiTargets[targetGroupId] = [];
            if (isStop) {
                state.aiTargets[targetGroupId] = state.aiTargets[targetGroupId].filter(id => id !== targetUserId);
                saveSettings();
                return await fb(`🛑 *Target AI OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
            } else {
                if (!state.aiTargets[targetGroupId].includes(targetUserId)) {
                    state.aiTargets[targetGroupId].push(targetUserId);
                }
                saveSettings();
                return await fb(`🤖 *Target AI ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
            }
        }

        // --- SELECTIVE CHAT AI ---
        if (cl === 'ai on' || cl.startsWith('ai on ') || cl === 'ai off' || cl.startsWith('ai off ') || cl === 'aion' || cl === 'aioff') {
            const isOff = cl.startsWith('ai off') || cl === 'aioff';
            const arg = cmd.replace(/^(ai\s+on|ai\s+off|aion|aioff)\s*/i, '').trim();

            let targetChatId = null;
            let targetLabel = '';

            if (!arg) {
                targetChatId = chatId;
                targetLabel = chat.isGroup ? chat.name : (chat.name || chatId.split('@')[0]);
            } else if (arg.startsWith('@')) {
                const grp = await resolveGroup(arg);
                if (grp) {
                    targetChatId = grp.id;
                    targetLabel = `Group: ${grp.name}`;
                } else {
                    const usr = await resolveTargetUser(msg, arg);
                    if (usr) {
                        targetChatId = usr;
                        targetLabel = `DM: ${usr.split('@')[0]}`;
                    }
                }
            } else {
                const usr = await resolveTargetUser(msg, arg);
                if (usr) {
                    targetChatId = usr;
                    targetLabel = `DM: ${usr.split('@')[0]}`;
                } else {
                    const grp = await resolveGroup(arg);
                    if (grp) {
                        targetChatId = grp.id;
                        targetLabel = `Group: ${grp.name}`;
                    }
                }
            }

            if (!targetChatId) return await fb(`⚠️ Chat ya Number "${arg}" nahi mila!`);

            if (isOff) {
                state.aiChats = state.aiChats.filter(id => id !== targetChatId);
                saveSettings();
                return await fb(`🛑 *AI Reply OFF* for *${targetLabel}*`);
            } else {
                if (!state.aiChats.includes(targetChatId)) state.aiChats.push(targetChatId);
                saveSettings();
                return await fb(`🤖 *AI Reply ON* for *${targetLabel}*`);
            }
        }

        // --- AI PROMPT & STATUS ---
        if (cl.startsWith('aiprompt ')) {
            state.aiSystemPrompt = cmd.slice(9).trim();
            saveSettings();
            return await fb('✅ *AI System Prompt Updated!*');
        }
        if (cl === 'aistatus') {
            const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
            const activeKeys = Object.entries(API_KEYS).filter(([_, v]) => v).map(([k]) => k).join(', ') || 'None';
            const totalTargetAi = Object.values(state.aiTargets).reduce((acc, arr) => acc + arr.length, 0);
            return await fb(
                `🤖 *SELECTIVE AI STATUS*\n` +
                `• Global AI Mode: ${state.aiGlobalAll ? '🟢 ON (All)' : '🟡 SELECTIVE ONLY'}\n` +
                `• AI Enabled Chats (DM/GC): ${state.aiChats.length}\n` +
                `• AI Enabled Targets: ${totalTargetAi}\n` +
                `• Active API Providers: ${activeKeys}\n` +
                `• RAM Usage: ${mem} MB / 512 MB`,
                false
            );
        }

        // --- 5-SLOT MESSAGES ---
        if (cl === 'gcmsgs') return await fb(`👥 *5 GC REPLIES:*\n${state.gcReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false);
        if (cl === 'dmmsgs') return await fb(`💬 *5 DM REPLIES:*\n${state.dmReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false);
        if (cl.startsWith('setgc ')) {
            const parts = cmd.split(/\s+/);
            const s = parseInt(parts[1]);
            if (s >= 1 && s <= 5 && parts.length >= 3) {
                state.gcReplies[s - 1] = cmd.replace(/^setgc\s+\d+\s+/i, '');
                saveSettings();
                return await fb(`✅ GC Slot #${s} updated`);
            }
        }
        if (cl.startsWith('setdm ')) {
            const parts = cmd.split(/\s+/);
            const s = parseInt(parts[1]);
            if (s >= 1 && s <= 5 && parts.length >= 3) {
                state.dmReplies[s - 1] = cmd.replace(/^setdm\s+\d+\s+/i, '');
                saveSettings();
                return await fb(`✅ DM Slot #${s} updated`);
            }
        }

        // --- NORMAL TARGET REPLY ---
        if (cl.startsWith('target reply') || cl.startsWith('stop target reply')) {
            const isStop = cl.startsWith('stop');
            const arg = cmd.replace(/^(stop\s+)?target\s+reply\s*/i, '').trim();
            const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(msg, arg, chat);
            if (!targetUserId) return await fb('⚠️ Target user nahi mila!');

            if (!state.targetReplies[targetGroupId]) state.targetReplies[targetGroupId] = [];
            if (isStop) {
                state.targetReplies[targetGroupId] = state.targetReplies[targetGroupId].filter(id => id !== targetUserId);
                saveSettings();
                return await fb(`🛑 *Target Reply OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
            } else {
                if (!state.targetReplies[targetGroupId].includes(targetUserId)) state.targetReplies[targetGroupId].push(targetUserId);
                saveSettings();
                return await fb(`🎯 *Target Reply ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
            }
        }

        // --- TARGET MUTE / LOCK / NC ---
        const targetMap = [
            { prefix: 'target mute', dict: 'targetMutes', label: 'Target Mute' },
            { prefix: 'target lock', dict: 'targetLocks', label: 'Target Lock' },
            { prefix: 'target nc reply', dict: 'targetNcReply', label: 'Target NC Reply' },
            { prefix: 'target nc mute', dict: 'targetNcMute', label: 'Target NC Mute' },
            { prefix: 'target nc lock', dict: 'targetNcLock', label: 'Target NC Lock' }
        ];
        for (const item of targetMap) {
            if (cl.startsWith(item.prefix) || cl.startsWith(`stop ${item.prefix}`)) {
                const isStop = cl.startsWith('stop');
                const arg = cmd.replace(new RegExp(`^(stop\\s+)?${item.prefix}\\s*`, 'i'), '').trim();
                const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(msg, arg, chat);
                if (!targetUserId) return await fb('⚠️ Target user nahi mila!');

                if (!state[item.dict][targetGroupId]) state[item.dict][targetGroupId] = [];
                if (isStop) {
                    state[item.dict][targetGroupId] = state[item.dict][targetGroupId].filter(id => id !== targetUserId);
                    saveSettings();
                    return await fb(`🛑 *${item.label} OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                } else {
                    if (!state[item.dict][targetGroupId].includes(targetUserId)) state[item.dict][targetGroupId].push(targetUserId);
                    saveSettings();
                    return await fb(`🎯 *${item.label} ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                }
            }
        }

        // --- REPLY ALL (DM & GROUP) ---
        if (cl.startsWith('reply all') || cl.startsWith('stop reply all')) {
            const isStop = cl.startsWith('stop');
            const arg = cmd.replace(/^(stop\s+)?reply\s+all\s*/i, '').trim();

            if (arg.toLowerCase() === 'dm' || arg.toLowerCase() === 'dms') {
                state.replyAllDms = !isStop;
                saveSettings();
                return await fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
            }
            if (arg.length > 0) {
                const grp = await resolveGroup(arg);
                if (!grp) return await fb(`⚠️ Group "${arg}" nahi mila!`);
                state.replyGcs = isStop ? state.replyGcs.filter(id => id !== grp.id) : [...new Set([...state.replyGcs, grp.id])];
                saveSettings();
                return await fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}* in *${grp.name}*`);
            }
            if (chat.isGroup) {
                state.replyGcs = isStop ? state.replyGcs.filter(id => id !== chatId) : [...new Set([...state.replyGcs, chatId])];
                saveSettings();
                return await fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}* in *${chat.name}*`);
            } else {
                state.replyAllDms = !isStop;
                saveSettings();
                return await fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
            }
        }

        // --- NORMAL DM REPLY ---
        if (cl === 'reply' || cl.startsWith('reply ') || cl === 'stop reply' || cl.startsWith('stop reply ')) {
            const isStop = cl.startsWith('stop');
            const arg = cmd.replace(/^(stop\s+)?reply\s*/i, '').trim();
            let targetDmId = arg ? await resolveTargetUser(msg, arg) : (!chat.isGroup ? chatId : null);
            if (!targetDmId) return await fb('⚠️ DM user nahi mila! Number likhein: `*reply 9876543210`');

            state.replyDms = isStop ? state.replyDms.filter(id => id !== targetDmId) : [...new Set([...state.replyDms, targetDmId])];
            saveSettings();
            return await fb(`${isStop ? '🛑' : '✅'} *DM Reply ${isStop ? 'OFF' : 'ON'}* for \`${targetDmId.split('@')[0]}\``);
        }

        // --- CONTINUOUS NAME CHANGER ---
        if (cl === 'stopnc' || cl === 'stop nc' || cl === 'unnc') {
            stopNcLoop(chatId);
            return await fb('🛑 *Continuous NC Stopped*');
        }
        if (cl === 'nc' || cl.startsWith('nc ')) {
            if (!chat.isGroup) return await fb('⚠️ `*nc` sirf Group me kaam karta hai!');
            const raw = cmd.slice(2).trim();
            const titles = raw ? raw.split(/[|\n,]+/).map(s => s.trim()).filter(Boolean) : state.ncTitles;
            startNcLoop(chat, chatId, titles);
            return await fb(`🚀 *Auto-NC Started* (${titles.length} titles rotating every 4s)`);
        }

        // --- MUTE & LOCK ---
        if (cl === 'muteall' || cl === 'stop muteall') {
            state.muteAllDms = (cl === 'muteall');
            if (!state.muteAllDms) state.unmuteExempts = [];
            saveSettings();
            return await fb(state.muteAllDms ? '🔒 *Global DM Mute ON*' : '🔓 *Global DM Mute OFF*');
        }
        if (['mute', 'unmute', 'stop mute', 'mutegc', 'stop mutegc', 'unmutegc'].includes(cl)) {
            const isStop = cl.includes('un') || cl.includes('stop');
            if (isStop) {
                state.muteChats = state.muteChats.filter(id => id !== chatId);
                if (!state.unmuteExempts.includes(chatId)) state.unmuteExempts.push(chatId);
            } else {
                if (!state.muteChats.includes(chatId)) state.muteChats.push(chatId);
                state.unmuteExempts = state.unmuteExempts.filter(id => id !== chatId);
            }
            saveSettings();
            return await fb(isStop ? '🛑 *Mute OFF*' : '🔇 *Mute ON* (Auto-deleting incoming)');
        }
        if (['lock', 'unlock', 'stop lock', 'lockall', 'unlockall', 'stop lockall'].includes(cl)) {
            const isStop = cl.includes('un') || cl.includes('stop');
            state.lockChats = isStop ? state.lockChats.filter(id => id !== chatId) : [...new Set([...state.lockChats, chatId])];
            saveSettings();
            return await fb(isStop ? '🛑 *Lock OFF*' : '🛡️ *Lock ON*');
        }

        // --- PIN ---
        if (cl === 'pinall' || cl === 'stop pinall' || cl === 'unpinall') {
            state.pinAll = (cl === 'pinall');
            saveSettings();
            return await fb(state.pinAll ? '📌 *Global Auto-Pin ON*' : '🛑 *Global Auto-Pin OFF*');
        }
        if (cl === 'pin except' || cl === 'stop pin except') {
            const isStop = cl.startsWith('stop');
            state.pinExempts = isStop ? state.pinExempts.filter(id => id !== chatId) : [...new Set([...state.pinExempts, chatId])];
            saveSettings();
            return await fb(isStop ? '🛑 *Pin Exception OFF*' : '🛡️ *Pin Exception ON*');
        }
        if (['pin', 'pin on', 'stop pin', 'unpin', 'pin off'].includes(cl)) {
            const isStop = cl.includes('stop') || cl.includes('un') || cl.includes('off');
            state.pinChats = isStop ? state.pinChats.filter(id => id !== chatId) : [...new Set([...state.pinChats, chatId])];
            saveSettings();
            return await fb(isStop ? '🛑 *Auto-Pin OFF*' : '📌 *Auto-Pin ON*');
        }

        // --- STOPALL & STATUS ---
        if (cl === 'stopall' || cl === 'stop all') {
            stopNcLoop(chatId);
            state.aiChats = state.aiChats.filter(id => id !== chatId);
            state.replyGcs = state.replyGcs.filter(id => id !== chatId);
            state.replyDms = state.replyDms.filter(id => id !== chatId);
            state.muteChats = state.muteChats.filter(id => id !== chatId);
            state.lockChats = state.lockChats.filter(id => id !== chatId);
            state.pinChats = state.pinChats.filter(id => id !== chatId);
            delete state.aiTargets[chatId];
            delete state.targetReplies[chatId];
            delete state.targetMutes[chatId];
            delete state.targetLocks[chatId];
            saveSettings();
            return await fb('🛑 *All rules, AI & NC cleared for this chat.*');
        }
        if (cl === 'status') {
            const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
            const hasAiHere = state.aiGlobalAll || state.aiChats.includes(chatId) || (state.aiTargets[chatId] || []).length > 0;
            return await fb(
                `⚙️ *CHAT & BOT STATUS*\n` +
                `• AI Reply Here: ${hasAiHere ? '🟢 ON' : '🔴 OFF'}\n` +
                `• 5-Slot Reply Here: ${(state.replyGcs.includes(chatId) || state.replyDms.includes(chatId) || (!chat.isGroup && state.replyAllDms)) ? '🟢 ON' : '🔴 OFF'}\n` +
                `• Mute/Lock: ${(state.muteChats.includes(chatId) || state.lockChats.includes(chatId)) ? '🟢 ON' : '🔴 OFF'}\n` +
                `• Continuous NC: ${ncIntervals.has(chatId) ? '🟢 ON' : '🔴 OFF'}\n` +
                `• Auto-Pin: ${state.pinChats.includes(chatId) || state.pinAll ? '🟢 ON' : '🔴 OFF'}\n` +
                `• RAM Usage: ${mem} MB / 512 MB`,
                false
            );
        }
        return;
    }

    // -----------------------------------------------------------------
    // B. INCOMING MESSAGES
    // -----------------------------------------------------------------
    if (msg.isStatus) return;
    const senderId = chat.isGroup ? msg.author : chatId;
    if (!senderId) return;

    const isMutedOrLocked =
        state.lockChats.includes(chatId) ||
        state.muteChats.includes(chatId) ||
        (!chat.isGroup && state.muteAllDms && !state.unmuteExempts.includes(chatId)) ||
        (state.targetMutes[chatId] || []).includes(senderId) ||
        (state.targetMutes['GLOBAL'] || []).includes(senderId) ||
        (state.targetLocks[chatId] || []).includes(senderId) ||
        (state.targetLocks['GLOBAL'] || []).includes(senderId) ||
        (state.targetNcMute[chatId] || []).includes(senderId) ||
        (state.targetNcLock[chatId] || []).includes(senderId);

    if (isMutedOrLocked) {
        if (chat.isGroup && (state.targetNcMute[chatId] || []).includes(senderId)) {
            chat.setSubject(`🚫 MUTED: ${senderId.split('@')[0]}`).catch(() => {});
        }
        msg.delete(true).catch(() => {});
        return;
    }

    const isTargetNcReply = chat.isGroup && (state.targetNcReply[chatId] || []).includes(senderId);

    const isAiEnabledForThis =
        state.aiGlobalAll ||
        state.aiChats.includes(chatId) ||
        (state.aiTargets[chatId] || []).includes(senderId) ||
        (state.aiTargets['GLOBAL'] || []).includes(senderId);

    let isNormalReplyEnabled = false;
    if (chat.isGroup) {
        isNormalReplyEnabled =
            state.replyAllGcs ||
            state.replyGcs.includes(chatId) ||
            (state.targetReplies[chatId] || []).includes(senderId) ||
            (state.targetReplies['GLOBAL'] || []).includes(senderId) ||
            isTargetNcReply;
    } else {
        isNormalReplyEnabled = state.replyAllDms || state.replyDms.includes(chatId);
    }

    if (!isAiEnabledForThis && !isNormalReplyEnabled) return;

    const coolKey = `${chatId}_${senderId}`;
    const now = Date.now();
    if (now - (lastReplyTime.get(coolKey) || 0) < COOLDOWN_MS) return;
    lastReplyTime.set(coolKey, now);

    try {
        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || contact.id.user;
        const tagText = `@${contact.id.user}`;

        let finalReplyText = null;

        if (isAiEnabledForThis && text.length > 0) {
            finalReplyText = await generateAIReply(text, senderName, chat.isGroup);
        }

        if (!finalReplyText) {
            if (chat.isGroup) {
                const idx = gcIndex.get(chatId) || 0;
                finalReplyText = state.gcReplies[idx % state.gcReplies.length];
                gcIndex.set(chatId, (idx + 1) % state.gcReplies.length);
            } else {
                const idx = dmIndex.get(chatId) || 0;
                finalReplyText = state.dmReplies[idx % state.dmReplies.length];
                dmIndex.set(chatId, (idx + 1) % state.dmReplies.length);
            }
        }

        if (isTargetNcReply) {
            chat.setSubject(`🎯 ALERT: ${senderName.slice(0, 18)}`).catch(() => {});
        }

        if (chat.isGroup) {
            await chat.sendMessage(`${tagText} ${finalReplyText}`, { mentions: [contact] });
        } else {
            await msg.reply(`${tagText} ${finalReplyText}`, undefined, { mentions: [contact] });
        }
    } catch (err) {
        console.error('Reply error:', err.message);
    }
});

client.initialize();
