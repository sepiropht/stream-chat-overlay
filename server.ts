const configPath = `${import.meta.dir}/config.json`;

interface Config {
  twitch: { channel: string };
  youtube: { apiKey: string; videoId: string };
}

let config: Config = {
  twitch: { channel: "" },
  youtube: { apiKey: "", videoId: "" },
};

const configFile = Bun.file(configPath);
if (await configFile.exists()) {
  config = await configFile.json();
}

async function saveConfig() {
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

const clients = new Set<any>();

function broadcast(data: object) {
  const json = JSON.stringify(data);
  for (const ws of clients) { try { ws.send(json); } catch {} }
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
    const interval: number = data.pollingIntervalMillis ?? 10_000;

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

// ── Start ─────────────────────────────────────────────────────────────────────

if (config.twitch.channel) connectTwitch(config.twitch.channel);
if (config.youtube.apiKey && config.youtube.videoId) {
  startYoutube(config.youtube.apiKey, config.youtube.videoId);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: 7432,
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "config", data: config }));
      ws.send(JSON.stringify({ type: "status", twitch: twitchConnected, youtube: youtubeConnected }));
    },
    close(ws) { clients.delete(ws); },
    async message(ws, msg) {
      try {
        const data = JSON.parse(msg as string);

        if (data.type === "save_config") {
          const next = data.config as Config;

          if (next.twitch.channel !== config.twitch.channel) {
            config.twitch.channel = next.twitch.channel;
            connectTwitch(config.twitch.channel);
          }

          const ytChanged =
            next.youtube.apiKey !== config.youtube.apiKey ||
            next.youtube.videoId !== config.youtube.videoId;

          config.youtube = next.youtube;
          if (ytChanged) startYoutube(config.youtube.apiKey, config.youtube.videoId);

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
