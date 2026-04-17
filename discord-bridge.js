/**
 * discord-bridge.js — MultiChat (Enterprise/Production Build)
 * * This is the COMPLETE, unified bridge that handles:
 * 1. Discord Gateway (Bot)
 * 2. Active YouTube Polling (No browser needed)
 * 3. Local Settings Discovery (Electron pathing)
 * 4. HTTP Proxy for Setup resolution
 * 5. Multi-client WebSocket Server
 */

const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const url        = require('url');
const fs         = require('fs');
const path       = require('path');
const vm         = require('vm');

// ── 1. GLOBAL STATE & CONFIG ────────────────────────────────────────────────
let BOT_TOKEN  = '';
let CHANNEL_ID = '';
let YT_API_KEY = '';
let YT_CHAN_ID = '';

const WS_PORT   = parseInt(process.env.DISCORD_BRIDGE_WS_PORT) || 8081;
const HTTP_PORT = WS_PORT + 1;

/**
 * LOCATE CONFIGURATION
 * Checks 1: Environment Variables (Railway)
 * Checks 2: Local Electron UserData folder (Production)
 * Checks 3: Root-level config.js (Development)
 */
function initializeConfiguration() {
  // Try Electron UserData Folder first
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
      console.log('📂 Loaded settings from Electron UserData.');
    } catch (e) { console.error('❌ Error reading Electron settings:', e.message); }
  } 
  else if (fs.existsSync('./config.js')) {
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
        console.log('📂 Loaded settings from local config.js.');
      }
    } catch (e) { console.error('❌ Error reading config.js:', e.message); }
  }

  // Final override with Environment Variables (Priority for Railway)
  BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || BOT_TOKEN;
  CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || CHANNEL_ID;
  YT_API_KEY = process.env.YOUTUBE_API_KEY    || YT_API_KEY;
  YT_CHAN_ID = process.env.YOUTUBE_CHANNEL_ID || YT_CHAN_ID;
}

initializeConfiguration();

// ── 2. WEBSOCKET SERVER (Central Hub) ────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Connection opened (${clients.size} total)`);
  
  ws.send(JSON.stringify({
    platform: 'discord',
    username: 'System',
    text: 'Bridge online and listening...'
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Connection closed (${clients.size} remaining)`);
  });
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// ── 3. YOUTUBE ACTIVE POLLING ENGINE ─────────────────────────────────────────
let ytLiveChatId = null;
let ytNextPageToken = null;

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

function startYoutubeEngine() {
  if (!YT_API_KEY || !YT_CHAN_ID) {
    console.log('🎥 YouTube polling disabled (Settings missing).');
    return;
  }

  const findStream = () => {
    console.log('🎥 Searching for active YouTube stream...');
    const searchPath = `search?part=id&channelId=${encodeURIComponent(YT_CHAN_ID)}&type=video&eventType=live`;
    
    googleFetch(searchPath, (err, data) => {
      const videoId = data?.items?.[0]?.id?.videoId;
      if (!videoId) {
        return setTimeout(findStream, 120000); // Retry 2 mins
      }

      googleFetch(`videos?part=liveStreamingDetails&id=${videoId}`, (err2, data2) => {
        ytLiveChatId = data2?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
        if (ytLiveChatId) {
          console.log(`✅ Found Live Chat ID: ${ytLiveChatId}`);
          ytNextPageToken = null;
          pollChat();
        } else {
          setTimeout(findStream, 60000);
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
      if (data.items) {
        data.items.forEach(item => {
          broadcast({
            platform: 'youtube',
            username: item.authorDetails.displayName,
            text: item.snippet.displayMessage
          });
        });
      }

      setTimeout(pollChat, data.pollingIntervalMillis || 5000);
    });
  };

  findStream();
}

startYoutubeEngine();

// ── 4. DISCORD GATEWAY CONNECTION ────────────────────────────────────────────
let discordWs, heartbeatInterval, sequence = null;

function connectDiscord() {
  if (!BOT_TOKEN) return;
  
  console.log('🤖 Connecting to Discord Gateway...');
  discordWs = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

  discordWs.on('message', (raw) => {
    let p; try { p = JSON.parse(raw); } catch { return; }
    const { op, d, s, t } = p;
    if (s !== null) sequence = s;

    if (op === 10) { // HELLO
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (discordWs.readyState === WebSocket.OPEN) {
          discordWs.send(JSON.stringify({ op: 1, d: sequence }));
        }
      }, d.heartbeat_interval);

      // IDENTIFY
      discordWs.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents: (1 << 9) | (1 << 15),
          properties: { os: 'linux', browser: 'multichat', device: 'multichat' }
        }
      }));
    }

    if (op === 0 && t === 'MESSAGE_CREATE') {
      if (d.channel_id !== CHANNEL_ID || d.author?.bot) return;
      const username = d.member?.nick || d.author?.global_name || d.author?.username || 'User';
      broadcast({ platform: 'discord', username, text: d.content });
    }

    if (op === 7 || op === 9) { discordWs.terminate(); }
  });

  discordWs.on('close', () => {
    clearInterval(heartbeatInterval);
    setTimeout(connectDiscord, 5000);
  });

  discordWs.on('error', (e) => console.error('🤖 Discord Error:', e.message));
}

connectDiscord();

// ── 5. HTTP PROXY (For HTML/Setup communication) ────────────────────────────
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathName = parsed.pathname;
  const q = parsed.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathName === '/yt-proxy') {
    let apiPath = '';
    if (q.action === 'resolveChannel') {
      apiPath = `channels?part=id&forHandle=${encodeURIComponent(q.handle)}`;
    } else if (q.action === 'findLive') {
      apiPath = `search?part=id&channelId=${encodeURIComponent(q.channelId)}&type=video&eventType=live`;
    }

    if (!apiPath) { res.writeHead(400); res.end('Invalid Proxy Action'); return; }

    googleFetch(apiPath, (err, data) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  if (pathName === '/kick-chatroom') {
    const slug = (q.slug || '').toLowerCase().trim();
    https.get(`https://kick.com/api/v1/channels/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (apiRes) => {
      let d = '';
      apiRes.on('data', chunk => d += chunk);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(d);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ chatroomId: json?.chatroom?.id }));
        } catch(e) { res.writeHead(500); res.end('Error parsing Kick'); }
      });
    });
    return;
  }

  res.writeHead(200);
  res.end('MultiChat Bridge is Running.');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP Server: http://localhost:${HTTP_PORT}`);
  console.log(`🔗 WS Server:   ws://localhost:${WS_PORT}`);
});

// ── 6. PROCESS PROTECTION ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});