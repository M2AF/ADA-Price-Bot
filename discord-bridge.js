/**
 * discord-bridge.js — CriptoEjesus MultiChat
 *
 * Handles:
 *   - Discord Gateway  → forwards chat to multichat clients via WebSocket
 *   - YouTube Live Chat polling → forwards to multichat clients
 *   - GET /kick-channel-id?channel=xxx → CORS proxy so the browser can get the Kick chatroom ID
 *
 * Requirements: node >= 16, npm install ws
 *
 * Env vars (set in Railway dashboard):
 *   DISCORD_BOT_TOKEN
 *   DISCORD_CHANNEL_ID
 *   YOUTUBE_API_KEY
 *   YOUTUBE_CHANNEL_ID   ← your UCxxxx channel ID (not the handle)
 *   PORT                 ← set automatically by Railway
 */

const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const url       = require('url');

// ── Environment ───────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID;
const YT_API_KEY      = process.env.YOUTUBE_API_KEY;
const YT_CHANNEL_ID   = process.env.YOUTUBE_CHANNEL_ID;
const PORT            = parseInt(process.env.PORT || '8081', 10);

if (!BOT_TOKEN) { console.error('❌  DISCORD_BOT_TOKEN not set'); process.exit(1); }

console.log('✅  Config loaded');
console.log(`    Discord channel : ${DISCORD_CHANNEL}`);
console.log(`    YouTube channel : ${YT_CHANNEL_ID  || '(not set — YT disabled)'}`);
console.log(`    YouTube API key : ${YT_API_KEY ? '✓ present' : '✗ missing — YT disabled'}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    https.get(reqUrl, { headers: { 'User-Agent': 'multichat-bridge/1.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse failed: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ── HTTP server (WS upgrades + REST endpoints) ────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS — allow any origin (the browser APK needs this)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /kick-channel-id?channel=criptoejesus ─────────────────────────────
  if (pathname === '/kick-channel-id') {
    const channel = parsed.query.channel;
    if (!channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'channel param required' }));
      return;
    }

    const kickUrl = `https://kick.com/api/v1/channels/${encodeURIComponent(channel)}`;
    console.log(`🎯  Kick lookup: ${kickUrl}`);

    https.get(kickUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (kickRes) => {
      let body = '';
      kickRes.on('data', d => body += d);
      kickRes.on('end', () => {
        try {
          const json = JSON.parse(body);
          // Kick returns the chatroom id nested under chatroom.id
          const id = json.chatroom?.id || json.id;
          if (!id) throw new Error('chatroom id not found');
          console.log(`✅  Kick chatroom id for "${channel}": ${id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
        } catch (e) {
          console.error('❌  Kick parse error:', e.message, body.slice(0, 200));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to parse Kick response' }));
        }
      });
    }).on('error', (e) => {
      console.error('❌  Kick fetch error:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', wsClients: clients.size }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ server: httpServer });
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`🔗  Client connected (${clients.size} total) from ${req.socket.remoteAddress}`);
  ws.send(JSON.stringify({
    platform: 'discord',
    username: 'Bridge',
    text: '✅ Connected — Discord + YouTube + Kick active'
  }));
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌  Client disconnected (${clients.size} remaining)`);
  });
});

function broadcast(payload) {
  const msg  = JSON.stringify(payload);
  let   sent = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
  });
  if (sent > 0) {
    console.log(`📡  [${payload.platform}] ${payload.username}: ${String(payload.text).slice(0, 80)}`);
  }
}

httpServer.listen(PORT, () => {
  console.log(`✅  Bridge listening on port ${PORT}`);
});

// ── Discord Gateway ───────────────────────────────────────────────────────────
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS         = (1 << 9) | (1 << 15); // GUILD_MESSAGES + MESSAGE_CONTENT

let heartbeatInterval = null;
let sequence          = null;
let discordWs         = null;
let resumeUrl         = null;

function connectDiscord() {
  const wsUrl = resumeUrl || DISCORD_GATEWAY;
  console.log('🔄  Connecting to Discord Gateway…');
  discordWs = new WebSocket(wsUrl);

  discordWs.on('open', () => console.log('✅  Discord Gateway connected'));

  discordWs.on('message', (raw) => {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const { op, d, s, t } = payload;

    if (s != null) sequence = s;

    // Op 10 Hello
    if (op === 10) {
      const jitter = d.heartbeat_interval * Math.random();
      setTimeout(sendHeartbeat, jitter);
      heartbeatInterval = setInterval(sendHeartbeat, d.heartbeat_interval);
      discordWs.send(JSON.stringify({
        op: 2,
        d: { token: BOT_TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'multichat', device: 'multichat' } }
      }));
    }

    // Op 0 Dispatch
    if (op === 0) {
      if (t === 'READY') {
        resumeUrl = d.resume_gateway_url + '/?v=10&encoding=json';
        console.log(`🤖  Discord logged in as ${d.user.username} — watching channel ${DISCORD_CHANNEL}`);
      }
      if (t === 'MESSAGE_CREATE') {
        if (d.channel_id !== DISCORD_CHANNEL || d.author?.bot) return;
        const username = d.member?.nick || d.author?.global_name || d.author?.username || 'Discord User';
        const text     = (d.content || '').trim();
        if (!text) return;
        broadcast({ platform: 'discord', username, text });
      }
    }

    if (op === 7) { console.log('🔁  Discord reconnect requested'); reconnectDiscord(); }
    if (op === 9) {
      console.warn('⚠️  Discord invalid session — re-identifying in 5s');
      resumeUrl = null;
      setTimeout(connectDiscord, 5000);
    }
  });

  discordWs.on('close', (code) => {
    clearInterval(heartbeatInterval);
    console.warn(`⚠️  Discord closed (${code}) — reconnecting in 5s`);
    setTimeout(connectDiscord, 5000);
  });

  discordWs.on('error', (err) => console.error('❌  Discord WS error:', err.message));
}

function sendHeartbeat() {
  if (discordWs?.readyState === WebSocket.OPEN) {
    discordWs.send(JSON.stringify({ op: 1, d: sequence }));
  }
}

function reconnectDiscord() {
  clearInterval(heartbeatInterval);
  discordWs?.terminate();
  setTimeout(connectDiscord, 1000);
}

connectDiscord();

// ── YouTube Live Chat Poller ──────────────────────────────────────────────────
// Quota cost: ~5 units per poll. At 1 poll/5s = 86,400 units/day.
// Free quota is 10,000/day — so we use 8s intervals to stay safe (~47k/day).
// Only polls when a live stream is active.

let ytLiveChatId     = null;
let ytNextPageToken  = null;
let ytPollTimer      = null;
let ytSeenIds        = new Set();

async function findYtLiveChatId() {
  try {
    const search = await httpsGet(
      `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${YT_CHANNEL_ID}&eventType=live&type=video&key=${YT_API_KEY}`
    );
    const videoId = search.items?.[0]?.id?.videoId;
    if (!videoId) { console.log('📺  YouTube: no active live stream'); return null; }

    const video = await httpsGet(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${YT_API_KEY}`
    );
    const chatId = video.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) { console.log('📺  YouTube: stream found but no active live chat'); return null; }

    console.log(`📺  YouTube live chat found: ${chatId} (video: ${videoId})`);
    return chatId;
  } catch (e) {
    console.error('❌  YouTube findLiveChatId:', e.message);
    return null;
  }
}

async function pollYt() {
  if (!ytLiveChatId) return;
  try {
    let reqUrl = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${ytLiveChatId}&part=snippet,authorDetails&maxResults=200&key=${YT_API_KEY}`;
    if (ytNextPageToken) reqUrl += `&pageToken=${ytNextPageToken}`;

    const data = await httpsGet(reqUrl);

    if (data.error) {
      const code = data.error.code;
      console.error(`❌  YouTube API error ${code}: ${data.error.message}`);
      // Chat ended or forbidden — reset and go looking again
      if (code === 403 || code === 404) {
        ytLiveChatId    = null;
        ytNextPageToken = null;
        scheduleYtSearch(60000);
      }
      return;
    }

    ytNextPageToken = data.nextPageToken;

    for (const item of (data.items || [])) {
      if (ytSeenIds.has(item.id)) continue;
      ytSeenIds.add(item.id);
      if (item.snippet?.type !== 'textMessageEvent') continue;
      const username = item.authorDetails?.displayName || 'YouTube User';
      const text     = item.snippet?.textMessageDetails?.messageText || '';
      if (text.trim()) broadcast({ platform: 'youtube', username, text });
    }

    // Trim seen set to avoid unbounded growth
    if (ytSeenIds.size > 3000) ytSeenIds = new Set([...ytSeenIds].slice(-500));

  } catch (e) {
    console.error('❌  YouTube poll error:', e.message);
  }
}

function scheduleYtSearch(delay = 0) {
  if (!YT_API_KEY || !YT_CHANNEL_ID) {
    console.log('📺  YouTube disabled (YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID not set)');
    return;
  }
  setTimeout(async () => {
    ytLiveChatId = await findYtLiveChatId();
    if (ytLiveChatId) {
      if (ytPollTimer) clearInterval(ytPollTimer);
      ytPollTimer = setInterval(pollYt, 8000); // poll every 8s
    } else {
      scheduleYtSearch(60000); // retry search in 60s
    }
  }, delay);
}

scheduleYtSearch();
