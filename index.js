const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');

// =====================================================================
// 1. RENDER HTTP HEALTH SERVER + SLIM SESSION PERSISTENCE
// =====================================================================
const app = express();
const PORT = process.env.PORT || 10000;
const AUTH_DIR = './auth_info';

let latestQrPngBuffer = null;
let isWaConnected = false;

function restoreSessionFromEnv() {
    const b64 = process.env.WA_SESSION_B64;
    if (!b64) return false;
    try {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed['creds.json']) {
            fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), parsed['creds.json'], 'utf8');
        } else {
            fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), decoded, 'utf8');
        }
        console.log('♻️ Restored WhatsApp session from WA_SESSION_B64!');
        return true;
    } catch (e) {
        console.error('⚠️ Failed to restore WA_SESSION_B64:', e.message);
        return false;
    }
}

function exportSessionToBase64() {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    try {
        const credsContent = fs.readFileSync(credsPath, 'utf8');
        return Buffer.from(JSON.stringify({ 'creds.json': credsContent })).toString('base64');
    } catch (e) {
        return null;
    }
}

restoreSessionFromEnv();

const API_KEYS = {
    GROQ: process.env.GROQ_API_KEY || "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",
    OPENROUTER: process.env.OPENROUTER_API_KEY || "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",
    HUGGINGFACE: process.env.HF_API_KEY || "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"
};

// VERIFIED 8 ACTIVE MODELS (3 Groq + 3 OpenRouter + 2 Hugging Face)
const AI_MODELS = [
    { name: "1. Groq Llama-3.1-8B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.1-8b-instant" },
    { name: "2. OpenRouter Auto-Free", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "openrouter/free" },
    { name: "3. HF Qwen-2.5-72B", provider: "HUGGINGFACE", url: "https://router.huggingface.co/v1/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct" },
    { name: "4. Groq Llama-3.3-70B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    { name: "5. OpenRouter Llama-3.3-70B", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free" },
    { name: "6. HF Llama-3.1-8B", provider: "HUGGINGFACE", url: "https://router.huggingface.co/v1/chat/completions", model: "meta-llama/Llama-3.1-8B-Instruct" },
    { name: "7. Groq Llama-4-Scout", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "meta-llama/llama-4-scout-17b-16e-instruct" },
    { name: "8. OpenRouter Mistral-Small", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "mistralai/mistral-small-3.1-24b-instruct:free" }
];

const modelCooldowns = new Map();
let activeAiCount = 0;
let lastAiModelUsed = "None yet";
let lastAiError = "None";
const MAX_CONCURRENT_AI = 3;

app.get('/', (req, res) => {
    const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
    res.status(200).json({
        status: 'healthy',
        whatsapp_connected: isWaConnected,
        last_ai_model: lastAiModelUsed,
        last_ai_error: lastAiError,
        ram_usage_mb: `${memUsage} MB`,
        uptime_sec: Math.floor(process.uptime())
    });
});

app.get('/session', (req, res) => {
    if (!isWaConnected) {
        return res.status(400).send('<h3>⚠️ Pehle /qr par jaakar WhatsApp scan karein, phir refresh karein.</h3>');
    }
    const b64 = exportSessionToBase64();
    if (!b64) return res.status(500).send('Session export failed.');
    res.send(`
        <html>
        <body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;">
            <h3>🔑 Permanent Session Key (WA_SESSION_B64)</h3>
            <p style="color:#aaa;font-size:13px;">Is string ko copy karke Render Dashboard &rarr; Environment &rarr; <b>WA_SESSION_B64</b> me save kar dein:</p>
            <textarea id="s" rows="8" style="width:100%;background:#222;color:#0f0;border:1px solid #444;padding:10px;border-radius:6px;" readonly>${b64}</textarea>
            <br><br>
            <button onclick="navigator.clipboard.writeText(document.getElementById('s').value);alert('Copied!')" style="padding:10px 18px;background:#25D366;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">📋 Copy Session String</button>
        </body>
        </html>
    `);
});

app.get('/qr.png', (req, res) => {
    if (!latestQrPngBuffer) return res.status(404).send('QR not available.');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(latestQrPngBuffer);
});

app.get('/qr', (req, res) => {
    if (isWaConnected) {
        return res.send(`
            <html><body style="background:#111;color:#0f0;font-family:sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center;">
                <h2>✅ WhatsApp Connected!</h2>
                <p style="color:#ccc;">Ab <a href="/session" style="color:#25D366;">/session</a> khol kar WA_SESSION_B64 Render me save karein.</p>
            </body></html>
        `);
    }
    if (!latestQrPngBuffer) {
        return res.send(`
            <html><head><meta http-equiv="refresh" content="3"></head>
            <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
                <p>⏳ Generating QR Photo... Refreshing in 3s</p>
            </body></html>
        `);
    }
    res.send(`
        <html>
        <head><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center;">
            <p style="margin-bottom:10px;font-size:15px;">📱 Scan with WhatsApp Linked Devices</p>
            <div style="background:#fff;padding:12px;border-radius:10px;display:inline-block;">
                <img src="/qr.png?t=${Date.now()}" style="width:180px;height:180px;display:block;" />
            </div>
        </body>
        </html>
    `);
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
const groupCache = new Map();
const lidToPhoneMap = new Map(); // Maps WhatsApp @lid JIDs to @s.whatsapp.net
let lastGroupSync = 0;
const COOLDOWN_MS = 2000;

// =====================================================================
// 3. 30-SECOND RAM & GARBAGE CLEANER
// =====================================================================
setInterval(() => {
    const now = Date.now();
    for (const [k, t] of lastReplyTime.entries()) {
        if (now - t > 30000) lastReplyTime.delete(k);
    }
    for (const [m, exp] of modelCooldowns.entries()) {
        if (now > exp) modelCooldowns.delete(m);
    }
    if (gcIndex.size > 200) gcIndex.clear();
    if (dmIndex.size > 200) dmIndex.clear();
    if (groupCache.size > 300) groupCache.clear();
    if (lidToPhoneMap.size > 500) lidToPhoneMap.clear();
    if (global.gc) {
        try { global.gc(); } catch (e) {}
    }
}, 30000);

// =====================================================================
// 4. 8-MODEL TRI-PROVIDER FALLBACK GENERATOR (8s TIMEOUT + ERROR LOGGING)
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
            const timeout = setTimeout(() => controller.abort(), 8000); // 8s reliable timeout

            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            };
            if (cfg.provider === 'OPENROUTER') {
                headers['HTTP-Referer'] = 'https://render.com';
                headers['X-Title'] = 'WA-Userbot';
            }

            try {
                const response = await fetch(cfg.url, {
                    method: 'POST',
                    headers,
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
                    lastAiError = `${cfg.name}: Rate/Quota (${response.status})`;
                    modelCooldowns.set(cfg.name, Date.now() + 60000);
                    continue;
                }
                if (!response.ok) {
                    const errTxt = await response.text().catch(() => '');
                    lastAiError = `${cfg.name}: HTTP ${response.status} ${errTxt.slice(0, 60)}`;
                    modelCooldowns.set(cfg.name, Date.now() + 30000);
                    continue;
                }

                const data = await response.json();
                const reply = data?.choices?.[0]?.message?.content?.trim();
                if (reply) {
                    lastAiModelUsed = cfg.name;
                    lastAiError = "None";
                    return reply;
                }
            } catch (err) {
                clearTimeout(timeout);
                lastAiError = `${cfg.name}: ${err.name === 'AbortError' ? 'Timeout' : err.message}`;
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
// 5. UNIVERSAL JID / LID / PHONE MATCHER & RESOLVERS
// =====================================================================
function normalizeJid(raw) {
    if (!raw) return null;
    if (raw.endsWith('@lid')) return raw;
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    return digits ? `${digits}@s.whatsapp.net` : null;
}

// Checks if incoming senderId (could be @lid or @s.whatsapp.net) matches any saved ID in list
function matchesUserList(list, senderId, msg) {
    if (!Array.isArray(list) || list.length === 0) return false;
    if (list.includes(senderId)) return true;

    const senderDigits = senderId.split('@')[0].split(':')[0];
    const mappedPhone = lidToPhoneMap.get(senderId);
    const mappedDigits = mappedPhone ? mappedPhone.split('@')[0] : null;
    const altPn = msg?.key?.participantAlt || msg?.key?.remoteJidAlt || '';
    const altDigits = altPn ? altPn.split('@')[0].split(':')[0] : null;

    for (const saved of list) {
        const savedDigits = saved.split('@')[0].split(':')[0];
        if (savedDigits === senderDigits) return true;
        if (mappedDigits && savedDigits === mappedDigits) return true;
        if (altDigits && savedDigits === altDigits) return true;
    }
    return false;
}

function extractText(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
}

function getMentionedJid(msg) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned && mentioned.length > 0) return mentioned[0];
    const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (participant) return participant;
    return null;
}

function resolveTargetUser(msg, query) {
    const mentioned = getMentionedJid(msg);
    if (mentioned) return mentioned;
    const cleanNum = query.replace(/[@\s+-]/g, '');
    if (/^\d{10,15}$/.test(cleanNum)) return normalizeJid(cleanNum);
    return null;
}

async function resolveGroupFast(sock, groupQuery) {
    const search = groupQuery.replace(/^@/, '').toLowerCase().trim();
    if (!search) return null;

    for (const [jid, name] of groupCache.entries()) {
        if (name.toLowerCase().includes(search)) return { id: jid, name };
    }

    if (Date.now() - lastGroupSync > 120000) {
        lastGroupSync = Date.now();
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, meta] of Object.entries(groups)) {
                if (meta.subject) groupCache.set(jid, meta.subject);
                if (Array.isArray(meta.participants)) {
                    for (const p of meta.participants) {
                        if (p.id && p.phoneNumber) lidToPhoneMap.set(p.id, p.phoneNumber);
                        if (p.lid && p.id) lidToPhoneMap.set(p.lid, p.id);
                    }
                }
            }
            for (const [jid, name] of groupCache.entries()) {
                if (name.toLowerCase().includes(search)) return { id: jid, name };
            }
        } catch (e) {}
    }
    return null;
}

async function parseUserAndGroup(sock, msg, arg, chatId, isGroup) {
    let targetGroupId = isGroup ? chatId : 'GLOBAL';
    let targetGroupName = isGroup ? (groupCache.get(chatId) || 'Current Group') : 'All Groups';
    let userPart = arg;

    const atMatches = arg.match(/@[^@]+/g);
    if (atMatches && atMatches.length >= 2) {
        const potentialGroup = atMatches[atMatches.length - 1].trim();
        const grp = await resolveGroupFast(sock, potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, arg.lastIndexOf(potentialGroup)).trim();
        }
    } else if (arg.includes('@') && !arg.startsWith('@')) {
        const splitIdx = arg.indexOf('@');
        const potentialGroup = arg.slice(splitIdx).trim();
        const grp = await resolveGroupFast(sock, potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, splitIdx).trim();
        }
    }
    const targetUserId = resolveTargetUser(msg, userPart);
    return { targetUserId, targetGroupId, targetGroupName };
}

function startNcLoop(sock, chatId, titles) {
    stopNcLoop(chatId);
    let idx = 0;
    const interval = setInterval(async () => {
        try {
            const nextTitle = titles[idx % titles.length];
            idx++;
            await sock.groupUpdateSubject(chatId, nextTitle);
        } catch (e) {
            stopNcLoop(chatId);
        }
    }, 4500);
    ncIntervals.set(chatId, interval);
}

function stopNcLoop(chatId) {
    if (ncIntervals.has(chatId)) {
        clearInterval(ncIntervals.get(chatId));
        ncIntervals.delete(chatId);
    }
}

// =====================================================================
// 6. START BAILEYS WHATSAPP SOCKET
// =====================================================================
let isStarting = false;

async function startWhatsAppBot() {
    if (isStarting) return;
    isStarting = true;

    try {
        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: authState,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('groups.update', (updates) => {
            for (const g of updates) {
                if (g.id && g.subject) groupCache.set(g.id, g.subject);
            }
        });

        sock.ev.on('contacts.upsert', (contacts) => {
            for (const c of contacts) {
                if (c.lid && c.id) lidToPhoneMap.set(c.lid, c.id);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                isWaConnected = false;
                try {
                    latestQrPngBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 180, margin: 1 });
                    console.log('📸 QR Ready! Open Render URL + /qr to scan.');
                } catch (e) {}
            }
            if (connection === 'close') {
                isWaConnected = false;
                isStarting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Disconnected (Code: ${statusCode}). Reconnecting in 5s...`);
                if (statusCode === DisconnectReason.loggedOut && fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                setTimeout(startWhatsAppBot, 5000);
            } else if (connection === 'open') {
                isWaConnected = true;
                isStarting = false;
                latestQrPngBuffer = null;
                console.log('✅ WhatsApp Connected & Ready!');
                setTimeout(async () => {
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        for (const [jid, meta] of Object.entries(groups)) {
                            if (meta.subject) groupCache.set(jid, meta.subject);
                            if (Array.isArray(meta.participants)) {
                                for (const p of meta.participants) {
                                    if (p.id && p.phoneNumber) lidToPhoneMap.set(p.id, p.phoneNumber);
                                    if (p.lid && p.id) lidToPhoneMap.set(p.lid, p.id);
                                }
                            }
                        }
                        lastGroupSync = Date.now();
                    } catch (e) {}
                }, 2500);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

                const chatId = msg.key.remoteJid;
                const isGroup = chatId.endsWith('@g.us');
                const fromMe = Boolean(msg.key.fromMe);
                const senderId = isGroup ? (msg.key.participant || chatId) : chatId;
                const text = extractText(msg);

                // Learn LID <-> Phone mapping automatically from message metadata
                if (msg.key.participant && msg.key.participantAlt) {
                    lidToPhoneMap.set(msg.key.participant, msg.key.participantAlt);
                }
                if (msg.key.remoteJid && msg.key.remoteJidAlt) {
                    lidToPhoneMap.set(msg.key.remoteJid, msg.key.remoteJidAlt);
                }

                // ---------------------------------------------------------
                // A. OUTGOING COMMANDS
                // ---------------------------------------------------------
                if (fromMe) {
                    if (!text.startsWith('*')) {
                        const shouldPin = (state.pinAll && !state.pinExempts.includes(chatId)) || state.pinChats.includes(chatId);
                        if (shouldPin) {
                            sock.sendMessage(chatId, { pin: msg.key, type: 1, time: 604800 }).catch(() => {});
                        }
                        continue;
                    }

                    const cmd = text.slice(1).trim();
                    const cl = cmd.toLowerCase();

                    const fb = (replyText, autoDel = true) => {
                        sock.sendMessage(chatId, { text: replyText }, { quoted: msg }).then((sent) => {
                            if (autoDel && sent?.key) {
                                setTimeout(() => {
                                    sock.sendMessage(chatId, { delete: sent.key }).catch(() => {});
                                }, 4500);
                            }
                        }).catch(() => {});
                    };

                    if (['help', 'commands', 'cmds'].includes(cl)) {
                        fb(
                            `📋 *WHATSAPP SELECTIVE 8-AI COMMANDS*\n\n` +
                            `🤖 *Selective AI (Run from ANY chat):*\n` +
                            `• \`*ai on\` / \`*ai off\` ➔ Current chat AI ON/OFF\n` +
                            `• \`*ai on 9876543210\` ➔ Specific DM AI ON\n` +
                            `• \`*ai on @GroupName\` ➔ Specific Group AI ON\n` +
                            `• \`*target ai @user/num [@group]\` ➔ Target AI ON\n` +
                            `• \`*stop target ai @user/num [@group]\` ➔ Target AI OFF\n` +
                            `• \`*ai all on\` / \`*ai all off\` ➔ Global AI\n` +
                            `• \`*aitest\` ➔ Live test 8-AI models\n` +
                            `• \`*aiprompt <text>\` / \`*aistatus\`\n\n` +
                            `🎯 *5-Slot Target & Chat Replies:*\n` +
                            `• \`*target reply @user/num [@group]\` / \`*stop target reply...\`\n` +
                            `• \`*reply [num]\` / \`*stop reply [num]\`\n` +
                            `• \`*reply all [@group]\` / \`*reply all dm\`\n` +
                            `• \`*gcmsgs\` / \`*dmmsgs\` / \`*setgc 1-5\` / \`*setdm 1-5\`\n\n` +
                            `🔇 *Mute, Lock, NC & Pin:*\n` +
                            `• \`*mute\` / \`*unmute\` / \`*muteall\` / \`*mutegc\` / \`*lock\` / \`*lockall\`\n` +
                            `• \`*target mute @user [@group]\` / \`*target lock @user [@group]\`\n` +
                            `• \`*nc [n1 | n2]\` / \`*stopnc\` / \`*pin\` / \`*pinall\`\n` +
                            `• \`*status\` / \`*stopall\``,
                            false
                        );
                        continue;
                    }

                    // --- LIVE AI TEST COMMAND (*aitest) ---
                    if (cl === 'aitest' || cl === 'testai') {
                        fb('⏳ Testing 8-Model AI Chain...', false);
                        const testReply = await generateAIReply("Hello bhai, kya haal hai?", "TestUser", false);
                        if (testReply) {
                            fb(`✅ *AI Working!*\n• Model: \`${lastAiModelUsed}\`\n• Reply: ${testReply}`, false);
                        } else {
                            fb(`❌ *AI Failed!*\n• Last Error: \`${lastAiError}\``, false);
                        }
                        continue;
                    }

                    if (cl === 'ai all on' || cl === 'aiall on') {
                        state.aiGlobalAll = true;
                        saveSettings();
                        fb('🤖 *Global AI ON*');
                        continue;
                    }
                    if (cl === 'ai all off' || cl === 'aiall off') {
                        state.aiGlobalAll = false;
                        saveSettings();
                        fb('🛑 *Global AI OFF*');
                        continue;
                    }

                    if (cl.startsWith('target ai') || cl.startsWith('stop target ai')) {
                        const isStop = cl.startsWith('stop');
                        const arg = cmd.replace(/^(stop\s+)?target\s+ai\s*/i, '').trim();
                        const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(sock, msg, arg, chatId, isGroup);
                        if (!targetUserId) { fb('⚠️ Target number ya @mention dein!'); continue; }

                        if (!state.aiTargets[targetGroupId]) state.aiTargets[targetGroupId] = [];
                        if (isStop) {
                            state.aiTargets[targetGroupId] = state.aiTargets[targetGroupId].filter(id => id !== targetUserId);
                            saveSettings();
                            fb(`🛑 *Target AI OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                        } else {
                            if (!state.aiTargets[targetGroupId].includes(targetUserId)) state.aiTargets[targetGroupId].push(targetUserId);
                            saveSettings();
                            fb(`🤖 *Target AI ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                        }
                        continue;
                    }

                    if (cl === 'ai on' || cl.startsWith('ai on ') || cl === 'ai off' || cl.startsWith('ai off ') || cl === 'aion' || cl === 'aioff') {
                        const isOff = cl.startsWith('ai off') || cl === 'aioff';
                        const arg = cmd.replace(/^(ai\s+on|ai\s+off|aion|aioff)\s*/i, '').trim();

                        let targetChatId = null;
                        let targetLabel = '';

                        if (!arg) {
                            targetChatId = chatId;
                            targetLabel = isGroup ? (groupCache.get(chatId) || 'Current Group') : chatId.split('@')[0];
                        } else if (arg.startsWith('@')) {
                            const grp = await resolveGroupFast(sock, arg);
                            if (grp) {
                                targetChatId = grp.id;
                                targetLabel = `Group: ${grp.name}`;
                            } else {
                                const usr = resolveTargetUser(msg, arg);
                                if (usr) { targetChatId = usr; targetLabel = `DM: ${usr.split('@')[0]}`; }
                            }
                        } else {
                            const usr = resolveTargetUser(msg, arg);
                            if (usr) {
                                targetChatId = usr;
                                targetLabel = `DM: ${usr.split('@')[0]}`;
                            } else {
                                const grp = await resolveGroupFast(sock, arg);
                                if (grp) { targetChatId = grp.id; targetLabel = `Group: ${grp.name}`; }
                            }
                        }

                        if (!targetChatId) { fb(`⚠️ Chat ya Number "${arg}" nahi mila!`); continue; }

                        if (isOff) {
                            state.aiChats = state.aiChats.filter(id => id !== targetChatId);
                            saveSettings();
                            fb(`🛑 *AI Reply OFF* for *${targetLabel}*`);
                        } else {
                            if (!state.aiChats.includes(targetChatId)) state.aiChats.push(targetChatId);
                            saveSettings();
                            fb(`🤖 *AI Reply ON* for *${targetLabel}*`);
                        }
                        continue;
                    }

                    if (cl.startsWith('aiprompt ')) {
                        state.aiSystemPrompt = cmd.slice(9).trim();
                        saveSettings();
                        fb('✅ *AI System Prompt Updated!*');
                        continue;
                    }

                    if (cl === 'aistatus') {
                        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
                        const totalTargetAi = Object.values(state.aiTargets).reduce((acc, arr) => acc + arr.length, 0);
                        fb(
                            `🤖 *SELECTIVE 8-AI STATUS*\n` +
                            `• Global AI: ${state.aiGlobalAll ? '🟢 ON' : '🟡 SELECTIVE'}\n` +
                            `• AI Chats: ${state.aiChats.length} | Targets: ${totalTargetAi}\n` +
                            `• Last Model: \`${lastAiModelUsed}\`\n` +
                            `• Last Error: \`${lastAiError}\`\n` +
                            `• RAM: ${mem} MB / 512 MB`,
                            false
                        );
                        continue;
                    }

                    if (cl === 'gcmsgs') { fb(`👥 *5 GC REPLIES:*\n${state.gcReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false); continue; }
                    if (cl === 'dmmsgs') { fb(`💬 *5 DM REPLIES:*\n${state.dmReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false); continue; }
                    if (cl.startsWith('setgc ')) {
                        const parts = cmd.split(/\s+/);
                        const s = parseInt(parts[1]);
                        if (s >= 1 && s <= 5 && parts.length >= 3) {
                            state.gcReplies[s - 1] = cmd.replace(/^setgc\s+\d+\s+/i, '');
                            saveSettings();
                            fb(`✅ GC Slot #${s} updated`);
                        }
                        continue;
                    }
                    if (cl.startsWith('setdm ')) {
                        const parts = cmd.split(/\s+/);
                        const s = parseInt(parts[1]);
                        if (s >= 1 && s <= 5 && parts.length >= 3) {
                            state.dmReplies[s - 1] = cmd.replace(/^setdm\s+\d+\s+/i, '');
                            saveSettings();
                            fb(`✅ DM Slot #${s} updated`);
                        }
                        continue;
                    }

                    if (cl.startsWith('target reply') || cl.startsWith('stop target reply')) {
                        const isStop = cl.startsWith('stop');
                        const arg = cmd.replace(/^(stop\s+)?target\s+reply\s*/i, '').trim();
                        const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(sock, msg, arg, chatId, isGroup);
                        if (!targetUserId) { fb('⚠️ Target number ya @mention dein!'); continue; }

                        if (!state.targetReplies[targetGroupId]) state.targetReplies[targetGroupId] = [];
                        if (isStop) {
                            state.targetReplies[targetGroupId] = state.targetReplies[targetGroupId].filter(id => id !== targetUserId);
                            saveSettings();
                            fb(`🛑 *Target Reply OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                        } else {
                            if (!state.targetReplies[targetGroupId].includes(targetUserId)) state.targetReplies[targetGroupId].push(targetUserId);
                            saveSettings();
                            fb(`🎯 *Target Reply ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                        }
                        continue;
                    }

                    const targetMap = [
                        { prefix: 'target mute', dict: 'targetMutes', label: 'Target Mute' },
                        { prefix: 'target lock', dict: 'targetLocks', label: 'Target Lock' },
                        { prefix: 'target nc reply', dict: 'targetNcReply', label: 'Target NC Reply' },
                        { prefix: 'target nc mute', dict: 'targetNcMute', label: 'Target NC Mute' },
                        { prefix: 'target nc lock', dict: 'targetNcLock', label: 'Target NC Lock' }
                    ];
                    let handledTarget = false;
                    for (const item of targetMap) {
                        if (cl.startsWith(item.prefix) || cl.startsWith(`stop ${item.prefix}`)) {
                            handledTarget = true;
                            const isStop = cl.startsWith('stop');
                            const arg = cmd.replace(new RegExp(`^(stop\\s+)?${item.prefix}\\s*`, 'i'), '').trim();
                            const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(sock, msg, arg, chatId, isGroup);
                            if (!targetUserId) { fb('⚠️ Target user nahi mila!'); break; }

                            if (!state[item.dict][targetGroupId]) state[item.dict][targetGroupId] = [];
                            if (isStop) {
                                state[item.dict][targetGroupId] = state[item.dict][targetGroupId].filter(id => id !== targetUserId);
                                saveSettings();
                                fb(`🛑 *${item.label} OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                            } else {
                                if (!state[item.dict][targetGroupId].includes(targetUserId)) state[item.dict][targetGroupId].push(targetUserId);
                                saveSettings();
                                fb(`🎯 *${item.label} ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                            }
                            break;
                        }
                    }
                    if (handledTarget) continue;

                    if (cl.startsWith('reply all') || cl.startsWith('stop reply all')) {
                        const isStop = cl.startsWith('stop');
                        const arg = cmd.replace(/^(stop\s+)?reply\s+all\s*/i, '').trim();

                        if (arg.toLowerCase() === 'dm' || arg.toLowerCase() === 'dms') {
                            state.replyAllDms = !isStop;
                            saveSettings();
                            fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
                            continue;
                        }
                        if (arg.length > 0) {
                            const grp = await resolveGroupFast(sock, arg);
                            if (!grp) { fb(`⚠️ Group "${arg}" nahi mila!`); continue; }
                            state.replyGcs = isStop ? state.replyGcs.filter(id => id !== grp.id) : [...new Set([...state.replyGcs, grp.id])];
                            saveSettings();
                            fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}* in *${grp.name}*`);
                            continue;
                        }
                        if (isGroup) {
                            state.replyGcs = isStop ? state.replyGcs.filter(id => id !== chatId) : [...new Set([...state.replyGcs, chatId])];
                            saveSettings();
                            fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}*`);
                        } else {
                            state.replyAllDms = !isStop;
                            saveSettings();
                            fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
                        }
                        continue;
                    }

                    if (cl === 'reply' || cl.startsWith('reply ') || cl === 'stop reply' || cl.startsWith('stop reply ')) {
                        const isStop = cl.startsWith('stop');
                        const arg = cmd.replace(/^(stop\s+)?reply\s*/i, '').trim();
                        let targetDmId = arg ? resolveTargetUser(msg, arg) : (!isGroup ? chatId : null);
                        if (!targetDmId) { fb('⚠️ DM ke liye number likhein: `*reply 9876543210`'); continue; }

                        state.replyDms = isStop ? state.replyDms.filter(id => id !== targetDmId) : [...new Set([...state.replyDms, targetDmId])];
                        saveSettings();
                        fb(`${isStop ? '🛑' : '✅'} *DM Reply ${isStop ? 'OFF' : 'ON'}* for \`${targetDmId.split('@')[0]}\``);
                        continue;
                    }

                    if (cl === 'stopnc' || cl === 'stop nc' || cl === 'unnc') {
                        stopNcLoop(chatId);
                        fb('🛑 *Continuous NC Stopped*');
                        continue;
                    }
                    if (cl === 'nc' || cl.startsWith('nc ')) {
                        if (!isGroup) { fb('⚠️ `*nc` sirf Group me kaam karta hai!'); continue; }
                        const raw = cmd.slice(2).trim();
                        const titles = raw ? raw.split(/[|\n,]+/).map(s => s.trim()).filter(Boolean) : state.ncTitles;
                        startNcLoop(sock, chatId, titles);
                        fb(`🚀 *Auto-NC Started* (${titles.length} titles rotating)`);
                        continue;
                    }

                    if (cl === 'muteall' || cl === 'stop muteall') {
                        state.muteAllDms = (cl === 'muteall');
                        if (!state.muteAllDms) state.unmuteExempts = [];
                        saveSettings();
                        fb(state.muteAllDms ? '🔒 *Global DM Mute ON*' : '🔓 *Global DM Mute OFF*');
                        continue;
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
                        fb(isStop ? '🛑 *Mute OFF*' : '🔇 *Mute ON*');
                        continue;
                    }
                    if (['lock', 'unlock', 'stop lock', 'lockall', 'unlockall', 'stop lockall'].includes(cl)) {
                        const isStop = cl.includes('un') || cl.includes('stop');
                        state.lockChats = isStop ? state.lockChats.filter(id => id !== chatId) : [...new Set([...state.lockChats, chatId])];
                        saveSettings();
                        fb(isStop ? '🛑 *Lock OFF*' : '🛡️ *Lock ON*');
                        continue;
                    }

                    if (cl === 'pinall' || cl === 'stop pinall' || cl === 'unpinall') {
                        state.pinAll = (cl === 'pinall');
                        saveSettings();
                        fb(state.pinAll ? '📌 *Global Auto-Pin ON*' : '🛑 *Global Auto-Pin OFF*');
                        continue;
                    }
                    if (cl === 'pin except' || cl === 'stop pin except') {
                        const isStop = cl.startsWith('stop');
                        state.pinExempts = isStop ? state.pinExempts.filter(id => id !== chatId) : [...new Set([...state.pinExempts, chatId])];
                        saveSettings();
                        fb(isStop ? '🛑 *Pin Exception OFF*' : '🛡️ *Pin Exception ON*');
                        continue;
                    }
                    if (['pin', 'pin on', 'stop pin', 'unpin', 'pin off'].includes(cl)) {
                        const isStop = cl.includes('stop') || cl.includes('un') || cl.includes('off');
                        state.pinChats = isStop ? state.pinChats.filter(id => id !== chatId) : [...new Set([...state.pinChats, chatId])];
                        saveSettings();
                        fb(isStop ? '🛑 *Auto-Pin OFF*' : '📌 *Auto-Pin ON*');
                        continue;
                    }

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
                        fb('🛑 *All rules, AI & NC cleared for this chat.*');
                        continue;
                    }
                    if (cl === 'status') {
                        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
                        const hasAiHere = state.aiGlobalAll || state.aiChats.includes(chatId) || (state.aiTargets[chatId] || []).length > 0;
                        fb(
                            `⚙️ *CHAT & BOT STATUS*\n` +
                            `• AI Here: ${hasAiHere ? '🟢 ON' : '🔴 OFF'}\n` +
                            `• 5-Slot Reply: ${(state.replyGcs.includes(chatId) || state.replyDms.includes(chatId) || (!isGroup && state.replyAllDms)) ? '🟢 ON' : '🔴 OFF'}\n` +
                            `• Mute/Lock: ${(state.muteChats.includes(chatId) || state.lockChats.includes(chatId)) ? '🟢 ON' : '🔴 OFF'}\n` +
                            `• Continuous NC: ${ncIntervals.has(chatId) ? '🟢 ON' : '🔴 OFF'}\n` +
                            `• Auto-Pin: ${state.pinChats.includes(chatId) || state.pinAll ? '🟢 ON' : '🔴 OFF'}\n` +
                            `• RAM: ${mem} MB / 512 MB`,
                            false
                        );
                        continue;
                    }
                    continue;
                }

                // ---------------------------------------------------------
                // B. INCOMING MESSAGES (UNIVERSAL LID + PHONE MATCHING)
                // ---------------------------------------------------------
                const isMutedOrLocked =
                    state.lockChats.includes(chatId) ||
                    state.muteChats.includes(chatId) ||
                    (!isGroup && state.muteAllDms && !state.unmuteExempts.includes(chatId)) ||
                    matchesUserList(state.targetMutes[chatId], senderId, msg) ||
                    matchesUserList(state.targetMutes['GLOBAL'], senderId, msg) ||
                    matchesUserList(state.targetLocks[chatId], senderId, msg) ||
                    matchesUserList(state.targetLocks['GLOBAL'], senderId, msg) ||
                    matchesUserList(state.targetNcMute[chatId], senderId, msg) ||
                    matchesUserList(state.targetNcLock[chatId], senderId, msg);

                if (isMutedOrLocked) {
                    if (isGroup && matchesUserList(state.targetNcMute[chatId], senderId, msg)) {
                        sock.groupUpdateSubject(chatId, `🚫 MUTED: ${senderId.split('@')[0]}`).catch(() => {});
                    }
                    sock.sendMessage(chatId, { delete: msg.key }).catch(() => {});
                    continue;
                }

                const isTargetNcReply = isGroup && matchesUserList(state.targetNcReply[chatId], senderId, msg);

                const isAiEnabledForThis =
                    state.aiGlobalAll ||
                    matchesUserList(state.aiChats, chatId, msg) ||
                    matchesUserList(state.aiTargets[chatId], senderId, msg) ||
                    matchesUserList(state.aiTargets['GLOBAL'], senderId, msg);

                let isNormalReplyEnabled = false;
                if (isGroup) {
                    isNormalReplyEnabled =
                        state.replyAllGcs ||
                        state.replyGcs.includes(chatId) ||
                        matchesUserList(state.targetReplies[chatId], senderId, msg) ||
                        matchesUserList(state.targetReplies['GLOBAL'], senderId, msg) ||
                        isTargetNcReply;
                } else {
                    isNormalReplyEnabled = state.replyAllDms || matchesUserList(state.replyDms, chatId, msg);
                }

                if (!isAiEnabledForThis && !isNormalReplyEnabled) continue;

                const coolKey = `${chatId}_${senderId}`;
                const now = Date.now();
                if (now - (lastReplyTime.get(coolKey) || 0) < COOLDOWN_MS) continue;
                lastReplyTime.set(coolKey, now);

                (async () => {
                    try {
                        const senderName = msg.pushName || senderId.split('@')[0];
                        const tagText = `@${senderId.split('@')[0]}`;

                        let finalReplyText = null;
                        if (isAiEnabledForThis && text.length > 0) {
                            finalReplyText = await generateAIReply(text, senderName, isGroup);
                        }

                        if (!finalReplyText) {
                            if (isGroup) {
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
                            sock.groupUpdateSubject(chatId, `🎯 ALERT: ${senderName.slice(0, 18)}`).catch(() => {});
                        }

                        await sock.sendMessage(chatId, {
                            text: `${tagText} ${finalReplyText}`,
                            mentions: [senderId]
                        }, { quoted: msg });
                    } catch (err) {}
                })();
            }
        });
    } catch (err) {
        isStarting = false;
        setTimeout(startWhatsAppBot, 5000);
    }
}

startWhatsAppBot();
