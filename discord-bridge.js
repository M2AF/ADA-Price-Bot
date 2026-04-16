/**
 * discord-bridge.js — MultiChat
 *
 * Does three things:
 *   1. Connects to the Discord Gateway and forwards messages to MultiChat
 *   2. Serves a local WebSocket → multichat.html
 *   3. Serves an HTTP /yt-proxy endpoint so the overlay can poll YouTube
 *      Live Chat without exposing an API key in the HTML file
 *
 * Requirements: node >= 16, npm install ws
 * Run:          node discord-bridge.js
 *
 * Environment variables (set in Railway or a local .env):
 *   DISCORD_BOT_TOKEN       — required for Discord
 *   DISCORD_CHANNEL_ID      — required for Discord
 *   YOUTUBE_API_KEY         — required for YouTube proxy (optional if not used)
 *   DISCORD_BRIDGE_WS_PORT  — WebSocket port (default 8081)
 *   PORT                    — HTTP port (default = WS port + 1, or 8082)
 */

const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const url        = require('url');
const fs         = require('fs');

// ── Load config — env vars first, then config.js fallback ────────────────────
let BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || '';
let CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
let YT_API_KEY = process.env.YOUTUBE_API_KEY    || '';
const WS_PORT  = parseInt(process.env.DISCORD_BRIDGE_WS_PORT || process.env.PORT) || 8081;
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || (WS_PORT + 1);

// Fallback: load from config.js if env vars not set
if (!BOT_TOKEN || !CHANNEL_ID) {
  try {
    const vm  = require('vm');
    const raw = fs.readFileSync('./config.js', 'utf8');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(raw, ctx);
    const C = ctx.CONFIG;
    if (C) {
      BOT_TOKEN  = BOT_TOKEN  || C.DISCORD_BOT_TOKEN  || '';
      CHANNEL_ID = CHANNEL_ID || C.DISCORD_CHANNEL_ID || '';
      YT_API_KEY = YT_API_KEY || C.YOUTUBE_API_KEY    || '';
    }
  } catch(e) {
    // config.js not found — fine if env vars are set
  }
}

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_DISCORD_BOT_TOKEN') {
  // Discord is optional if the user only wants YouTube proxy
  console.warn('⚠️  No Discord bot token — Discord forwarding disabled.');
}

console.log(`✅  Bridge starting — Discord channel: ${CHANNEL_ID || '(none)'}`);
console.log(`    YouTube proxy: ${YT_API_KEY ? 'enabled' : 'disabled (no YOUTUBE_API_KEY)'}`);

// ── YouTube proxy helper ──────────────────────────────────────────────────────
// Makes HTTPS requests to YouTube Data API v3 server-side, keeping the API key
// out of the browser. CORS headers allow any origin so the overlay HTML can call it.

function ytFetch(apiPath, callback) {
  const fullUrl = `https://www.googleapis.com/youtube/v3/${apiPath}&key=${YT_API_KEY}`;
  https.get(fullUrl, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { callback(null, JSON.parse(data)); }
      catch(e) { callback(e); }
    });
  }).on('error', callback);
}

// ── HTTP server (YouTube proxy + Kick chatroom lookup) ────────────────────────
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const q      = parsed.query;

  // CORS — allow the local file:// overlay and any hosted origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /yt-proxy?action=findLive&channelId=UC... ──────────────────────────
  // ── GET /yt-proxy?action=poll&liveChatId=...&pageToken=... ────────────────
  if (path === '/yt-proxy') {
    if (!YT_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'YOUTUBE_API_KEY not configured on server' } }));
      return;
    }

    const action = q.action;

    if (action === 'findLive') {
      const channelId = q.channelId || '';
      if (!channelId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing channelId' } }));
        return;
      }
      ytFetch(`search?part=id&channelId=${encodeURIComponent(channelId)}&type=video&eventType=live`, (err, data) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
      return;
    }

    if (action === 'getLiveChatId') {
      const videoId = q.videoId || '';
      if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing videoId' } }));
        return;
      }
      ytFetch(`videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`, (err, data) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
      return;
    }

    if (action === 'poll') {
      const liveChatId  = q.liveChatId  || '';
      const pageToken   = q.pageToken   || '';
      if (!liveChatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing liveChatId' } }));
        return;
      }
      let apiPath = `liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&maxResults=200`;
      if (pageToken) apiPath += `&pageToken=${encodeURIComponent(pageToken)}`;
      ytFetch(apiPath, (err, data) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
      return;
    }

    // ── GET /yt-proxy?action=resolveChannel&handle=@criptoejesus ─────────────
    // Resolves a @handle or channel URL to a channelId using the Search API
    if (action === 'resolveChannel') {
      const handle = (q.handle || '').replace(/^@/, '').trim();
      if (!handle) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing handle' } }));
        return;
      }
      // Try channels forUsername first (works for legacy usernames), then search
      ytFetch(`channels?part=id&forHandle=${encodeURIComponent('@' + handle)}`, (err, data) => {
        if (!err && data?.items?.[0]?.id) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ channelId: data.items[0].id }));
          return;
        }
        // Fallback: search
        ytFetch(`search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1`, (err2, data2) => {
          if (err2 || !data2?.items?.[0]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Channel not found' } }));
            return;
          }
          const channelId = data2.items[0].snippet?.channelId || data2.items[0].id?.channelId;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ channelId }));
        });
      });
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unknown action' } }));
    return;
  }

  // ── GET /kick-chatroom?slug=criptoejesus ──────────────────────────────────
  // Proxies the Kick API to resolve a channel slug → chatroom ID,
  // so the overlay doesn't need corsproxy.io at runtime.
  if (path === '/kick-chatroom') {
    const slug = (q.slug || '').toLowerCase().trim();
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug' }));
      return;
    }

    https.get(`https://kick.com/api/v1/channels/${slug}`, { headers: { 'User-Agent': 'MultiChat/1.0' } }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const chatroomId = parsed?.chatroom?.id;
          if (!chatroomId) throw new Error('No chatroom ID in response');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ chatroomId }));
        } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }).on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:  'ok',
      discord: !!BOT_TOKEN,
      youtube: !!YT_API_KEY,
    }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`✅  HTTP proxy server listening on port ${HTTP_PORT}`);
  console.log(`    YouTube proxy: http://localhost:${HTTP_PORT}/yt-proxy?action=...`);
});

// ── WebSocket server → multichat.html ────────────────────────────────────────
const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🔗  MultiChat connected (${clients.size} client(s))`);
  ws.send(JSON.stringify({
    platform: 'discord',
    username: 'Bridge',
    text: '✅ Discord bridge connected!'
  }));
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌  MultiChat disconnected (${clients.size} client(s))`);
  });
});

wss.on('error', err => console.error('❌  WS server error:', err.message));

function broadcast(payload) {
  const msg  = JSON.stringify(payload);
  let   sent = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
  });
  if (sent) console.log(`📡  Broadcast to ${sent} client(s)`);
}

console.log(`✅  WS server listening on ws://localhost:${WS_PORT}`);

// ── Discord Gateway ───────────────────────────────────────────────────────────
if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_DISCORD_BOT_TOKEN') {
  console.log('ℹ️   Discord gateway skipped (no token).');
} else {
  startDiscord();
}

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS         = (1 << 9) | (1 << 15); // GUILD_MESSAGES + MESSAGE_CONTENT

let heartbeatInterval = null;
let sequence          = null;
let discordWs         = null;
let sessionId         = null;
let resumeUrl         = null;

function startDiscord() {
  connectDiscord();
}

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

    if (op === 10) {
      const jitter = d.heartbeat_interval * Math.random();
      setTimeout(sendHeartbeat, jitter);
      heartbeatInterval = setInterval(sendHeartbeat, d.heartbeat_interval);

      discordWs.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents: INTENTS,
          properties: { os: 'linux', browser: 'multichat', device: 'multichat' }
        }
      }));
    }

    if (op === 11) {} // Heartbeat ACK — silent

    if (op === 0) {
      if (t === 'READY') {
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url + '/?v=10&encoding=json';
        console.log(`🤖  Logged in as ${d.user.username}`);
        console.log(`👂  Watching channel ${CHANNEL_ID}`);
      }

      if (t === 'MESSAGE_CREATE') {
        if (d.channel_id !== CHANNEL_ID) return;
        if (d.author?.bot) return;

        const username = d.member?.nick || d.author?.global_name || d.author?.username || 'Discord User';
        const text     = (d.content || '').trim();
        if (!text) return;

        console.log(`💬  Discord: ${username}: ${text.slice(0, 80)}`);
        broadcast({ platform: 'discord', username, text });
      }
    }

    if (op === 7)  { console.log('🔁  Reconnect requested'); reconnect(); }
    if (op === 9)  { console.warn('⚠️  Invalid session — re-identifying in 5s'); sessionId = null; resumeUrl = null; setTimeout(connectDiscord, 5000); }
  });

  discordWs.on('close', (code) => {
    clearInterval(heartbeatInterval);
    console.warn(`⚠️  Discord closed (${code}) — reconnecting in 5s`);
    setTimeout(connectDiscord, 5000);
  });

  discordWs.on('error', err => console.error('❌  Discord error:', err.message));
}

function sendHeartbeat() {
  if (discordWs?.readyState === WebSocket.OPEN) {
    discordWs.send(JSON.stringify({ op: 1, d: sequence }));
  }
}

function reconnect() {
  clearInterval(heartbeatInterval);
  discordWs?.terminate();
  setTimeout(connectDiscord, 1000);
}
