/**
 * unified-bridge.js — MultiChat (Enterprise Build)
 * Combined Features: Discord Gateway + ADA Price Ticker + YouTube API Polling + HTTP Proxy
 * Single Port: Optimized for Railway (uses process.env.PORT)
 */

const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── 1. GLOBAL CONFIGURATION & STATE ──────────────────────────────────────────
let BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || '';
let CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1217523827274158232';
let YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
let YT_CHAN_ID = process.env.YOUTUBE_CHANNEL_ID || '';

// Single Port for Railway (Supports both WS and HTTP via the same server)
const PORT = parseInt(process.env.PORT) || 8080;

// ── 2. INITIALIZATION ENGINE ──────────────────────────────────────────────────
function initializeConfiguration() {
    console.log('────────────────────────────────────────────────────────────');
    console.log('🚀 INITIALIZING UNIFIED MULTICHAT ENGINE');
    
    // Check Electron UserData (for local dev fallback)
    const appName = 'multichat';
    const userData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.config'));
    const electronSettings = path.join(userData, appName, 'multichat-settings.json');

    if (fs.existsSync(electronSettings)) {
        try {
            const s = JSON.parse(fs.readFileSync(electronSettings, 'utf8'));
            BOT_TOKEN  = s.DISCORD_BOT_TOKEN  || BOT_TOKEN;
            CHANNEL_ID = s.DISCORD_CHANNEL_ID || CHANNEL_ID;
            YT_API_KEY = s.YOUTUBE_API_KEY    || YT_API_KEY;
            YT_CHAN_ID = s.YOUTUBE_CHANNEL_ID || YT_CHAN_ID;
            console.log('📁 Settings loaded from Electron storage.');
        } catch (e) { console.error('❌ Config Parse Error:', e.message); }
    }

    // Check config.js fallback
    if (fs.existsSync('./config.js')) {
        try {
            const raw = fs.readFileSync('./config.js', 'utf8');
            const ctx = {};
            vm.createContext(ctx);
            vm.runInContext(raw, ctx);
            if (ctx.CONFIG) {
                BOT_TOKEN  = ctx.CONFIG.DISCORD_BOT_TOKEN  || BOT_TOKEN;
                CHANNEL_ID = ctx.CONFIG.DISCORD_CHANNEL_ID || CHANNEL_ID;
                YT_API_KEY = ctx.CONFIG.YOUTUBE_API_KEY    || YT_API_KEY;
                YT_CHAN_ID = ctx.CONFIG.YOUTUBE_CHANNEL_ID || YT_CHAN_ID;
                console.log('📁 Settings loaded from config.js.');
            }
        } catch (e) {}
    }
}
initializeConfiguration();

// DEBUG — remove after confirming YouTube works
console.log('[YouTube Debug] API Key set:', !!YT_API_KEY, '| Channel ID:', YT_CHAN_ID);

// ── 3. UNIFIED SERVER (WS + HTTP) ─────────────────────────────────────────────
const httpServer = http.createServer();
const wss = new WebSocket.Server({ server: httpServer });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`📡 Client Connected. Total: ${clients.size}`);
    ws.send(JSON.stringify({ platform: 'system', text: 'Unified Bridge Online.' }));
    ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
    const data = JSON.stringify(payload);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

// ── 4. DISCORD BOT & ADA TICKER ───────────────────────────────────────────────
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

async function updateADAPrice() {
    try {
        // Using https for node-fetch style request in Node 18+ or standard https
        const priceUrl = "https://api.coingecko.com/price/v3/simple/price?ids=cardano&vs_currencies=usd&include_24hr_change=true";
        https.get(priceUrl, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const data = JSON.parse(body);
                const price = data.cardano.usd;
                const change = data.cardano.usd_24h_change;
                const arrow = change >= 0 ? "▲" : "▼";
                const status = `ADA $${price.toFixed(4)} ${arrow}${Math.abs(change).toFixed(2)}%`;
                discordClient.user.setActivity(status, { type: ActivityType.Watching });
                console.log(`🪙 [ADA] ${status}`);
            });
        });
    } catch (e) { console.error('❌ ADA Ticker Error:', e.message); }
}

discordClient.once('ready', () => {
    console.log(`✅ Discord Bot Authenticated: ${discordClient.user.tag}`);
    updateADAPrice();
    setInterval(updateADAPrice, 5 * 60 * 1000); // 5 min refresh
});

discordClient.on('messageCreate', (msg) => {
    if (msg.channelId !== CHANNEL_ID || msg.author.bot) return;
    broadcast({
        platform: 'discord',
        username: msg.member?.displayName || msg.author.username,
        text: msg.content
    });
});

if (BOT_TOKEN) discordClient.login(BOT_TOKEN);

// ── 5. YOUTUBE ACTIVE POLLING ENGINE ──────────────────────────────────────────
let ytLiveChatId = null;
let ytNextPageToken = null;

function googleFetch(apiPath, callback) {
    if (!YT_API_KEY) {
        callback(new Error('YOUTUBE_API_KEY not configured on server'));
        return;
    }
    const fullUrl = `https://www.googleapis.com/youtube/v3/${apiPath}&key=${YT_API_KEY}`;
    https.get(fullUrl, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
            try { callback(null, JSON.parse(raw)); } catch (e) { callback(e); }
        });
    }).on('error', callback);
}

function startYoutubeEngine() {
    if (!YT_API_KEY || !YT_CHAN_ID) return;

    const findStream = () => {
        googleFetch(`search?part=id&channelId=${encodeURIComponent(YT_CHAN_ID)}&type=video&eventType=live`, (err, data) => {
            const vId = data?.items?.[0]?.id?.videoId;
            if (!vId) return setTimeout(findStream, 120000); // Try every 2 mins if offline
            
            googleFetch(`videos?part=liveStreamingDetails&id=${vId}`, (err2, data2) => {
                ytLiveChatId = data2?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
                if (ytLiveChatId) {
                    console.log(`🎥 YouTube Chat Live: ${ytLiveChatId}`);
                    pollChat();
                } else {
                    setTimeout(findStream, 60000);
                }
            });
        });
    };

    const pollChat = () => {
        if (!ytLiveChatId) return findStream();
        let path = `liveChat/messages?liveChatId=${encodeURIComponent(ytLiveChatId)}&part=snippet,authorDetails&maxResults=200`;
        if (ytNextPageToken) path += `&pageToken=${encodeURIComponent(ytNextPageToken)}`;

        googleFetch(path, (err, data) => {
            if (err || !data.items) { ytLiveChatId = null; return setTimeout(findStream, 15000); }
            ytNextPageToken = data.nextPageToken;
            data.items.forEach(item => {
                broadcast({
                    platform: 'youtube',
                    username: item.authorDetails.displayName,
                    text: item.snippet.displayMessage
                });
            });
            setTimeout(pollChat, data.pollingIntervalMillis || 5000);
        });
    };
    findStream();
}
startYoutubeEngine();

// ── 6. HTTP API PROXY (For Setup Support) ────────────────────────────────────
httpServer.on('request', (req, res) => {
    const parsed = url.parse(req.url, true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (parsed.pathname === '/yt-proxy') {
        const action = parsed.query.action;
        let apiPath = '';

        if (action === 'resolveChannel') {
            // Resolve a @handle → channel ID
            apiPath = `channels?part=id&forHandle=${encodeURIComponent(parsed.query.handle)}`;
        } else if (action === 'findLive') {
            // Find active livestream video ID for a channel
            apiPath = `search?part=id&channelId=${encodeURIComponent(parsed.query.channelId)}&type=video&eventType=live`;
        } else if (action === 'getLiveChatId') {
            // Get the liveChatId from a video ID
            apiPath = `videos?part=liveStreamingDetails&id=${encodeURIComponent(parsed.query.videoId)}`;
        } else if (action === 'poll') {
            // Poll live chat messages
            apiPath = `liveChat/messages?liveChatId=${encodeURIComponent(parsed.query.liveChatId)}&part=snippet,authorDetails&maxResults=200`;
            if (parsed.query.pageToken) apiPath += `&pageToken=${encodeURIComponent(parsed.query.pageToken)}`;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown action: ' + action }));
            return;
        }

        if (!apiPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required parameters' }));
            return;
        }

        googleFetch(apiPath, (err, data) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            if (err) {
                res.end(JSON.stringify({ error: err.message }));
            } else {
                res.end(JSON.stringify(data || { error: 'Empty response from YouTube API' }));
            }
        });
    } else if (parsed.pathname === '/kick-chatroom') {
        const slug = parsed.query.slug;
        https.get(`https://kick.com/api/v1/channels/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (kRes) => {
            let body = '';
            kRes.on('data', c => body += c);
            kRes.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ chatroomId: json?.chatroom?.id }));
                } catch(e) { res.end('{}'); }
            });
        });
    } else {
        res.writeHead(200);
        res.end('MultiChat Unified Bridge Status: Online');
    }
});

// ── 7. STARTUP ───────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`🌐 Unified HTTP/WS Server running on port ${PORT}`);
    console.log(`🔗 Discord Channel: ${CHANNEL_ID}`);
    console.log(`────────────────────────────────────────────────────────────`);
});

process.on('unhandledRejection', (r) => console.error('💥 Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('💥 Uncaught Exception:', e.message));