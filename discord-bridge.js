/**
 * discord-bridge.js — MultiChat (Enterprise/Production Build)
 * * FEATURES:
 * 1. Discord Gateway (Bot) - Forwards Discord messages.
 * 2. Active YouTube Polling - Periodically checks for live chat without a browser.
 * 3. Dynamic Configuration - Loads from Electron UserData, config.js, or Environment.
 * 4. WebSocket Hub - Central server for multichat.html clients.
 * 5. HTTP Proxy - Resolves YouTube handles and Kick IDs for the setup page.
 * 6. Auto-reconnect - Handles gateway and polling failures gracefully.
 */

const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const url        = require('url');
const fs         = require('fs');
const path       = require('path');
const vm         = require('vm');

// ── 1. GLOBAL CONFIGURATION & STATE ──────────────────────────────────────────
let BOT_TOKEN  = '';
let CHANNEL_ID = '';
let YT_API_KEY = '';
let YT_CHAN_ID = '';

const WS_PORT   = parseInt(process.env.DISCORD_BRIDGE_WS_PORT) || 8081;
const HTTP_PORT = WS_PORT + 1;

/**
 * INITIALIZATION ENGINE
 * Orchestrates the loading of secrets from three distinct sources.
 */
function initializeConfiguration() {
    console.log('────────────────────────────────────────────────────────────');
    console.log('🚀 INITIALIZING MULTICHAT BRIDGE ENGINE');
    console.log('────────────────────────────────────────────────────────────');

    // Source A: Electron UserData folder (Highest priority for local users)
    const appName = 'multichat';
    const userData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.config'));
    const electronSettings = path.join(userData, appName, 'multichat-settings.json');

    if (fs.existsSync(electronSettings)) {
        try {
            const s = JSON.parse(fs.readFileSync(electronSettings, 'utf8'));
            BOT_TOKEN  = s.DISCORD_BOT_TOKEN  || '';
            CHANNEL_ID = s.DISCORD_CHANNEL_ID || '';
            YT_API_KEY = s.YOUTUBE_API_KEY    || '';
            YT_CHAN_ID = s.YOUTUBE_CHANNEL_ID || '';
            console.log('✅ Local Settings Found: Electron UserData');
        } catch (e) {
            console.error('❌ Error parsing Electron settings:', e.message);
        }
    } 
    
    // Source B: Local config.js (Development fallback)
    if (!BOT_TOKEN && fs.existsSync('./config.js')) {
        try {
            const raw = fs.readFileSync('./config.js', 'utf8');
            const ctx = {};
            vm.createContext(ctx);
            vm.runInContext(raw, ctx);
            if (ctx.CONFIG) {
                BOT_TOKEN  = ctx.CONFIG.DISCORD_BOT_TOKEN  || '';
                CHANNEL_ID = ctx.CONFIG.DISCORD_CHANNEL_ID || '';
                YT_API_KEY = ctx.CONFIG.YOUTUBE_API_KEY    || '';
                YT_CHAN_ID = ctx.CONFIG.YOUTUBE_CHANNEL_ID || '';
                console.log('✅ Local Settings Found: config.js');
            }
        } catch (e) {
            console.error('❌ Error parsing config.js:', e.message);
        }
    }

    // Source C: Environment Variables (Priority for Railway/Server deployments)
    BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || BOT_TOKEN;
    CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || CHANNEL_ID;
    YT_API_KEY = process.env.YOUTUBE_API_KEY    || YT_API_KEY;
    YT_CHAN_ID = process.env.YOUTUBE_CHANNEL_ID || YT_CHAN_ID;

    if (!BOT_TOKEN) console.warn('⚠️ Warning: No Discord Bot Token found.');
    if (!YT_API_KEY) console.warn('⚠️ Warning: No YouTube API Key found.');
}

initializeConfiguration();

// ── 2. WEBSOCKET SERVER (Central Message Hub) ───────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client Connected. Total Active: ${clients.size}`);
    
    ws.send(JSON.stringify({
        platform: 'discord',
        username: 'System',
        text: 'Bridge Connection Established. Listening for chat...'
    }));

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[WS] Client Disconnected. Total Active: ${clients.size}`);
    });

    ws.on('error', (err) => {
        console.error('[WS] Client Socket Error:', err.message);
    });
});

/**
 * Sends a message payload to all connected overlay clients.
 */
function broadcast(payload) {
    const data = JSON.stringify(payload);
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });
}

// ── 3. YOUTUBE ACTIVE POLLING ENGINE (The "YouTube Fix") ─────────────────────
let ytLiveChatId = null;
let ytNextPageToken = null;
let ytRetryCount = 0;

function googleFetch(apiPath, callback) {
    if (!YT_API_KEY) return callback(new Error('Missing API Key'));
    const fullUrl = `https://www.googleapis.com/youtube/v3/${apiPath}&key=${YT_API_KEY}`;
    
    https.get(fullUrl, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(raw);
                if (parsed.error) callback(new Error(parsed.error.message));
                else callback(null, parsed);
            } catch (e) { callback(e); }
        });
    }).on('error', callback);
}

/**
 * Searches for an active live stream and starts the chat polling loop.
 */
function startYoutubeEngine() {
    if (!YT_API_KEY || !YT_CHAN_ID || YT_CHAN_ID.includes('YOUR_')) {
        console.log('🎥 YouTube Engine: Incomplete settings. Polling disabled.');
        return;
    }

    const findStream = () => {
        console.log('🎥 YouTube Engine: Searching for active live stream...');
        const searchPath = `search?part=id&channelId=${encodeURIComponent(YT_CHAN_ID)}&type=video&eventType=live`;
        
        googleFetch(searchPath, (err, data) => {
            if (err) {
                console.error('❌ YouTube Search Error:', err.message);
                return setTimeout(findStream, 60000);
            }

            const videoId = data?.items?.[0]?.id?.videoId;
            if (!videoId) {
                // Not live: Check again every 2 minutes
                return setTimeout(findStream, 120000); 
            }

            console.log(`🎥 YouTube Engine: Stream found (${videoId}). Fetching LiveChatId...`);
            googleFetch(`videos?part=liveStreamingDetails&id=${videoId}`, (err2, data2) => {
                ytLiveChatId = data2?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
                if (ytLiveChatId) {
                    console.log(`✅ YouTube Engine: Live Chat ID resolved: ${ytLiveChatId}`);
                    ytNextPageToken = null;
                    pollChat();
                } else {
                    console.warn('⚠️ YouTube Engine: Could not find activeLiveChatId for video.');
                    setTimeout(findStream, 30000);
                }
            });
        });
    };

    const pollChat = () => {
        if (!ytLiveChatId) return findStream();
        
        let pollPath = `liveChat/messages?liveChatId=${encodeURIComponent(ytLiveChatId)}&part=snippet,authorDetails&maxResults=200`;
        if (ytNextPageToken) pollPath += `&pageToken=${encodeURIComponent(ytNextPageToken)}`;

        googleFetch(pollPath, (err, data) => {
            if (err) {
                console.error('❌ YouTube Poll Error:', err.message);
                ytLiveChatId = null;
                return setTimeout(findStream, 15000);
            }

            ytNextPageToken = data.nextPageToken;
            if (data.items && data.items.length > 0) {
                data.items.forEach(item => {
                    broadcast({
                        platform: 'youtube',
                        username: item.authorDetails.displayName,
                        text: item.snippet.displayMessage
                    });
                });
            }

            // Respect the API's recommended polling interval (usually 5s)
            const delay = data.pollingIntervalMillis || 5000;
            setTimeout(pollChat, delay);
        });
    };

    findStream();
}

startYoutubeEngine();

// ── 4. DISCORD GATEWAY (Real-time Discord Bot) ──────────────────────────────
let discordWs, heartbeatInterval, sequence = null;
let sessionId = null, resumeUrl = null;

function connectDiscord() {
    if (!BOT_TOKEN || BOT_TOKEN.includes('YOUR_')) return;
    
    const gatewayUrl = resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';
    console.log(`🤖 Discord Engine: Connecting to ${resumeUrl ? 'Resume' : 'New'} session...`);
    
    discordWs = new WebSocket(gatewayUrl);

    discordWs.on('open', () => {
        if (sessionId && resumeUrl) {
            // Resume Session
            discordWs.send(JSON.stringify({
                op: 6, d: { token: BOT_TOKEN, session_id: sessionId, seq: sequence }
            }));
        } else {
            // Identify Session
            discordWs.send(JSON.stringify({
                op: 2,
                d: {
                    token: BOT_TOKEN,
                    intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES + MESSAGE_CONTENT
                    properties: { os: 'linux', browser: 'multichat', device: 'multichat' }
                }
            }));
        }
    });

    discordWs.on('message', (raw) => {
        let p; try { p = JSON.parse(raw); } catch { return; }
        const { op, d, s, t } = p;
        if (s !== null) sequence = s;

        // Op 10: Hello - Setup Heartbeat
        if (op === 10) {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (discordWs.readyState === WebSocket.OPEN) {
                    discordWs.send(JSON.stringify({ op: 1, d: sequence }));
                }
            }, d.heartbeat_interval);
        }

        // Op 0: Dispatch
        if (op === 0) {
            if (t === 'READY') {
                sessionId = d.session_id;
                resumeUrl = d.resume_gateway_url + '/?v=10&encoding=json';
                console.log(`✅ Discord Engine: Logged in as ${d.user.username}`);
            }

            if (t === 'MESSAGE_CREATE') {
                if (d.channel_id !== CHANNEL_ID || d.author?.bot) return;
                const username = d.member?.nick || d.author?.global_name || d.author?.username || 'User';
                const text = (d.content || '').trim();
                if (!text) return;

                console.log(`💬 Discord: ${username}: ${text}`);
                broadcast({ platform: 'discord', username, text });
            }
        }

        // Reconnect Commands
        if (op === 7) { 
            console.log('🤖 Discord Engine: Reconnect requested by Gateway.'); 
            discordWs.terminate(); 
        }
        if (op === 9) { 
            console.warn('🤖 Discord Engine: Invalid session. Clearing cache...');
            sessionId = null; resumeUrl = null; 
            discordWs.terminate(); 
        }
    });

    discordWs.on('close', (code) => {
        clearInterval(heartbeatInterval);
        console.warn(`🤖 Discord Engine: Connection closed (${code}). Retrying in 5s...`);
        setTimeout(connectDiscord, 5000);
    });

    discordWs.on('error', (e) => console.error('❌ Discord Error:', e.message));
}

connectDiscord();

// ── 5. HTTP PROXY (Resolves External APIs for Frontend) ───────────────────────
const httpServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathName = parsed.pathname;
    const q = parsed.query;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // YouTube Setup Proxy
    if (pathName === '/yt-proxy') {
        let apiPath = '';
        if (q.action === 'resolveChannel') {
            apiPath = `channels?part=id&forHandle=${encodeURIComponent(q.handle)}`;
        } else if (q.action === 'findLive') {
            apiPath = `search?part=id&channelId=${encodeURIComponent(q.channelId)}&type=video&eventType=live`;
        }

        if (!apiPath) { res.writeHead(400); res.end('Invalid Action'); return; }

        googleFetch(apiPath, (err, data) => {
            if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        });
        return;
    }

    // Kick Chatroom Proxy
    if (pathName === '/kick-chatroom') {
        const slug = (q.slug || '').toLowerCase().trim();
        https.get(`https://kick.com/api/v1/channels/${slug}`, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (MultiChatBridge/1.0)' } 
        }, (apiRes) => {
            let d = '';
            apiRes.on('data', chunk => d += chunk);
            apiRes.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ chatroomId: json?.chatroom?.id }));
                } catch(e) { res.writeHead(500); res.end('Parse Error'); }
            });
        }).on('error', (e) => {
            res.writeHead(500); res.end(e.message);
        });
        return;
    }

    // Default Health Status
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MultiChat Bridge Engine: Operational');
});

httpServer.listen(HTTP_PORT, () => {
    console.log(`🌐 Proxy Status:  http://localhost:${HTTP_PORT}`);
    console.log(`🔗 WS Status:     ws://localhost:${WS_PORT}`);
    console.log('────────────────────────────────────────────────────────────');
});

// ── 6. PROCESS PROTECTION & CLEANUP ──────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message);
});
process.on('SIGINT', () => {
    console.log('🛑 Shutting down bridge gracefully...');
    process.exit(0);
});