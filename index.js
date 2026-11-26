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

// =====================================================================
// 1. RENDER HTTP HEALTH SERVER + PNG PHOTO QR ENDPOINTS (/qr & /qr.png)
// =====================================================================
const app = express();
const PORT = process.env.PORT || 10000;

let latestQrPngBuffer = null;
let isWaConnected = false;

const API_KEYS = {
    GROQ: process.env.GROQ_API_KEY || "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",
    OPENROUTER: process.env.OPENROUTER_API_KEY || "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",
    HUGGINGFACE: process.env.HF_API_KEY || "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"
};

const AI_MODELS = [
    { name: "1. Groq Llama-3.1-8B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.1-8b-instant" },
    { name: "2. OpenRouter Gemini-2.0-Flash", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemini-2.0-flash-exp:free" },
    { name: "3. HF Qwen-2.5-72B", provider: "HUGGINGFACE", url: "https://router.huggingface.co/v1/chat/completions", model: "Qwen/Qwen2.5-72B-Instruct" },
    { name: "4. Groq Llama-3.3-70B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    { name: "5. OpenRouter Llama-3.1-8B", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.1-8b-instruct:free" },
    { name: "6. HF Mistral-7B-v0.3", provider: "HUGGINGFACE", url: "https://router.huggingface.co/v1/chat/completions", model: "mistralai/Mistral-7B-Instruct-v0.3" },
    { name: "7. Groq Gemma2-9B", provider: "GROQ", url: "https://api.groq.com/openai/v1/chat/completions", model: "gemma2-9b-it" },
    { name: "8. OpenRouter Qwen-2.5-7B", provider: "OPENROUTER", url: "https://openrouter.ai/api/v1/chat/completions", model: "qwen/qwen-2.5-7b-instruct:free" }
];

const modelCooldowns = new Map();
let activeAiCount = 0;
const MAX_CONCURRENT_AI = 2;

app.get('/', (req, res) => {
    const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
    res.status(200).json({
        status: 'healthy',
        whatsapp_connected: isWaConnected,
        qr_photo_page: '/qr',
        direct_png_image: '/qr.png',
        ram_usage_mb: `${memUsage} MB`,
        uptime_sec: Math.floor(process.uptime())
    });
});

// Direct PNG Photo Route (Opens as a pure image in browser)
app.get('/qr.png', (req, res) => {
    if (!latestQrPngBuffer) {
        return res.status(404).send('QR not generated yet or already connected.');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(latestQrPngBuffer);
});

// Compact, Scannable Photo Viewer Page
app.get('/qr', (req, res) => {
    if (isWaConnected) {
        return res.send(`
            <html><body style="background:#111;color:#0f0;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
                <h2>✅ WhatsApp Connected!</h2>
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
        <head>
            <meta http-equiv="refresh" content="15">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Scan WhatsApp QR</title>
        </head>
        <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center;">
            <p style="margin-bottom:10px;font-size:15px;">📱 Scan with WhatsApp Linked Devices</p>
            <div style="background:#fff;padding:12px;border-radius:10px;display:inline-block;">
                <img src="/qr.png?t=${Date.now()}" alt="WhatsApp QR" style="width:180px;height:180px;display:block;" />
            </div>
            <a href="/qr.png" download="whatsapp-qr.png" style="margin-top:14px;padding:8px 14px;background:#25D366;color:#000;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13px;">⬇️ Save QR Photo</a>
            <p style="color:#888;font-size:11px;margin-top:8px;">Auto-refreshes every 15s</p>
        </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 [Render Server] Ready on port ${PORT} | Open /qr in browser for QR photo`);
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
// 3. 45-SECOND RAM & MEMORY AUTO-CLEANER
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
// 4. 8-MODEL TRI-PROVIDER FALLBACK GENERATOR
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

            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            };
            if (cfg.provider === 'OPENROUTER') {
                headers['HTTP-Referer'] = 'https://wa-userbot.local';
                headers['X-Title'] = 'WA Userbot';
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
// 5. REMOTE RESOLVERS
// =====================================================================
function normalizeJid(raw) {
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    return digits ? `${digits}@s.whatsapp.net` : null;
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

async function resolveTargetUser(msg, query) {
    const mentioned = getMentionedJid(msg);
    if (mentioned) return mentioned;
    const cleanNum = query.replace(/[@\s+-]/g, '');
    if (/^\d{10,15}$/.test(cleanNum)) return normalizeJid(cleanNum);
    return null;
}

async function resolveGroup(sock, groupQuery) {
    const search = groupQuery.replace(/^@/, '').toLowerCase().trim();
    if (!search) return null;
    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(groups)) {
            if (meta.subject && meta.subject.toLowerCase().includes(search)) {
                return { id: jid, name: meta.subject };
            }
        }
    } catch (e) {}
    return null;
}

async function parseUserAndGroup(sock, msg, arg, chatId, isGroup) {
    let targetGroupId = isGroup ? chatId : 'GLOBAL';
    let targetGroupName = isGroup ? 'Current Group' : 'All Groups';
    let userPart = arg;

    const atMatches = arg.match(/@[^@]+/g);
    if (atMatches && atMatches.length >= 2) {
        const potentialGroup = atMatches[atMatches.length - 1].trim();
        const grp = await resolveGroup(sock, potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, arg.lastIndexOf(potentialGroup)).trim();
        }
    } else if (arg.includes('@') && !arg.startsWith('@')) {
        const splitIdx = arg.indexOf('@');
        const potentialGroup = arg.slice(splitIdx).trim();
        const grp = await resolveGroup(sock, potentialGroup);
        if (grp) {
            targetGroupId = grp.id;
            targetGroupName = grp.name;
            userPart = arg.slice(0, splitIdx).trim();
        }
    }
    const targetUserId = await resolveTargetUser(msg, userPart);
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
// 6. START BAILEYS WHATSAPP SOCKET
// =====================================================================
async function startWhatsAppBot() {
    const { state: authState, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: authState,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            isWaConnected = false;
            try {
                // Generates a crisp, compact 180x180 PNG image buffer
                latestQrPngBuffer = await QRCode.toBuffer(qr, {
                    type: 'png',
                    width: 180,
                    margin: 1,
                    color: { dark: '#000000', light: '#ffffff' }
                });
                console.log('📸 QR Photo Ready! Open your Render URL + /qr (or /qr.png) in browser to scan.');
            } catch (e) {
                console.error('QR generation error:', e.message);
            }
        }
        if (connection === 'close') {
            isWaConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) setTimeout(startWhatsAppBot, 3000);
        } else if (connection === 'open') {
            isWaConnected = true;
            latestQrPngBuffer = null;
            console.log('✅ WhatsApp Selective 8-AI Userbot Connected & Ready!');
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

                const fb = async (replyText, autoDel = true) => {
                    try {
                        const sent = await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
                        if (autoDel && sent?.key) {
                            setTimeout(() => {
                                sock.sendMessage(chatId, { delete: sent.key }).catch(() => {});
                            }, 4500);
                        }
                    } catch (e) {}
                };

                if (['help', 'commands', 'cmds'].includes(cl)) {
                    await fb(
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
                        `• \`*aiprompt <text>\` ➔ Change AI prompt\n` +
                        `• \`*aistatus\` ➔ Active AI chats, models & RAM\n\n` +
                        `🎯 *Normal 5-Slot Target & Chat Replies:*\n` +
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

                if (cl === 'ai all on' || cl === 'aiall on') {
                    state.aiGlobalAll = true;
                    saveSettings();
                    await fb('🤖 *Global AI ON*');
                    continue;
                }
                if (cl === 'ai all off' || cl === 'aiall off') {
                    state.aiGlobalAll = false;
                    saveSettings();
                    await fb('🛑 *Global AI OFF* (Selective mode active)');
                    continue;
                }

                if (cl.startsWith('target ai') || cl.startsWith('stop target ai')) {
                    const isStop = cl.startsWith('stop');
                    const arg = cmd.replace(/^(stop\s+)?target\s+ai\s*/i, '').trim();
                    const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(sock, msg, arg, chatId, isGroup);
                    if (!targetUserId) { await fb('⚠️ Target number ya @mention dein!'); continue; }

                    if (!state.aiTargets[targetGroupId]) state.aiTargets[targetGroupId] = [];
                    if (isStop) {
                        state.aiTargets[targetGroupId] = state.aiTargets[targetGroupId].filter(id => id !== targetUserId);
                        saveSettings();
                        await fb(`🛑 *Target AI OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                    } else {
                        if (!state.aiTargets[targetGroupId].includes(targetUserId)) state.aiTargets[targetGroupId].push(targetUserId);
                        saveSettings();
                        await fb(`🤖 *Target AI ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
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
                        targetLabel = isGroup ? 'Current Group' : chatId.split('@')[0];
                    } else if (arg.startsWith('@')) {
                        const grp = await resolveGroup(sock, arg);
                        if (grp) {
                            targetChatId = grp.id;
                            targetLabel = `Group: ${grp.name}`;
                        } else {
                            const usr = await resolveTargetUser(msg, arg);
                            if (usr) { targetChatId = usr; targetLabel = `DM: ${usr.split('@')[0]}`; }
                        }
                    } else {
                        const usr = await resolveTargetUser(msg, arg);
                        if (usr) {
                            targetChatId = usr;
                            targetLabel = `DM: ${usr.split('@')[0]}`;
                        } else {
                            const grp = await resolveGroup(sock, arg);
                            if (grp) { targetChatId = grp.id; targetLabel = `Group: ${grp.name}`; }
                        }
                    }

                    if (!targetChatId) { await fb(`⚠️ Chat ya Number "${arg}" nahi mila!`); continue; }

                    if (isOff) {
                        state.aiChats = state.aiChats.filter(id => id !== targetChatId);
                        saveSettings();
                        await fb(`🛑 *AI Reply OFF* for *${targetLabel}*`);
                    } else {
                        if (!state.aiChats.includes(targetChatId)) state.aiChats.push(targetChatId);
                        saveSettings();
                        await fb(`🤖 *AI Reply ON* for *${targetLabel}*`);
                    }
                    continue;
                }

                if (cl.startsWith('aiprompt ')) {
                    state.aiSystemPrompt = cmd.slice(9).trim();
                    saveSettings();
                    await fb('✅ *AI System Prompt Updated!*');
                    continue;
                }

                if (cl === 'aistatus') {
                    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
                    const totalTargetAi = Object.values(state.aiTargets).reduce((acc, arr) => acc + arr.length, 0);
                    await fb(
                        `🤖 *SELECTIVE 8-AI STATUS*\n` +
                        `• Global AI Mode: ${state.aiGlobalAll ? '🟢 ON (All)' : '🟡 SELECTIVE ONLY'}\n` +
                        `• AI Enabled Chats (DM/GC): ${state.aiChats.length}\n` +
                        `• AI Enabled Targets: ${totalTargetAi}\n` +
                        `• Providers: GROQ + OPENROUTER + HF (8 Models)\n` +
                        `• RAM Usage: ${mem} MB / 512 MB`,
                        false
                    );
                    continue;
                }

                if (cl === 'gcmsgs') { await fb(`👥 *5 GC REPLIES:*\n${state.gcReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false); continue; }
                if (cl === 'dmmsgs') { await fb(`💬 *5 DM REPLIES:*\n${state.dmReplies.map((m, i) => `*${i + 1}.* ${m}`).join('\n')}`, false); continue; }
                if (cl.startsWith('setgc ')) {
                    const parts = cmd.split(/\s+/);
                    const s = parseInt(parts[1]);
                    if (s >= 1 && s <= 5 && parts.length >= 3) {
                        state.gcReplies[s - 1] = cmd.replace(/^setgc\s+\d+\s+/i, '');
                        saveSettings();
                        await fb(`✅ GC Slot #${s} updated`);
                    }
                    continue;
                }
                if (cl.startsWith('setdm ')) {
                    const parts = cmd.split(/\s+/);
                    const s = parseInt(parts[1]);
                    if (s >= 1 && s <= 5 && parts.length >= 3) {
                        state.dmReplies[s - 1] = cmd.replace(/^setdm\s+\d+\s+/i, '');
                        saveSettings();
                        await fb(`✅ DM Slot #${s} updated`);
                    }
                    continue;
                }

                if (cl.startsWith('target reply') || cl.startsWith('stop target reply')) {
                    const isStop = cl.startsWith('stop');
                    const arg = cmd.replace(/^(stop\s+)?target\s+reply\s*/i, '').trim();
                    const { targetUserId, targetGroupId, targetGroupName } = await parseUserAndGroup(sock, msg, arg, chatId, isGroup);
                    if (!targetUserId) { await fb('⚠️ Target number ya @mention dein!'); continue; }

                    if (!state.targetReplies[targetGroupId]) state.targetReplies[targetGroupId] = [];
                    if (isStop) {
                        state.targetReplies[targetGroupId] = state.targetReplies[targetGroupId].filter(id => id !== targetUserId);
                        saveSettings();
                        await fb(`🛑 *Target Reply OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                    } else {
                        if (!state.targetReplies[targetGroupId].includes(targetUserId)) state.targetReplies[targetGroupId].push(targetUserId);
                        saveSettings();
                        await fb(`🎯 *Target Reply ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
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
                        if (!targetUserId) { await fb('⚠️ Target user nahi mila!'); break; }

                        if (!state[item.dict][targetGroupId]) state[item.dict][targetGroupId] = [];
                        if (isStop) {
                            state[item.dict][targetGroupId] = state[item.dict][targetGroupId].filter(id => id !== targetUserId);
                            saveSettings();
                            await fb(`🛑 *${item.label} OFF* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
                        } else {
                            if (!state[item.dict][targetGroupId].includes(targetUserId)) state[item.dict][targetGroupId].push(targetUserId);
                            saveSettings();
                            await fb(`🎯 *${item.label} ON* for \`${targetUserId.split('@')[0]}\` in *${targetGroupName}*`);
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
                        await fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
                        continue;
                    }
                    if (arg.length > 0) {
                        const grp = await resolveGroup(sock, arg);
                        if (!grp) { await fb(`⚠️ Group "${arg}" nahi mila!`); continue; }
                        state.replyGcs = isStop ? state.replyGcs.filter(id => id !== grp.id) : [...new Set([...state.replyGcs, grp.id])];
                        saveSettings();
                        await fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}* in *${grp.name}*`);
                        continue;
                    }
                    if (isGroup) {
                        state.replyGcs = isStop ? state.replyGcs.filter(id => id !== chatId) : [...new Set([...state.replyGcs, chatId])];
                        saveSettings();
                        await fb(`${isStop ? '🛑' : '✅'} *GC ReplyAll ${isStop ? 'OFF' : 'ON'}*`);
                    } else {
                        state.replyAllDms = !isStop;
                        saveSettings();
                        await fb(isStop ? '🛑 *All DMs Reply OFF*' : '✅ *All DMs Reply ON*');
                    }
                    continue;
                }

                if (cl === 'reply' || cl.startsWith('reply ') || cl === 'stop reply' || cl.startsWith('stop reply ')) {
                    const isStop = cl.startsWith('stop');
                    const arg = cmd.replace(/^(stop\s+)?reply\s*/i, '').trim();
                    let targetDmId = arg ? await resolveTargetUser(msg, arg) : (!isGroup ? chatId : null);
                    if (!targetDmId) { await fb('⚠️ DM ke liye number likhein: `*reply 9876543210`'); continue; }

                    state.replyDms = isStop ? state.replyDms.filter(id => id !== targetDmId) : [...new Set([...state.replyDms, targetDmId])];
                    saveSettings();
                    await fb(`${isStop ? '🛑' : '✅'} *DM Reply ${isStop ? 'OFF' : 'ON'}* for \`${targetDmId.split('@')[0]}\``);
                    continue;
                }

                if (cl === 'stopnc' || cl === 'stop nc' || cl === 'unnc') {
                    stopNcLoop(chatId);
                    await fb('🛑 *Continuous NC Stopped*');
                    continue;
                }
                if (cl === 'nc' || cl.startsWith('nc ')) {
                    if (!isGroup) { await fb('⚠️ `*nc` sirf Group me kaam karta hai!'); continue; }
                    const raw = cmd.slice(2).trim();
                    const titles = raw ? raw.split(/[|\n,]+/).map(s => s.trim()).filter(Boolean) : state.ncTitles;
                    startNcLoop(sock, chatId, titles);
                    await fb(`🚀 *Auto-NC Started* (${titles.length} titles rotating every 4s)`);
                    continue;
                }

                if (cl === 'muteall' || cl === 'stop muteall') {
                    state.muteAllDms = (cl === 'muteall');
                    if (!state.muteAllDms) state.unmuteExempts = [];
                    saveSettings();
                    await fb(state.muteAllDms ? '🔒 *Global DM Mute ON*' : '🔓 *Global DM Mute OFF*');
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
                    await fb(isStop ? '🛑 *Mute OFF*' : '🔇 *Mute ON*');
                    continue;
                }
                if (['lock', 'unlock', 'stop lock', 'lockall', 'unlockall', 'stop lockall'].includes(cl)) {
                    const isStop = cl.includes('un') || cl.includes('stop');
                    state.lockChats = isStop ? state.lockChats.filter(id => id !== chatId) : [...new Set([...state.lockChats, chatId])];
                    saveSettings();
                    await fb(isStop ? '🛑 *Lock OFF*' : '🛡️ *Lock ON*');
                    continue;
                }

                if (cl === 'pinall' || cl === 'stop pinall' || cl === 'unpinall') {
                    state.pinAll = (cl === 'pinall');
                    saveSettings();
                    await fb(state.pinAll ? '📌 *Global Auto-Pin ON*' : '🛑 *Global Auto-Pin OFF*');
                    continue;
                }
                if (cl === 'pin except' || cl === 'stop pin except') {
                    const isStop = cl.startsWith('stop');
                    state.pinExempts = isStop ? state.pinExempts.filter(id => id !== chatId) : [...new Set([...state.pinExempts, chatId])];
                    saveSettings();
                    await fb(isStop ? '🛑 *Pin Exception OFF*' : '🛡️ *Pin Exception ON*');
                    continue;
                }
                if (['pin', 'pin on', 'stop pin', 'unpin', 'pin off'].includes(cl)) {
                    const isStop = cl.includes('stop') || cl.includes('un') || cl.includes('off');
                    state.pinChats = isStop ? state.pinChats.filter(id => id !== chatId) : [...new Set([...state.pinChats, chatId])];
                    saveSettings();
                    await fb(isStop ? '🛑 *Auto-Pin OFF*' : '📌 *Auto-Pin ON*');
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
                    await fb('🛑 *All rules, AI & NC cleared for this chat.*');
                    continue;
                }
                if (cl === 'status') {
                    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
                    const hasAiHere = state.aiGlobalAll || state.aiChats.includes(chatId) || (state.aiTargets[chatId] || []).length > 0;
                    await fb(
                        `⚙️ *CHAT & BOT STATUS*\n` +
                        `• AI Reply Here: ${hasAiHere ? '🟢 ON' : '🔴 OFF'}\n` +
                        `• 5-Slot Reply Here: ${(state.replyGcs.includes(chatId) || state.replyDms.includes(chatId) || (!isGroup && state.replyAllDms)) ? '🟢 ON' : '🔴 OFF'}\n` +
                        `• Mute/Lock: ${(state.muteChats.includes(chatId) || state.lockChats.includes(chatId)) ? '🟢 ON' : '🔴 OFF'}\n` +
                        `• Continuous NC: ${ncIntervals.has(chatId) ? '🟢 ON' : '🔴 OFF'}\n` +
                        `• Auto-Pin: ${state.pinChats.includes(chatId) || state.pinAll ? '🟢 ON' : '🔴 OFF'}\n` +
                        `• RAM Usage: ${mem} MB / 512 MB`,
                        false
                    );
                    continue;
                }
                continue;
            }

            // -------------------------------------------------------------
            // B. INCOMING MESSAGES
            // -------------------------------------------------------------
            const isMutedOrLocked =
                state.lockChats.includes(chatId) ||
                state.muteChats.includes(chatId) ||
                (!isGroup && state.muteAllDms && !state.unmuteExempts.includes(chatId)) ||
                (state.targetMutes[chatId] || []).includes(senderId) ||
                (state.targetMutes['GLOBAL'] || []).includes(senderId) ||
                (state.targetLocks[chatId] || []).includes(senderId) ||
                (state.targetLocks['GLOBAL'] || []).includes(senderId) ||
                (state.targetNcMute[chatId] || []).includes(senderId) ||
                (state.targetNcLock[chatId] || []).includes(senderId);

            if (isMutedOrLocked) {
                if (isGroup && (state.targetNcMute[chatId] || []).includes(senderId)) {
                    sock.groupUpdateSubject(chatId, `🚫 MUTED: ${senderId.split('@')[0]}`).catch(() => {});
                }
                sock.sendMessage(chatId, { delete: msg.key }).catch(() => {});
                continue;
            }

            const isTargetNcReply = isGroup && (state.targetNcReply[chatId] || []).includes(senderId);

            const isAiEnabledForThis =
                state.aiGlobalAll ||
                state.aiChats.includes(chatId) ||
                (state.aiTargets[chatId] || []).includes(senderId) ||
                (state.aiTargets['GLOBAL'] || []).includes(senderId);

            let isNormalReplyEnabled = false;
            if (isGroup) {
                isNormalReplyEnabled =
                    state.replyAllGcs ||
                    state.replyGcs.includes(chatId) ||
                    (state.targetReplies[chatId] || []).includes(senderId) ||
                    (state.targetReplies['GLOBAL'] || []).includes(senderId) ||
                    isTargetNcReply;
            } else {
                isNormalReplyEnabled = state.replyAllDms || state.replyDms.includes(chatId);
            }

            if (!isAiEnabledForThis && !isNormalReplyEnabled) continue;

            const coolKey = `${chatId}_${senderId}`;
            const now = Date.now();
            if (now - (lastReplyTime.get(coolKey) || 0) < COOLDOWN_MS) continue;
            lastReplyTime.set(coolKey, now);

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
            } catch (err) {
                console.error('Reply error:', err.message);
            }
        }
    });
}

startWhatsAppBot();
