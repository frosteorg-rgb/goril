// goril server: serves index.html and runs multiplayer rooms over WebSocket.
// Run: npm install && npm start   (then open http://localhost:3000)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = !!process.env.TRUST_PROXY;     // set when the host puts a proxy in front (Render, Railway, nginx, Cloudflare): reads the real IP from x-forwarded-for
const MAX_PER_IP = +process.env.MAX_PER_IP || 8;   // simultaneous connections per IP
const MAX_ROOMS = 300;

let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (e) { }

/* ===================== STAFF LIST (server-side only) =====================
   1. Open the game, walk to the lobby computer, press "Show" under "Your player ID".
   2. Paste that ID below (dashes are fine). It never leaves this file / the server,
      so players cannot see it by viewing the page source.
   3. Restart the server.
   You can also use env vars instead: OWNER_IDS="id1,id2"  MOD_IDS="id3,id4"
   Roles:  owner = everything (incl. ban, give cosmetics, can act on mods)   mod = kick + troll tools */
const STAFF_IDS = {
    owner: ["9715-E5B4-A56A-3145-9F71-D48B-FC0B-3AB0"],
    mod: [
        // "PASTE-A-MODERATOR-ID-HERE",
    ],
};
/* ======================================================================== */

/* ===================== DISCORD REPORTS (server-side only) =====================
   Player reports are posted to a private Discord channel through a webhook.
   1. In Discord: channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL.
   2. Set it as an environment variable (recommended):  DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."
      or paste it between the quotes below. It never reaches players' browsers.
   Keep the channel private and never put the URL in a public repo. (Needs Node 18+.) */
const WEBHOOK = process.env.DISCORD_WEBHOOK || cfg.DISCORD_WEBHOOK || "https://discord.com/api/webhooks/..";
/* ======================================================================== */

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const norm = v => String(v == null ? "" : v).toLowerCase().replace(/[^a-f0-9]/g, "");
const ROLE = new Map();           // sha256(id) -> "owner" | "mod"  (raw IDs are never kept in memory)
const addIds = (list, r) => list.forEach(i => { const n = norm(i); if (n.length === 32) ROLE.set(sha(n), r); });
addIds(STAFF_IDS.owner, "owner"); addIds(STAFF_IDS.mod, "mod");
addIds((process.env.OWNER_IDS || "").split(","), "owner"); addIds((process.env.MOD_IDS || "").split(","), "mod");
const CFG = new Set(ROLE.keys());   // staff set in this file / env vars (not editable in-game)
const STF = path.join(__dirname, "staff.json");   // moderators promoted in-game by the owner (hashed IDs)
try { JSON.parse(require("fs").readFileSync(STF, "utf8")).forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "mod"); }); } catch (e) { }
const saveStaff = () => { try { require("fs").writeFileSync(STF, JSON.stringify([...ROLE].filter(([h, r]) => r === "mod" && !CFG.has(h)).map(x => x[0]))); } catch (e) { } };
const RANK = { owner: 2, mod: 1, "": 0 };
console.log("Staff loaded: " + [...ROLE.values()].filter(r => r === "owner").length + " owner(s), " + [...ROLE.values()].filter(r => r === "mod").length + " mod(s)");

// bans are stored as hashed IDs in bans.json (delete an entry to unban)
const BANF = path.join(__dirname, "bans.json");
let bans = new Set(); try { bans = new Set(JSON.parse(fs.readFileSync(BANF, "utf8"))); } catch (e) { }
const saveBans = () => { try { fs.writeFileSync(BANF, JSON.stringify([...bans])); } catch (e) { } };

/* ---------- COSMETIC CATALOG (server copy: anything not listed here is rejected) ---------- */
const SLOTS = {
    hat: ["beanie", "party", "cowboy", "top", "prop", "halo", "crown", "wiz", "horns", "witch", "pumpkin", "mummy", "skullcap", "gpump"],
    face: ["shades", "monocle", "stache", "nose", "visor", "vamp", "stitch", "skullmask"],
    back: ["pack", "cape", "wings", "jet", "bat", "ghost", "candybag", "broom", "scythe"],
    trail: ["spark", "fire", "bubble", "rain", "star", "heart", "bats", "candy", "wisp", "ember", "witchfire"],
    hand: [],
};
// staff-only cosmetics. "st_o*" = owner only, the rest = any staff. "st_stick" is THE STICK (staff badge item).
const STAFF_SLOTS = {
    hat: ["st_ocrown", "st_oflame", "st_modhat"], face: ["st_olaser", "st_shades"],
    back: ["st_ocape", "st_odragon", "st_mcape", "st_hammer"], trail: ["st_oaura", "st_ogalaxy", "st_maura"], hand: ["st_stick"],
};
const REG_IDS = new Set(Object.values(SLOTS).flat());          // items that can be owned / given by the owner
const SLOT_OK = {}; for (const k in SLOTS) SLOT_OK[k] = new Set(SLOTS[k].concat(STAFF_SLOTS[k] || []));

// grants.json: items the OWNER gave to players, keyed by sha256(player id). Only the server writes it.
const GRF = path.join(__dirname, "grants.json");
let grants = {}; try { const g = JSON.parse(fs.readFileSync(GRF, "utf8")); if (g && typeof g === "object") grants = g; } catch (e) { }
const saveGrants = () => { try { fs.writeFileSync(GRF + ".tmp", JSON.stringify(grants)); fs.renameSync(GRF + ".tmp", GRF); } catch (e) { console.log("could not save grants.json: " + e.message); } };
const gl = uh => (uh && Array.isArray(grants[uh])) ? grants[uh].filter(i => REG_IDS.has(i)) : [];
const sendGrants = (ws, add) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ev", k: "grants", list: gl(ws.uh), add: add || "" })); };

// undercover name pool: common-looking player names. Staff in undercover mode get one of these (picked by the SERVER).
const NAMES = ["Monkey", "Banana", "Gorilla", "Chimp", "Jungle", "Primate", "Swinger", "Treehouse", "Bananaboy", "ProGuy", "Tagger", "Runner",
    "Climber", "Ninja", "Shadow", "Lightning", "Rocket", "Turbo", "Blaze", "Frost", "Ghost", "Storm", "Phantom", "Viper", "Dragon", "Wolf", "Falcon",
    "Tiger", "Panda", "Koala", "Bubbles", "Cookie", "Waffles", "Pickle", "Muffin", "Noodle", "Pancake", "Taco", "Nugget", "Biscuit", "Pumpkin",
    "Zombie", "Spooky", "Skeleton", "Candy", "Gamer", "Player", "Dude", "Kiddo", "Speedy", "Jumper", "Hopper", "Swingy", "Chaser", "Monke", "Ape"];
const pickName = R => {
    const used = new Set([...R.m.values()].map(p => dn(p).toLowerCase()));
    for (let i = 0; i < 40; i++) {
        const base = NAMES[Math.random() * NAMES.length | 0], nm = (base + (Math.random() < .45 ? String(10 + (Math.random() * 990 | 0)) : "")).slice(0, 12);
        if (!used.has(nm.toLowerCase())) return nm;
    }
    return ("Monke" + (Math.random() * 9999 | 0)).slice(0, 12);
};
const dn = p => p.ws.uc ? p.ws.ucn : p.s.n;       // the name everyone else is allowed to see

const server = http.createServer((req, res) => {
    fs.readFile(path.join(__dirname, "index.html"), (e, b) => {
        if (e) { res.writeHead(500); return res.end("index.html missing"); }
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        });
        res.end(b);
    });
});
const wss = new WebSocketServer({ server, maxPayload: 16384 });
const rooms = new Map(), ips = new Map();
let nid = 1;
const num = v => Number.isFinite(v) ? Math.round(v) : 0;
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const cleanName = (v, n) => str(v, n).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();   // no control / bidi-override tricks in names
const bc = (R, o) => { const j = JSON.stringify(o); R.m.forEach(p => p.ws.readyState === 1 && p.ws.send(j)); };
const FX = ["launch", "freeze", "invert", "lowgrav", "goto", "slow", "rocket", "home"];

/* ---------- CHAT / VOICE SIGNALING / CHECK / REPORT / STAFF MUTE ---------- */
const MUTE_MS = 60 * 60 * 1000, smute = new Map();   // uh -> time the staff mute ends (kept in memory, so rejoining does not escape it)
const note = (ws, txt) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "ev", k: "note", txt }));
const setMute = (tp, on) => {
    tp.ws.mu = on ? 1 : 0;
    if (tp.ws.uh) { if (on) smute.set(tp.ws.uh, Date.now() + MUTE_MS); else smute.delete(tp.ws.uh); }
    if (tp.ws.readyState === 1) tp.ws.send(JSON.stringify({ t: "ev", k: "muted", on: tp.ws.mu }));
};
// stable, anonymous key per player so other players' "mute" choices survive rejoining (staff get a per-session key)
const pk = p => p.ws.role ? "s" + p.ws.id : p.ws.uh ? (p.ws.pk || (p.ws.pk = sha("mute:" + p.ws.uh).slice(0, 10))) : "g" + p.ws.id;

// --- movement stats the server collects for the "Check" button and for reports ---
const newCS = () => ({ t0: Date.now(), px: null, py: null, pt: 0, smp: [], ups: [], maxv: 0, spd: 0, st: 0, tele: 0, tt: 0, hand: 0, ht: 0, vel: 0, vt: 0, flood: 0, flt: 0, bad: 0, bt: 0, fx: 0 });
const badItem = pl => { const c = pl.cs, n = Date.now(); if (n - c.bt > 5000) { c.bad++; c.bt = n; } };
const track = (pl, ws) => {
    const c = pl.cs, s = pl.s, n = Date.now(); if (ws.role) return;            // staff are exempt (they can fly / teleport)
    c.ups = c.ups.filter(t => n - t < 1000); c.ups.push(n);
    if (c.ups.length > 45 && n - c.flt > 5000) { c.flood++; c.flt = n; }       // the real client sends ~22 updates/sec
    if (s.h.some(v => Math.abs(v) > 100) && n - c.ht > 5000) { c.hand++; c.ht = n; }
    if (Math.hypot(s.vx, s.vy) > 1900 && n - c.vt > 5000) { c.vel++; c.vt = n; }   // the game clamps speed to 1500
    const quiet = n - c.fx < 4000 || ws.room.lobby;                            // staff launches/teleports and lobby respawns are legit
    if (c.px != null) {
        const gap = (n - c.pt) / 1000, dist = Math.hypot(s.x - c.px, s.y - c.py);
        if (!quiet && gap < 1.5 && dist > 1000 + 1700 * gap && n - c.tt > 2000) { c.tele++; c.tt = n; }
    }
    c.px = s.x; c.py = s.y; c.pt = n;
    c.smp.push([n, s.x, s.y]); while (c.smp.length && n - c.smp[0][0] > 1000) c.smp.shift();
    const a = c.smp[0], span = (n - a[0]) / 1000;
    if (span >= 0.5 && !quiet) {
        const v = Math.hypot(s.x - a[1], s.y - a[2]) / span;
        if (v > c.maxv) c.maxv = v;
        if (v > 2600 && n - c.st > 3000) { c.spd++; c.st = n; }                // generous margin for network bursts
    }
};
const checkOf = tp => {
    const c = tp.cs, secs = (Date.now() - c.t0) / 1000 | 0, fl = [];
    if (tp.ws.role && !tp.ws.uc) return { v: "staff", secs, maxv: 0, fl };     // undercover staff look like ordinary clean players
    if (c.spd) fl.push("Moved faster than the game allows (" + c.spd + "x)");
    if (c.tele) fl.push("Teleported across the map (" + c.tele + "x)");
    if (c.hand) fl.push("Impossible arm positions (" + c.hand + "x)");
    if (c.vel) fl.push("Sent impossible speed values (" + c.vel + "x)");
    if (c.flood) fl.push("Sending updates too fast (" + c.flood + "x)");
    if (c.bad) fl.push("Tried to wear items they don't have (" + c.bad + "x)");
    const sc = c.spd + c.tele * 2 + c.hand * 2 + c.vel + c.flood + c.bad * 2;
    return { v: sc >= 6 || c.tele >= 3 || c.hand >= 3 ? "suspicious" : sc ? "minor" : "clean", secs, maxv: Math.round(c.maxv), fl };
};
const doCheck = (ws, m) => {
    const n = Date.now(); if (n - (ws.ck || 0) < 2500) return note(ws, "Wait a moment before checking again.");
    const tp = ws.room.m.get(str(m.to, 12)); if (!tp) return; ws.ck = n;
    ws.send(JSON.stringify(Object.assign({ t: "ev", k: "check", id: tp.ws.id, n: dn(tp) }, checkOf(tp))));
};

// --- text chat: rate limited, links removed, muted players are dropped here (not just hidden on the client) ---
const chatMsg = (ws, m) => {
    const R = ws.room, pl = R.m.get(ws.id), n = Date.now(); if (!pl) return;
    if (ws.mu) return note(ws, "You are muted by staff.");
    if (n - (ws.cl || 0) < 700) return;
    ws.cb = (ws.cb || []).filter(t => n - t < 8000); if (ws.cb.length >= 6) return note(ws, "Slow down a little!");
    let t = str(m.txt, 160).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    t = t.replace(/(https?:\/\/|www\.)\S+/gi, "[link]");
    if (!t || (t === ws.lt && n - (ws.ltt || 0) < 10000)) return;
    ws.cl = n; ws.cb.push(n); ws.lt = t; ws.ltt = n;
    R.chat.push({ n: dn(pl), t, at: n }); if (R.chat.length > 25) R.chat.shift();
    bc(R, { t: "ev", k: "chat", id: ws.id, n: dn(pl), r: ws.uc ? "" : ws.role, txt: t });
};

// --- voice: audio goes player-to-player (WebRTC); the server only passes the handshake messages along ---
const relay = (ws, m) => {
    const n = Date.now(); ws.rq = (ws.rq || []).filter(t => n - t < 10000); if (ws.rq.length >= 150) return; ws.rq.push(n);
    const tp = ws.room.m.get(str(m.to, 12)), d = m.d;
    if (!tp || tp.ws === ws || !d || typeof d !== "object" || tp.ws.readyState !== 1) return;
    const o = {};
    if (d.sdp && typeof d.sdp === "object") o.sdp = { type: str(d.sdp.type, 10), sdp: str(d.sdp.sdp, 9000) };
    else if (d.ice && typeof d.ice === "object") o.ice = { candidate: str(d.ice.candidate, 500), sdpMid: str(d.ice.sdpMid, 24), sdpMLineIndex: num(d.ice.sdpMLineIndex) };
    else if (d.rdy) o.rdy = 1; else return;
    tp.ws.send(JSON.stringify({ t: "rtc", from: ws.id, d: o }));
};

// --- reports go to a private Discord channel through the webhook (the URL never leaves the server) ---
const REASONS = { cheating: "Cheating", harassment: "Harassment", chat: "Chat / voice abuse", name: "Bad name / outfit", other: "Other" };
const ref = p => p.ws.uh ? p.ws.uh.slice(0, 10) : "no-id";
const clean = (s, n) => String(s).replace(/[`\u0000-\u001f]/g, " ").replace(/@/g, "@\u200b").slice(0, n);
const doReport = (ws, m) => {
    const n = Date.now(), R = ws.room, me = R.m.get(ws.id), tp = R.m.get(str(m.to, 12));
    if (!me || !tp || tp.ws === ws) return;
    ws.rl = (ws.rl || []).filter(t => n - t < 3600000);
    if (n - (ws.rp || 0) < 20000) return note(ws, "Please wait a few seconds before sending another report.");
    if (ws.rl.length >= 8) return note(ws, "You have sent a lot of reports - please try again later.");
    if (!WEBHOOK || typeof fetch !== "function") {
        console.log("[report] NOT delivered (set DISCORD_WEBHOOK, Node 18+ needed): " + dn(me) + " reported " + dn(tp) + " for " + str(m.why, 12));
        return note(ws, "Reports are not set up on this server yet.");
    }
    ws.rp = n; ws.rl.push(n);
    const why = REASONS[m.why] ? m.why : "other", extra = clean(str(m.txt, 200), 200).trim(), ck = checkOf(tp);
    const chat = R.chat.slice(-12).map(c => "[" + ((n - c.at) / 1000 | 0) + "s ago] " + clean(c.n, 12) + ": " + clean(c.t, 120)).join("\n") || "(no recent chat)";
    const body = {
        username: "goril reports", allowed_mentions: { parse: [] },
        embeds: [{
            title: "🚩 Player report: " + REASONS[why], color: 0xe8761a, timestamp: new Date(n).toISOString(),
            fields: [
                { name: "Reported player", value: "**" + clean(dn(tp), 12) + "**" + (tp.ws.role ? " (" + tp.ws.role + (tp.ws.uc ? ", undercover" : "") + ")" : "") + "\nref `" + ref(tp) + "`", inline: true },
                { name: "Reported by", value: "**" + clean(dn(me), 12) + "**\nref `" + ref(me) + "`", inline: true },
                { name: "Room", value: "`" + ws.rname + "`", inline: true },
                { name: "Details", value: extra || "(none)" },
                { name: "Automatic check", value: ("**" + ck.v + "** - peak speed " + ck.maxv + " px/s, watched " + ck.secs + "s\n" + (ck.fl.join("\n") || "no flags")).slice(0, 1000) },
                { name: "Recent chat in that room", value: "```\n" + chat.slice(0, 900) + "\n```" }
            ]
        }]
    };
    fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(r => { if (!r.ok) console.log("[report] Discord answered " + r.status); })
        .catch(e => console.log("[report] could not reach Discord: " + e.message));
    console.log("[report] " + dn(me) + " -> " + dn(tp) + " (" + why + ")");
    note(ws, "Report sent to the staff team. Thank you!");
};


wss.on("connection", (ws, req) => {
    const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
    if ((ips.get(ip) || 0) >= MAX_PER_IP) return ws.close();
    ips.set(ip, (ips.get(ip) || 0) + 1);
    ws.mw = Date.now(); ws.mn = 0;
    ws.id = "p" + nid++; ws.room = null; ws.role = ""; ws.uh = null; ws.lc = 0; ws.uc = 0; ws.ucn = "";
    ws.on("message", raw => {
        const tn = Date.now(); if (tn - ws.mw >= 1000) { ws.mw = tn; ws.mn = 0; } if (++ws.mn > 120) return ws.close();   // flood protection (real traffic is ~25 msgs/sec)
        let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m !== "object") return;
        if (m.t === "join" && !ws.room) {
            // the role comes ONLY from the server's own list, matched against the player's permanent ID
            const uid = norm(m.uid); ws.uh = uid.length === 32 ? sha(uid) : null;
            if (ws.uh && bans.has(ws.uh)) { ws.send(JSON.stringify({ t: "ev", k: "banned" })); return ws.close(); }
            ws.role = (ws.uh && ROLE.get(ws.uh)) || "";
            ws.mu = ws.uh && (smute.get(ws.uh) || 0) > Date.now() ? 1 : 0;
            const name = str(m.room, 40).toLowerCase().replace(/[^a-z0-9-]/g, "") || "public-lobby";
            // the staff room only lets verified staff in (role comes from the server list, never the client)
            if (/-staff$/.test(name) && !ws.role) { ws.send(JSON.stringify({ t: "ev", k: "denied" })); return ws.close(); }
            let R = rooms.get(name);
            if (!R) { if (rooms.size >= MAX_ROOMS) return ws.close(); R = { m: new Map(), st: "wait", t: 3, last: null, chat: [], lobby: /-(lobby|staff|shop)$/.test(name) }; rooms.set(name, R); }
            if (R.m.size >= 16) return ws.close();
            ws.room = R; ws.rname = name;
            R.m.set(ws.id, { ws, cs: newCS(), last: Date.now(), rn: "Monke", s: { x: 0, y: 0, vx: 0, vy: 0, f: 1, h: [14, 16, -14, 16], hu: 30, n: "Monke", e: {}, it: 0, tg: 0 } });
            ws.send(JSON.stringify({ t: "hi", id: ws.id, r: ws.role }));
            sendGrants(ws);
        } else if (m.t === "s" && ws.room) {
            const pl = ws.room.m.get(ws.id); if (!pl) return; pl.last = Date.now(); const s = pl.s, d = m.d || {}, e = d.e || {};
            s.x = num(d.x); s.y = num(d.y); s.vx = num(d.vx); s.vy = num(d.vy);
            s.f = d.f === -1 ? -1 : 1;
            if (Array.isArray(d.h) && d.h.length >= 4) s.h = d.h.slice(0, 4).map(num);
            s.hu = num(d.hu); pl.rn = cleanName(d.n, 12) || "Monke";
            s.n = ws.uc ? ws.ucn : pl.rn;                 // undercover staff are always shown with the server-picked name
            // every slot is checked against the server catalog. Staff items need a staff role (checked HERE, not on the client),
            // "st_o*" items are owner-only, and staff items are never shown while undercover.
            const ok = (slot, v) => {
                v = str(v, 12); if (v === "" || v === "none") return v; if (!SLOT_OK[slot].has(v)) { badItem(pl); return ""; }
                if (!v.startsWith("st_")) return v;
                if (!ws.role || ws.uc) { if (!ws.role) badItem(pl); return ""; } return v.startsWith("st_o") && ws.role !== "owner" ? "" : v;
            };
            s.e = { hat: ok("hat", e.hat), face: ok("face", e.face), back: ok("back", e.back), trail: ok("trail", e.trail), hand: ok("hand", e.hand) };
            track(pl, ws);
        } else if (m.t === "chat" && ws.room) {
            chatMsg(ws, m);
        } else if (m.t === "rtc" && ws.room) {
            relay(ws, m);
        } else if (m.t === "check" && ws.room) {
            doCheck(ws, m);
        } else if (m.t === "report" && ws.room) {
            doReport(ws, m);
        } else if (m.t === "cmd" && ws.room && ws.role) {
            // staff tools: re-checked here on every command, the client is never trusted
            const now = Date.now(); if (now - ws.lc < 150) return; ws.lc = now;
            const R = ws.room, me = R.m.get(ws.id); if (!me) return;
            const k = str(m.k, 12), O = ws.role === "owner";
            if (k === "undercover") {   // any staff: look like a normal player (no role tag, no staff items, random common name)
                const on = m.on === 1 || m.on === true;
                if (on && !ws.uc) { ws.uc = 1; ws.ucn = pickName(R); me.s.n = ws.ucn; } else if (!on) { ws.uc = 0; me.s.n = me.rn; }
                ws.send(JSON.stringify({ t: "ev", k: "uc", on: ws.uc, name: ws.uc ? ws.ucn : "" }));
                console.log("[staff] " + ws.role + " " + me.rn + " -> undercover " + (ws.uc ? "ON as " + ws.ucn : "OFF")); return;
            }
            if (k === "announce") { const txt = cleanName(m.txt, 80); if (txt) bc(R, { t: "ev", k: "announce", txt }); return; }
            if (O && !R.lobby && k === "newround") { R.st = "wait"; R.t = 1; R.m.forEach(p => p.s.it = 0); console.log("[staff] owner " + me.rn + " -> new round"); return; }
            if (O && !R.lobby && k === "endround") { if (R.st === "play") { R.st = "end"; R.t = 5; bc(R, { t: "ev", k: "end", last: R.last }); } console.log("[staff] owner " + me.rn + " -> end round"); return; }
            if (k === "give" || k === "revoke") {   // OWNER ONLY. Saved on the server by the target's hashed ID; clients can never add to it.
                if (!O) return;
                const item = str(m.item, 12); if (!REG_IDS.has(item)) return;
                const tp = m.to === "self" ? me : R.m.get(str(m.to, 12)); if (!tp) return;
                if (!tp.ws.uh) { ws.send(JSON.stringify({ t: "ev", k: "note", txt: dn(tp) + " has no player ID - cannot save items for them" })); return; }
                const L = new Set(gl(tp.ws.uh));
                if (k === "give") { if (L.size >= 300) return; L.add(item); } else if (!L.delete(item)) return;
                if (L.size) grants[tp.ws.uh] = [...L]; else delete grants[tp.ws.uh];
                saveGrants(); sendGrants(tp.ws, k === "give" ? item : "");
                ws.send(JSON.stringify({ t: "ev", k: "note", txt: (k === "give" ? "Gave " : "Took back ") + item + (k === "give" ? " to " : " from ") + (tp === me ? "yourself" : dn(tp)) }));
                console.log("[staff] owner " + me.rn + " -> " + k + " " + item + " -> " + tp.rn); return;
            }
            const apply = tp => {
                if (k === "kick") { tp.ws.send(JSON.stringify({ t: "ev", k: "kicked" })); tp.ws.close(); }
                else if (k === "infect") { if (!R.lobby) tp.s.it = 1; }
                else if (k === "cure") { tp.s.it = 0; }
                else if (k === "mute" || k === "unmute") setMute(tp, k === "mute");
                else if (FX.includes(k)) { tp.cs.fx = Date.now(); tp.ws.send(JSON.stringify({ t: "fx", k, x: me.s.x, y: me.s.y })); }
            };
            if (m.to === "all") {   // owner-only bulk actions, never touches owners
                if (!O || !(k === "kick" || k === "infect" || k === "cure" || k === "mute" || k === "unmute" || FX.includes(k))) return;
                console.log("[staff] owner " + me.rn + " -> " + k + " -> ALL");
                [...R.m.values()].forEach(tp => { if (tp.ws !== ws && RANK[tp.ws.role || ""] < RANK[ws.role]) apply(tp); });
                return;
            }
            const tp = R.m.get(str(m.to, 12)); if (!tp) return;
            if (tp.ws !== ws && RANK[ws.role] <= RANK[tp.ws.role || ""]) return;   // can only act on lower ranks
            console.log("[staff] " + ws.role + " " + me.rn + " -> " + k + " -> " + tp.rn);
            if (k === "ban") {
                if (!O || !tp.ws.uh || tp.ws === ws) return;
                bans.add(tp.ws.uh); saveBans(); tp.ws.send(JSON.stringify({ t: "ev", k: "banned" })); tp.ws.close();
            }
            else if (k === "mod" || k === "unmod") {   // owner promotes / demotes moderators live; saved in staff.json
                if (!O || !tp.ws.uh || tp.ws === ws || tp.ws.role === "owner") return;
                if (k === "unmod" && tp.ws.role !== "mod") return;
                if (k === "mod") { ROLE.set(tp.ws.uh, "mod"); tp.ws.role = "mod"; }
                else { ROLE.delete(tp.ws.uh); tp.ws.role = ""; if (tp.ws.uc) { tp.ws.uc = 0; tp.s.n = tp.rn; tp.ws.send(JSON.stringify({ t: "ev", k: "uc", on: 0, name: "" })); } }
                saveStaff();
            }
            else apply(tp);
        }
    });
    ws.on("close", () => {
        const c = (ips.get(ip) || 1) - 1; if (c > 0) ips.set(ip, c); else ips.delete(ip);
        if (!ws.room) return;
        ws.room.m.delete(ws.id);
        if (!ws.room.m.size) rooms.delete(ws.rname);
    });
    ws.on("error", () => { });
});

// what other players are allowed to see about a player (undercover staff look like ordinary players)
const view = p => {
    const s = p.s, uc = p.ws.uc, e = {};
    for (const k in s.e) e[k] = uc && String(s.e[k]).startsWith("st_") ? "" : s.e[k];
    return Object.assign({}, s, { id: p.ws.id, r: uc ? "" : (p.ws.role || ""), n: dn(p), e, k: pk(p), mu: p.ws.mu ? 1 : 0 });
};

// 20 ticks/sec: run the infection round for each room and send snapshots
setInterval(() => {
    const dt = 0.05;
    for (const R of rooms.values()) {
        const P = [...R.m.values()], S = P.map(p => p.s);
        // players whose tab went inactive stop sending updates: kick after 20s
        P.forEach(p => { if (Date.now() - p.last > 20000) p.ws.close(); });
        if (!R.lobby) {
            if (P.length < 2) { R.st = "wait"; R.t = 3; S.forEach(s => s.it = 0); }
            else if (R.st === "wait") {
                R.t -= dt;
                if (R.t <= 0) {
                    S.forEach(s => { s.it = 0; s.tg = 0; });
                    const k = P[Math.random() * P.length | 0];
                    k.s.it = 1; R.st = "play"; R.t = 0; R.last = null;
                    bc(R, { t: "ev", k: "start", pick: k.ws.id });
                }
            } else if (R.st === "play") {
                R.t += dt;
                for (const a of P) if (a.s.it) for (const b of P)
                    if (!b.s.it && Math.hypot(a.s.x - b.s.x, a.s.y - b.s.y) < 38) {
                        b.s.it = 1; a.s.tg++;
                        bc(R, { t: "ev", k: "infect", id: b.ws.id, by: a.ws.id, n: dn(b) });
                    }
                // anyone who stops sending updates (hidden tab) for 3s gets infected so they cannot hide
                for (const p of P) if (!p.s.it && Date.now() - p.last > 3000) { p.s.it = 1; bc(R, { t: "ev", k: "infect", id: p.ws.id, by: null, n: dn(p) }); }
                const al = P.filter(p => !p.s.it);
                if (al.length === 1) R.last = al[0].ws.id;
                if (!al.length) { R.st = "end"; R.t = 5; bc(R, { t: "ev", k: "end", last: R.last }); }
            } else { R.t -= dt; if (R.t <= 0) { R.st = "wait"; R.t = 3; } }
        }
        const pub = P.map(view), head = { t: "p", st: R.st, rt: R.t }, out = JSON.stringify(Object.assign({}, head, { ps: pub }));
        P.forEach((p, i) => {
            if (p.ws.readyState !== 1) return;
            if (p.ws.uc && p.ws.role) {   // an undercover staff member still sees their own real role (so their tools keep working)
                const mine = pub.slice(); mine[i] = Object.assign({}, pub[i], { r: p.ws.role });
                p.ws.send(JSON.stringify(Object.assign({}, head, { ps: mine })));
            } else p.ws.send(out);
        });
    }
}, 50);

server.listen(PORT, () => console.log("goril running on http://localhost:" + PORT));