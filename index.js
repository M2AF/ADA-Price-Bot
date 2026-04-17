require("dotenv").config();

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1217523827274158232';
const WS_PORT    = parseInt(process.env.PORT) || 8080;

const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const WebSocket = require("ws");

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── WebSocket bridge server → multichat.html ──────────────────────────────────
const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('listening', () => console.log(`[Bridge] WS listening on port ${WS_PORT}`));
wss.on('error',     (e) => console.error('[Bridge] WS error:', e.message));

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[Bridge] MultiChat connected (${clients.size} client(s))`);
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Bridge] MultiChat disconnected (${clients.size} client(s))`);
  });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── ADA price ticker ──────────────────────────────────────────────────────────
async function getADAPrice() {
  const url  = "https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd&include_24hr_change=true";
  const res  = await fetch(url);
  const data = await res.json();
  return { price: data.cardano.usd, change: data.cardano.usd_24h_change };
}

async function updatePrice() {
  try {
    const { price, change } = await getADAPrice();
    const arrow  = change >= 0 ? "▲" : "▼";
    const status = `ADA $${price.toFixed(4)} ${arrow}${Math.abs(change).toFixed(2)}% 24h`;
    client.user.setActivity(status, { type: ActivityType.Watching });
    console.log(`[ADA] ${status}`);
  } catch (err) {
    console.error("[ADA] Error:", err.message);
  }
}

// ── Bot events ────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`[Bot] Online as: ${client.user.tag}`);
  console.log(`[Bridge] Watching channel: ${CHANNEL_ID}`);
  updatePrice();
  setInterval(updatePrice, 5 * 60 * 1000);
});

client.on("messageCreate", (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.bot) return;

  const username = message.member?.nickname
    || message.author.globalName
    || message.author.username;
  const text = message.content;

  if (!text.trim()) return;

  console.log(`[Discord] ${username}: ${text}`);
  broadcast({ platform: 'discord', username, text });
});

client.login(BOT_TOKEN);
