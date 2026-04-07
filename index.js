require("dotenv").config();
const BOT_TOKEN = process.env.BOT_TOKEN;

const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Fetch ADA price from CoinGecko API
async function getADAPrice() {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd&include_24hr_change=true";

  const res = await fetch(url);
  const data = await res.json();

  const price = data.cardano.usd;
  const change = data.cardano.usd_24h_change;
  return { price, change };
}

async function updatePrice() {
  try {
    const { price, change } = await getADAPrice();

    const arrow = change >= 0 ? "▲" : "▼";

    const status = `ADA $${price.toFixed(4)} ${arrow}${Math.abs(change).toFixed(2)}% 24h`;

    client.user.setActivity(status, { type: ActivityType.Watching });

    console.log(`[Updated] ${status}`);
  } catch (err) {
    console.error("[Error fetching price]", err.message);
  }
}

client.once("ready", () => {
  console.log(`Bot is online as: ${client.user.tag}`);
  updatePrice();
  setInterval(updatePrice, 5 * 60 * 1000); // update every 5 minutes
});

client.login(BOT_TOKEN);
