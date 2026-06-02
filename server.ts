const configPath = `${import.meta.dir}/config.json`;

interface Config {
  twitch: { channel: string; clientId: string; clientSecret: string };
  youtube: { apiKey: string; videoId: string };
}

let config: Config = {
  twitch: { channel: "", clientId: "", clientSecret: "" },
  youtube: { apiKey: "", videoId: "" },
};

const configFile = Bun.file(configPath);
if (await configFile.exists()) {
  config = await configFile.json();
}

async function saveConfig() {
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

// ── Broadcast + message buffer (persisté sur disque) ─────────────────────────

const clients = new Set<any>();
const BUFFER_SIZE = 80;
const bufferPath = `${import.meta.dir}/.msg-buffer.json`;

// Charger l'historique existant
let msgBuffer: object[] = [];
try {
  const f = Bun.file(bufferPath);
  if (await f.exists()) msgBuffer = await f.json();
} catch {}

async function saveBuffer() {
  await Bun.write(bufferPath, JSON.stringify(msgBuffer));
}

function broadcast(data: object) {
  const json = JSON.stringify(data);
  for (const ws of clients) { try { ws.send(json); } catch {} }
  if ((data as any).type === "msg") {
    msgBuffer.push(data);
    if (msgBuffer.length > BUFFER_SIZE) msgBuffer.shift();
    saveBuffer();   // fire-and-forget
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

let twitchConnected = false;
let youtubeConnected = false;

function broadcastStatus() {
  broadcast({ type: "status", twitch: twitchConnected, youtube: youtubeConnected });
}

// ── Twitch IRC (anonymous) ────────────────────────────────────────────────────

let twitchWs: WebSocket | null = null;
let currentChannel = "";

function connectTwitch(channel: string) {
  if (!channel) return;
  if (twitchWs) { twitchWs.close(); twitchWs = null; }

  currentChannel = channel.toLowerCase();
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  twitchWs = ws;

  ws.addEventListener("open", () => {
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOZE");
    ws.send("NICK justinfan99999");
    ws.send(`JOIN #${currentChannel}`);
    twitchConnected = true;
    broadcastStatus();
    console.log(`[Twitch] joined #${currentChannel}`);
  });

  ws.addEventListener("message", (event) => {
    const raw = (event.data as string).trim();
    if (raw.startsWith("PING")) { ws.send("PONG :tmi.twitch.tv"); return; }

    for (const line of raw.split("\r\n")) {
      if (!line.includes("PRIVMSG")) continue;
      const tags: Record<string, string> = {};
      let rest = line;
      if (line.startsWith("@")) {
        const space = line.indexOf(" ");
        const tagStr = line.slice(1, space);
        rest = line.slice(space + 1);
        for (const part of tagStr.split(";")) {
          const eq = part.indexOf("=");
          if (eq > 0) tags[part.slice(0, eq)] = part.slice(eq + 1);
        }
      }
      const m = rest.match(/PRIVMSG #\S+ :(.+)$/);
      if (!m) continue;
      const color = tags["color"] || "";
      broadcast({
        type: "msg", platform: "twitch",
        id: tags["id"] || Math.random().toString(36).slice(2),
        username: tags["display-name"] || "unknown",
        message: m[1],
        color: color === "" ? "#9147FF" : color,
        emotes: tags["emotes"] || "",
        ts: Date.now(),
      });
    }
  });

  ws.addEventListener("close", () => {
    if (twitchWs !== ws) return;
    twitchConnected = false;
    broadcastStatus();
    console.log("[Twitch] disconnected – reconnect in 5s");
    setTimeout(() => connectTwitch(currentChannel), 5000);
  });

  ws.addEventListener("error", () => { twitchConnected = false; broadcastStatus(); });
}

// ── YouTube Data API v3 ───────────────────────────────────────────────────────

let ytLiveChatId = "";
let ytNextPageToken = "";
let ytPollTimer: Timer | null = null;

async function stopYoutube() {
  if (ytPollTimer) { clearTimeout(ytPollTimer); ytPollTimer = null; }
  ytLiveChatId = "";
  ytNextPageToken = "";
  youtubeConnected = false;
}

async function startYoutube(apiKey: string, videoId: string) {
  await stopYoutube();
  if (!apiKey || !videoId) return;

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json();

    if (data.error) {
      console.error(`[YouTube] API error: ${data.error.message}`);
      broadcast({ type: "yt_error", message: data.error.message });
      return;
    }

    ytLiveChatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? "";
    if (!ytLiveChatId) {
      console.log("[YouTube] no active live chat for this video");
      broadcast({ type: "yt_error", message: "Aucun live chat actif pour cette vidéo" });
      return;
    }

    youtubeConnected = true;
    broadcastStatus();
    console.log(`[YouTube] connected – chatId ${ytLiveChatId}`);
    pollYoutube(apiKey);
  } catch (err) {
    console.error("[YouTube] init error:", err);
  }
}

async function pollYoutube(apiKey: string) {
  if (!ytLiveChatId) return;

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", ytLiveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    url.searchParams.set("maxResults", "200");
    url.searchParams.set("key", apiKey);
    if (ytNextPageToken) url.searchParams.set("pageToken", ytNextPageToken);

    const res = await fetch(url.toString());
    const data = await res.json();

    if (data.error) {
      console.error(`[YouTube] poll error: ${data.error.message}`);
      ytPollTimer = setTimeout(() => pollYoutube(apiKey), 30_000);
      return;
    }

    ytNextPageToken = data.nextPageToken ?? "";
    // Minimum 20s pour préserver le quota (10 000 unités/jour = ~555 appels/heure max)
    const interval: number = Math.max(data.pollingIntervalMillis ?? 20_000, 20_000);

    for (const item of (data.items ?? [])) {
      if (item.snippet.type !== "textMessageEvent") continue;
      broadcast({
        type: "msg", platform: "youtube",
        id: item.id,
        username: item.authorDetails.displayName,
        message: item.snippet.textMessageDetails.messageText,
        color: "#FF4444",
        ts: new Date(item.snippet.publishedAt).getTime(),
      });
    }

    ytPollTimer = setTimeout(() => pollYoutube(apiKey), interval);
  } catch (err) {
    console.error("[YouTube] poll error:", err);
    ytPollTimer = setTimeout(() => pollYoutube(apiKey), 15_000);
  }
}

// ── Viewer counts ─────────────────────────────────────────────────────────────

let viewersTwitch = 0;
let viewersYoutube = 0;

function broadcastViewers() {
  broadcast({ type: "viewers", twitch: viewersTwitch, youtube: viewersYoutube });
}

// Twitch: client credentials token + stream viewers
let twitchToken = "";
let twitchTokenExpiry = 0;

async function getTwitchToken(clientId: string, clientSecret: string): Promise<string> {
  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: "POST" }
  );
  const data = await res.json();
  twitchToken = data.access_token ?? "";
  twitchTokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
  return twitchToken;
}

async function pollTwitchViewers() {
  const { clientId, clientSecret, channel } = config.twitch;
  if (!clientId || !clientSecret || !channel) return;
  try {
    const token = await getTwitchToken(clientId, clientSecret);
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`,
      { headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` } }
    );
    const data = await res.json();
    viewersTwitch = data.data?.[0]?.viewer_count ?? 0;
    broadcastViewers();
  } catch {}
  setTimeout(pollTwitchViewers, 60_000);
}

// YouTube: concurrentViewers from liveStreamingDetails (reuses existing API key + videoId)
async function pollYoutubeViewers() {
  const { apiKey, videoId } = config.youtube;
  if (!apiKey || !videoId) return;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json();
    viewersYoutube = parseInt(data.items?.[0]?.liveStreamingDetails?.concurrentViewers ?? "0", 10);
    broadcastViewers();
  } catch {}
  setTimeout(pollYoutubeViewers, 60_000);
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (config.twitch.channel) connectTwitch(config.twitch.channel);
if (config.youtube.apiKey && config.youtube.videoId) {
  startYoutube(config.youtube.apiKey, config.youtube.videoId);
}
pollTwitchViewers();
pollYoutubeViewers();

// ── Server ────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: 7432,
  websocket: {
    open(ws) {
      clients.add(ws);
      // Rejouer les derniers messages avant tout
      for (const m of msgBuffer) { try { ws.send(JSON.stringify(m)); } catch {} }
      ws.send(JSON.stringify({ type: "config", data: config }));
      ws.send(JSON.stringify({ type: "status", twitch: twitchConnected, youtube: youtubeConnected }));
      ws.send(JSON.stringify({ type: "viewers", twitch: viewersTwitch, youtube: viewersYoutube }));
    },
    close(ws) { clients.delete(ws); },
    async message(ws, msg) {
      try {
        const data = JSON.parse(msg as string);

        if (data.type === "save_config") {
          const next = data.config as Config;

          const channelChanged = next.twitch.channel !== config.twitch.channel;
          const twCredsChanged =
            next.twitch.clientId !== config.twitch.clientId ||
            next.twitch.clientSecret !== config.twitch.clientSecret;

          config.twitch = next.twitch;   // mise à jour complète

          if (channelChanged) connectTwitch(config.twitch.channel);
          if (twCredsChanged) { twitchToken = ""; pollTwitchViewers(); }

          const ytChanged =
            next.youtube.apiKey !== config.youtube.apiKey ||
            next.youtube.videoId !== config.youtube.videoId;

          config.youtube = next.youtube;
          if (ytChanged) {
            startYoutube(config.youtube.apiKey, config.youtube.videoId);
            pollYoutubeViewers();
          }

          await saveConfig();
          ws.send(JSON.stringify({ type: "saved" }));
          broadcast({ type: "config", data: config });
        }

        if (data.type === "update_video") {
          config.youtube.videoId = data.videoId;
          await saveConfig();
          broadcast({ type: "config", data: config });
          startYoutube(config.youtube.apiKey, config.youtube.videoId);
        }
      } catch {}
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket required", { status: 426 });
    }
    return new Response(Bun.file(`${import.meta.dir}/index.html`), {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log(`Stream Chat overlay → http://localhost:${server.port}`);
