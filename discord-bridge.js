/**
 * discord-bridge.js — MultiChat (Full & Fixed)
 *
 * This file handles:
 * 1. Active YouTube Polling — Automatically finds your stream and sends chat to the overlay.
 * 2. Discord Gateway — Connects as a bot to forward Discord messages.
 * 3. WebSocket Server — The central hub that your multichat.html connects to.
 * 4. HTTP Proxy — Supports the setup page (resolving handles/chat IDs).
 *
 * Requirements: node >= 16, npm install ws
 */

const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const url        = require('url');
const fs         = require('fs');
const vm         = require('vm');

// ── 1. CONFIGURATION LOADING ────────────────────────────────────────────────
let BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || '';
let CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
let YT_API_KEY = process.env.YOUTUBE_API_KEY    || '';
let YT_CHAN_ID = process.env.YOUTUBE_CHANNEL_ID || ''; 

const WS_PORT   = parseInt(process.env.DISCORD_BRIDGE_WS_PORT || process.env.PORT) || 8081;
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || (WS_PORT + 1);

try {
  if (fs.existsSync('./config.js')) {
    const raw = fs.readFileSync('./config.js', 'utf8');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(raw, ctx);
    const C = ctx.CONFIG;
    if (C) {
      BOT_TOKEN  = BOT_TOKEN  || C.DISCORD_BOT_TOKEN  || '';
      CHANNEL_ID = CHANNEL_ID || C.DISCORD_CHANNEL_ID || '';
      YT_API_KEY = YT_API_KEY || C.YOUTUBE_API_KEY    || '';
      YT_CHAN_ID = YT_CHAN_ID || C.YOUTUBE_CHANNEL_ID || '';
    }
  }
} catch(e) {
  console.warn('⚠️  config.js not found, using Environment Variables only.');
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║                MultiChat Bridge Service                    ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`📡 WebSocket Port: ${WS_PORT}`);
console.log(`🌐 HTTP Proxy Port: ${HTTP_PORT}`);
console.log(`🤖 Discord: ${CHANNEL_ID ? 'READY' : 'NOT CONFIGURED'}`);
console.log(`🎥 YouTube: ${YT_CHAN_ID ? 'READY' : 'NOT CONFIGURED'}`);

// ── 2. WEBSOCKET SERVER ─────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client Connected. Total: ${clients.size}`);
  
  // Welcome Message
  ws.send(JSON.stringify({
    platform: 'discord',
    username: 'System',
    text: 'Bridge Connection Established.'
  }));

  ws.on('close', () => {
    clients.add(ws);
    clients.delete(ws);
    console.log(`[WS] Client Disconnected. Total: ${clients.size}`);
  });
});

function broadcast(payload) {
  const message = JSON.stringify(payload);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ── 3. YOUTUBE API CORE ─────────────────────────────────────────────────────
let ytLiveChatId = null;
let ytNextPageToken = null;

/** Core fetcher for Google API */
function googleApiFetch(apiPath, callback) {
  if (!YT_API_KEY) return callback(new Error('Missing YouTube API Key'));
  
  const fullUrl = `https://www.googleapis.com/youtube/v3/${apiPath}&key=${YT_API_KEY}`;
  https.get(fullUrl, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { 
        const parsed = JSON.parse(data);
        if (parsed.error) callback(new Error(parsed.error.message));
        else callback(null, parsed);
      } catch(e) { callback(e); }
    });
  }).on('error', callback);
}

/** * Active Polling Loop 
 * This ensures YouTube chat works even if the browser refresh/scrapers fail.
 */
function startYoutubeActiveEngine() {
  if (!YT_API_KEY || !YT_CHAN_ID || YT_CHAN_ID.includes('YOUR_')) {
    console.log('[YouTube] Setup incomplete. Skipping active polling.');
    return;
  }

  const findLive = () => {
    console.log('[YouTube] Searching for active live stream...');
    const path = `search?part=id&channelId=${encodeURIComponent(YT_CHAN_ID)}&type=video&eventType=live`;
    
    googleApiFetch(path, (err, data) => {
      const videoId = data?.items?.[0]?.id?.videoId;
      if (!videoId) {
        // Retry searching every 2 minutes if offline
        return setTimeout(findLive, 120000);
      }

      googleApiFetch(`videos?part=liveStreamingDetails&id=${videoId}`, (err2, data2) => {
        ytLiveChatId = data2?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
        if (ytLiveChatId) {
          console.log(`[YouTube] Live Chat Found: ${ytLiveChatId}`);
          ytNextPageToken = null;
          pollMessages();
        } else {
          setTimeout(findLive, 30000);
        }
      });
    });
  };

  const pollMessages = () => {
    if (!ytLiveChatId) return findLive();

    let path = `liveChat/messages?liveChatId=${encodeURIComponent(ytLiveChatId)}&part=snippet,authorDetails&maxResults=200`;
    if (ytNextPageToken) path += `&pageToken=${encodeURIComponent(ytNextPageToken)}`;

    googleApiFetch(path, (err, data) => {
      if (err) {
        console.error(`[YouTube] Poll Error: ${err.message}`);
        ytLiveChatId = null;
        return setTimeout(findLive, 10000);
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

      const delay = data.pollingIntervalMillis || 5000;
      setTimeout(pollMessages, delay);
    });
  };

  findLive();
}

// ── 4. HTTP PROXY & HEALTH ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const q      = parsed.query;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health Check
  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online', 
      discord: !!discordWs, 
      youtube_active: !!ytLiveChatId 
    }));
    return;
  }

  // YouTube Proxy (Action-based for Setup Page)
  if (path === '/yt-proxy') {
    const action = q.action;
    let apiPath = '';

    if (action === 'resolveChannel') {
      const handle = q.handle.startsWith('@') ? q.handle : '@' + q.handle;
      apiPath = `channels?part=id&forHandle=${encodeURIComponent(handle)}`;
    } else if (action === 'findLive') {
      apiPath = `search?part=id&channelId=${encodeURIComponent(q.channelId)}&type=video&eventType=live`;
    } else if (action === 'getLiveChatId') {
      apiPath = `videos?part=liveStreamingDetails&id=${encodeURIComponent(q.videoId)}`;
    } else if (action === 'poll') {
      apiPath = `liveChat/messages?liveChatId=${encodeURIComponent(q.liveChatId)}&part=snippet,authorDetails&maxResults=200`;
      if (q.pageToken) apiPath += `&pageToken=${encodeURIComponent(q.pageToken)}`;
    }

    if (!apiPath) { res.writeHead(400); res.end('Invalid Action'); return; }

    googleApiFetch(apiPath, (err, data) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  // Kick Chatroom Resolver Proxy
  if (path === '/kick-chatroom') {
    const slug = (q.slug || '').toLowerCase().trim();
    if (!slug) { res.writeHead(400); res.end('Missing Slug'); return; }

    https.get(`https://kick.com/api/v1/channels/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 MultiChatBridge/1.0' }
    }, (kickRes) => {
      let d = '';
      kickRes.on('data', chunk => d += chunk);
      kickRes.on('end', () => {
        try {
          const p = JSON.parse(d);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ chatroomId: p?.chatroom?.id }));
        } catch(e) {
          res.writeHead(500); res.end(JSON.stringify({ error: 'Failed to parse Kick API' }));
        }
      });
    }).on('error', (e) => {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(HTTP_PORT);

// ── 5. DISCORD GATEWAY ──────────────────────────────────────────────────────
let discordWs, heartbeatInterval, sequence = null;
let sessionId = null, resumeUrl = null;

function connectDiscord() {
  if (!BOT_TOKEN || BOT_TOKEN.includes('YOUR_')) return;

  const gatewayUrl = resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';
  console.log(`[Discord] Connecting to ${resumeUrl ? 'Resume' : 'New'} Session...`);
  
  discordWs = new WebSocket(gatewayUrl);

  discordWs.on('open', () => {
    if (sessionId && resumeUrl) {
      // Resume
      discordWs.send(JSON.stringify({
        op: 6,
        d: { token: BOT_TOKEN, session_id: sessionId, seq: sequence }
      }));
    } else {
      // Identify
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
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    
    const { op, d, s, t } = payload;
    if (s !== null) sequence = s;

    // Op 10: Hello (Heartbeat setup)
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
        console.log(`[Discord] Authenticated as ${d.user.username}`);
      }

      if (t === 'MESSAGE_CREATE') {
        if (d.channel_id !== CHANNEL_ID || d.author?.bot) return;
        
        const username = d.member?.nick || d.author?.global_name || d.author?.username || 'User';
        const text     = (d.content || '').trim();
        if (!text) return;

        console.log(`[Discord] ${username}: ${text}`);
        broadcast({ platform: 'discord', username, text });
      }
    }

    // Reconnect Commands
    if (op === 7) { 
      console.log('[Discord] Gateway Reconnect Requested'); 
      discordWs.terminate(); 
    }
    if (op === 9) { 
      console.warn('[Discord] Invalid Session, restarting...');
      sessionId = null; resumeUrl = null; 
      discordWs.terminate(); 
    }
  });

  discordWs.on('close', (code) => {
    clearInterval(heartbeatInterval);
    console.log(`[Discord] Connection Closed (${code}). Retrying in 5s...`);
    setTimeout(connectDiscord, 5000);
  });

  discordWs.on('error', (err) => console.error(`[Discord] Error: ${err.message}`));
}

// ── 6. INITIALIZATION ───────────────────────────────────────────────────────
connectDiscord();
startYoutubeActiveEngine();

/**
 * CLEANUP HANDLERS
 */
process.on('SIGINT', () => {
  console.log('Shutting down bridge...');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection at:', reason.stack || reason);
});