// goril server: serves index.html and runs multiplayer rooms over WebSocket.
// Run: npm install && npm start   (then open http://localhost:3000)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = !!process.env.TRUST_PROXY;     // set when the host puts a proxy in front (Render, Railway, nginx, Cloudflare): reads the real IP from x-forwarded-for
const MAX_PER_IP = +process.env.MAX_PER_IP || 8;   // simultaneous connections per IP
const MAX_ROOMS = 300;

let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (e) { }

/* ===================== DATA FOLDER =====================
   Everything that must survive updates (profiles, grants, bans, staff, stats) lives in ONE folder.
   Default: ./data next to server.js.  Override with DATA_DIR=/some/persistent/path
   IMPORTANT when hosting (Render/Railway/etc): point DATA_DIR at a persistent disk/volume, otherwise redeploys wipe it. */
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) { console.log("could not create data folder: " + e.message); }
const dp = f => path.join(DATA, f);
["grants.json", "bans.json", "staff.json"].forEach(f => { try { if (!fs.existsSync(dp(f)) && fs.existsSync(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), dp(f)); } catch (e) { } });   // one-time move of the old files
const readJSON = (f, d) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return v == null ? d : v; } catch (e) { return d; } };
const writeJSON = (f, o) => { try { fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); } catch (e) { console.log("could not write " + path.basename(f) + ": " + e.message); } };
/* ======================================================== */

const ADMIN_KEY = process.env.ADMIN_KEY || cfg.ADMIN_KEY;
/* ================================================================ */

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
const STF = dp("staff.json");   // staff promoted in-game / from the dashboard (hashed IDs). Old format (array of mods) still loads.
{
    const sj = readJSON(STF, []);
    const mods = Array.isArray(sj) ? sj : (sj.mod || []), owners = Array.isArray(sj) ? [] : (sj.owner || []);
    mods.forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "mod"); }); owners.forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "owner"); });
}
const saveStaff = () => writeJSON(STF, { owner: [...ROLE].filter(([h, r]) => r === "owner" && !CFG.has(h)).map(x => x[0]), mod: [...ROLE].filter(([h, r]) => r === "mod" && !CFG.has(h)).map(x => x[0]) });
const RANK = { owner: 2, mod: 1, "": 0 };
console.log("Staff loaded: " + [...ROLE.values()].filter(r => r === "owner").length + " owner(s), " + [...ROLE.values()].filter(r => r === "mod").length + " mod(s)");

// bans are stored as hashed IDs in bans.json (delete an entry to unban)
const BANF = dp("bans.json");
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
const GRF = dp("grants.json");
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
    const u = String(req.url || "/").split("?")[0];
    if (u.startsWith("/admin/api/")) return adminApi(req, res, u.slice(11));
    if (u === "/admin" || u === "/admin/") {
        return fs.readFile(path.join(__dirname, "admin.html"), (e, b) => {
            if (e) { res.writeHead(404); return res.end("admin.html missing"); }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
            res.end(b);
        });
    }
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

/* ---------- PLAYER PROFILES (the "saving thing") ----------
   One record per player, keyed by sha256(player ID): name, fur color, coins, candy, owned + equipped cosmetics, first/last seen, logins, playtime.
   The game client loads it when it connects, so a new .exe build no longer wipes anything as long as the player ID stays the same
   (and if the ID does change, "Restore old account" in the menu or "Link" in the dashboard moves the old profile to the new ID). */
const PRICE = { "beanie": { "p": 20, "lk": 0 }, "party": { "p": 30, "lk": 0 }, "cowboy": { "p": 50, "lk": 0 }, "top": { "p": 70, "lk": 0 }, "prop": { "p": 90, "lk": 0 }, "halo": { "p": 120, "lk": 0 }, "crown": { "p": 200, "lk": 0 }, "wiz": { "p": 150, "lk": 0 }, "horns": { "p": 110, "lk": 0 }, "witch": { "p": 90, "lk": 0 }, "pumpkin": { "p": 110, "lk": 0 }, "mummy": { "p": 80, "lk": 0 }, "skullcap": { "p": 70, "lk": 0 }, "gpump": { "p": 0, "lk": 60 }, "shades": { "p": 25, "lk": 0 }, "monocle": { "p": 40, "lk": 0 }, "stache": { "p": 45, "lk": 0 }, "nose": { "p": 60, "lk": 0 }, "visor": { "p": 80, "lk": 0 }, "vamp": { "p": 50, "lk": 0 }, "stitch": { "p": 40, "lk": 0 }, "skullmask": { "p": 90, "lk": 0 }, "pack": { "p": 30, "lk": 0 }, "cape": { "p": 80, "lk": 0 }, "wings": { "p": 150, "lk": 0 }, "jet": { "p": 220, "lk": 0 }, "bat": { "p": 130, "lk": 0 }, "ghost": { "p": 160, "lk": 0 }, "candybag": { "p": 60, "lk": 0 }, "broom": { "p": 100, "lk": 0 }, "scythe": { "p": 0, "lk": 100 }, "spark": { "p": 60, "lk": 0 }, "fire": { "p": 100, "lk": 0 }, "bubble": { "p": 100, "lk": 0 }, "rain": { "p": 180, "lk": 0 }, "star": { "p": 140, "lk": 0 }, "heart": { "p": 140, "lk": 0 }, "bats": { "p": 120, "lk": 0 }, "candy": { "p": 100, "lk": 0 }, "wisp": { "p": 110, "lk": 0 }, "ember": { "p": 90, "lk": 0 }, "witchfire": { "p": 0, "lk": 30 } };
const PRF = dp("profiles.json"), EVF = dp("events.json"), STATF = dp("stats.json");
const profiles = readJSON(PRF, {}), events = readJSON(EVF, []), stats = readJSON(STATF, { hist: [] });
if (!Array.isArray(events)) events.length = 0; if (!Array.isArray(stats.hist)) stats.hist = [];
let dirty = 0, lastBak = 0;
const mark = () => { dirty = 1; };
const logEv = (ty, uh, name, x) => { events.push({ t: Date.now(), ty, ref: uh ? uh.slice(0, 10) : "", full: uh || "", n: str(name, 12), x: x || "" }); while (events.length > 400) events.shift(); mark(); };
const flush = () => {
    if (!dirty) return; dirty = 0;
    writeJSON(PRF, profiles); writeJSON(EVF, events); writeJSON(STATF, stats);
    const now = Date.now(); if (now - lastBak > 3600000) {            // hourly rolling backups (kept 48h)
        lastBak = now; try {
            const bd = path.join(DATA, "backups"); fs.mkdirSync(bd, { recursive: true });
            fs.copyFileSync(PRF, path.join(bd, "profiles-" + new Date(now).toISOString().slice(0, 13).replace(/[^0-9]/g, "") + ".json"));
            fs.readdirSync(bd).sort().slice(0, -48).forEach(f => fs.unlinkSync(path.join(bd, f)));
        } catch (e) { }
    }
};
setInterval(flush, 5000);
const bye = () => { dirty = 1; flush(); process.exit(0); }; process.on("SIGINT", bye); process.on("SIGTERM", bye);

const SESSION_GAP = 20 * 60 * 1000;   // a reconnect within 20 min (map change) is the same login
const newProfile = n => ({ n: "Monke", hue: 25, coins: 60, candy: 0, own: {}, eq: { hat: "none", face: "none", back: "none", trail: "none", hand: "none" }, mu: {}, vv: 80, first: n, last: n, ls: n, logins: 1, secs: 0, flags: 0, stub: 1 });
const cleanEq = e => { const r = { hat: "none", face: "none", back: "none", trail: "none", hand: "none" }; if (e && typeof e === "object") for (const k in r) { const v = str(e[k], 12); if (v && SLOT_OK[k].has(v)) r[k] = v; } return r; };
const cleanOwn = o => { const r = {}; if (o && typeof o === "object") for (const k of Object.keys(o).slice(0, 200)) if (PRICE[k] && o[k]) r[k] = 1; return r; };
const cleanMu = o => { const r = {}; if (o && typeof o === "object") for (const k of Object.keys(o).slice(0, 150)) if (/^[a-z0-9]{2,16}$/i.test(k) && o[k]) r[k] = 1; return r; };
const pubProfile = p => ({ n: p.n, hue: p.hue, coins: p.coins, candy: p.candy, own: p.own, eq: p.eq, mu: p.mu, vv: p.vv });
const socksOf = uh => [...wss.clients].filter(w => w.uh === uh && w.readyState === 1);
const pushProfile = uh => { const p = profiles[uh]; if (p) socksOf(uh).forEach(w => w.send(JSON.stringify({ t: "ev", k: "profile", p: p.stub ? null : pubProfile(p), force: 1 }))); };
const pushFix = uh => { const p = profiles[uh]; if (p) socksOf(uh).forEach(w => w.send(JSON.stringify({ t: "ev", k: "pfix", coins: p.coins, candy: p.candy }))); };

// called when a player connects: count the login, then send their saved profile (or null = "send me yours")
const onJoin = ws => {
    if (!ws.uh) return; const n = Date.now(); ws.jt = n; let p = profiles[ws.uh];
    if (!p) { p = profiles[ws.uh] = newProfile(n); logEv("new", ws.uh, "", ""); }
    else if (n - p.last > SESSION_GAP) { p.logins++; logEv("login", ws.uh, p.n, ""); }
    p.last = n; mark();
    ws.send(JSON.stringify({ t: "ev", k: "profile", p: p.stub ? null : pubProfile(p) }));
};
// the player's client sends its state every few seconds; the server checks it against the rules before storing it
const doSave = (ws, m) => {
    const uh = ws.uh, pr = profiles[uh], n = Date.now(); if (!uh || !pr || !m.p || typeof m.p !== "object") return;
    if (n - (ws.sv || 0) < 1000) return; ws.sv = n; const d = m.p, creating = pr.stub;
    let coins = Math.max(0, Math.min(1e9, num(d.coins))), candy = Math.max(0, Math.min(1e6, num(d.candy))), fix = 0;
    const own = cleanOwn(d.own), granted = new Set(gl(uh)), newPaid = [];
    for (const k in own) if (!pr.own[k] && !granted.has(k) && PRICE[k]) newPaid.push(k);
    if (creating) { coins = Math.min(coins, 100000); candy = Math.min(candy, 5000); }   // first save = importing the progress the player already has
    else if (ws.role !== "owner") {                         // owners can use their +1000 coins button; everyone else can only gain at a believable rate
        const dt = Math.min(3600, (n - (pr.ls || n)) / 1000), A = 400 + dt * 12;
        if (candy > pr.candy + 20 + dt * 3) { candy = Math.floor(pr.candy + 20 + dt * 3); fix = 1; }
        let cost = 0; for (const k of newPaid) { const it = PRICE[k]; if (it.lk) { if (candy < it.lk) delete own[k]; } else cost += it.p; }
        let max = pr.coins + A - cost; if (max < 0) { newPaid.forEach(k => { if (!PRICE[k].lk) delete own[k]; }); max = pr.coins + A; }
        if (coins > max) { coins = Math.max(0, Math.floor(max)); fix = 1; }
    }
    if (fix) { pr.flags++; logEv("clamp", uh, pr.n, "coins/candy corrected"); }
    for (const k in own) if (!pr.own[k]) { pr.own[k] = 1; if (!creating) logEv("buy", uh, pr.n, k); }
    pr.coins = coins; pr.candy = candy; pr.n = cleanName(d.n, 12) || pr.n || "Monke";
    pr.hue = Math.max(0, Math.min(360, num(d.hue))); pr.eq = cleanEq(d.eq); pr.mu = cleanMu(d.mu); pr.vv = Math.max(0, Math.min(100, num(d.vv)));
    pr.ls = n; pr.last = n; if (creating) { pr.stub = 0; logEv("created", uh, pr.n, "imported " + coins + " coins"); } mark();
    if (fix) ws.send(JSON.stringify({ t: "ev", k: "pfix", coins, candy }));
};

// move everything from one ID to another (player "Restore old account", or the dashboard "Link" button)
const moveProfile = (from, to, withRole) => {
    const op = profiles[from]; if (!op) return false; const tp = profiles[to], n = Date.now();
    profiles[to] = Object.assign({}, op, { first: Math.min(op.first || n, tp ? tp.first : n), logins: (op.logins || 0) + (tp ? tp.logins : 0), secs: (op.secs || 0) + (tp ? tp.secs : 0), last: n, ls: n, stub: 0 });
    delete profiles[from];
    const g = new Set(gl(to).concat(gl(from))); if (g.size) grants[to] = [...g]; delete grants[from]; saveGrants();
    if (bans.has(from)) { bans.add(to); saveBans(); }
    if (withRole) {
        const r = ROLE.get(from); if (r && (RANK[r] > RANK[ROLE.get(to) || ""])) { ROLE.set(to, r); if (!CFG.has(from)) ROLE.delete(from); saveStaff(); socksOf(to).forEach(w => w.role = r); }
    }
    logEv("link", to, op.n, "from " + from.slice(0, 10)); mark(); pushProfile(to); socksOf(to).forEach(w => sendGrants(w)); return true;
};
const tries = new Map();
const doRestore = (ws, m, ip) => {
    const n = Date.now(); if (!ws.uh || n - (ws.rs || 0) < 3000) return; ws.rs = n;
    const L = (tries.get(ip) || []).filter(t => n - t < 3600000); if (L.length >= 10) return note(ws, "Too many tries - wait an hour."); L.push(n); tries.set(ip, L);
    const old = norm(m.old); if (old.length !== 32) return note(ws, "That does not look like a player ID.");
    const oh = sha(old); if (oh === ws.uh) return note(ws, "That is already your current ID.");
    if (bans.has(oh)) return note(ws, "That account is banned.");
    if (!profiles[oh] || profiles[oh].stub) return note(ws, "No saved account found for that ID.");
    moveProfile(oh, ws.uh, false); note(ws, "Account restored! Your coins and cosmetics were moved over.");
};

// who is online right now (unique players + anonymous connections), used by the dashboard and the history graph
const onlineInfo = () => {
    const by = new Map(), rms = {}; let total = 0;
    for (const w of wss.clients) { if (w.readyState !== 1 || !w.room) continue; total++; rms[w.rname] = (rms[w.rname] || 0) + 1; if (w.uh) by.set(w.uh, { room: w.rname, n: dn(w.room.m.get(w.id) || { ws: w, s: { n: "?" } }) }); }
    return { total, by, rms };
};
setInterval(() => { const o = onlineInfo(); stats.hist.push([Date.now(), o.total]); while (stats.hist.length > 1440) stats.hist.shift(); mark(); }, 60000);

console.log("Data folder: " + DATA + "  (" + Object.keys(profiles).length + " saved profiles)");
console.log("Admin dashboard: http://localhost:" + PORT + "/admin   key: " + ADMIN_KEY);

/* ---------- ADMIN DASHBOARD API ---------- */
const adminFails = new Map();
const ipOf = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
const adminOK = req => {
    const ip = ipOf(req), n = Date.now(), F = (adminFails.get(ip) || []).filter(t => n - t < 600000);
    if (F.length >= 10) return 429;
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(ADMIN_KEY)))) return 200;
    F.push(n); adminFails.set(ip, F); return 401;
};
const adminView = (uh, on) => {
    const p = profiles[uh], o = on.by.get(uh);
    return { ref: uh, id: uh.slice(0, 10), n: p.n, coins: p.coins, candy: p.candy, own: Object.keys(p.own), granted: gl(uh), eq: p.eq, first: p.first, last: p.last, logins: p.logins, secs: Math.round(p.secs || 0), flags: p.flags || 0, stub: p.stub ? 1 : 0, role: ROLE.get(uh) || "", cfg: CFG.has(uh) ? 1 : 0, banned: bans.has(uh) ? 1 : 0, online: o ? 1 : 0, room: o ? o.room : "" };
};
const findRef = r => { r = String(r || "").toLowerCase(); return /^[a-f0-9]{64}$/.test(r) && profiles[r] ? r : null; };
const adminApi = (req, res, route) => {
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(o)); };
    const st = adminOK(req); if (st !== 200) return send(st, { error: st === 429 ? "Too many wrong keys, wait 10 minutes." : "Wrong key" });
    let body = ""; req.on("data", c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
        let m = {}; if (body) try { m = JSON.parse(body); } catch (e) { return send(400, { error: "bad json" }); }
        const on = onlineInfo(), n = Date.now();
        try {
            if (route === "overview") {
                const list = Object.keys(profiles).filter(h => !profiles[h].stub), day = n - 86400000;
                const h24 = stats.hist.filter(x => x[0] > day), peak = h24.reduce((a, x) => Math.max(a, x[1]), on.total);
                return send(200, { online: on.total, unique: on.by.size, rooms: on.rms, peak24: peak, total: list.length, new24: list.filter(h => profiles[h].first > day).length, new7: list.filter(h => profiles[h].first > n - 7 * 86400000).length, active24: list.filter(h => profiles[h].last > day).length, hist: stats.hist, events: events.slice(-80).reverse(), coinsTotal: list.reduce((a, h) => a + profiles[h].coins, 0), banned: bans.size, now: n });
            }
            if (route === "players") {
                const q = str(m.q, 40).toLowerCase(); let L = Object.keys(profiles).filter(h => !profiles[h].stub || on.by.has(h));
                if (q) L = L.filter(h => profiles[h].n.toLowerCase().includes(q) || h.startsWith(q));
                if (m.only === "online") L = L.filter(h => on.by.has(h)); else if (m.only === "staff") L = L.filter(h => ROLE.get(h)); else if (m.only === "banned") L = L.filter(h => bans.has(h));
                L.sort((a, b) => m.sort === "coins" ? profiles[b].coins - profiles[a].coins : m.sort === "first" ? profiles[b].first - profiles[a].first : profiles[b].last - profiles[a].last);
                return send(200, { total: L.length, players: L.slice(0, 300).map(h => adminView(h, on)) });
            }
            if (route === "catalog") return send(200, { items: Object.keys(PRICE).map(k => ({ id: k, p: PRICE[k].p, lk: PRICE[k].lk })) });
            if (route === "announce") { const txt = cleanName(m.txt, 80); if (!txt) return send(400, { error: "empty" }); for (const R of rooms.values()) bc(R, { t: "ev", k: "announce", txt }); logEv("announce", "", "", txt); return send(200, { ok: 1 }); }
            const uh = findRef(m.ref), p = uh && profiles[uh];
            if (!p) return send(404, { error: "player not found" });
            if (route === "give" || route === "revoke") {
                const item = str(m.item, 12); if (!REG_IDS.has(item)) return send(400, { error: "unknown item" });
                const L = new Set(gl(uh)); if (route === "give") L.add(item); else L.delete(item);
                if (L.size) grants[uh] = [...L]; else delete grants[uh]; saveGrants(); socksOf(uh).forEach(w => sendGrants(w, route === "give" ? item : ""));
                logEv(route, uh, p.n, item); return send(200, { ok: 1 });
            }
            if (route === "coins") {
                const v = Math.max(0, Math.min(1e9, num(m.v))); p.coins = m.mode === "add" ? Math.min(1e9, p.coins + v) : v; p.ls = n; p.stub = 0; if (m.candy != null) p.candy = Math.max(0, Math.min(1e6, num(m.candy)));
                logEv("coins", uh, p.n, "now " + p.coins); mark(); pushFix(uh); return send(200, { ok: 1 });
            }
            if (route === "rename") { const nm = cleanName(m.n, 12); if (!nm) return send(400, { error: "empty" }); p.n = nm; mark(); pushProfile(uh); return send(200, { ok: 1 }); }
            if (route === "role") {
                const r = m.role === "owner" || m.role === "mod" ? m.role : ""; if (CFG.has(uh)) return send(400, { error: "This role is set in server.js / env vars - change it there." });
                if (r) ROLE.set(uh, r); else ROLE.delete(uh); saveStaff();
                socksOf(uh).forEach(w => { w.role = r; if (!r && w.uc) { w.uc = 0; } }); logEv("role", uh, p.n, r || "none"); return send(200, { ok: 1, note: "Takes effect in-game the next time they change map / reconnect." });
            }
            if (route === "ban") {
                if (m.on) { if (ROLE.get(uh) === "owner") return send(400, { error: "cannot ban an owner" }); bans.add(uh); socksOf(uh).forEach(w => { w.send(JSON.stringify({ t: "ev", k: "banned" })); w.close(); }); } else bans.delete(uh);
                saveBans(); logEv(m.on ? "ban" : "unban", uh, p.n, ""); return send(200, { ok: 1 });
            }
            if (route === "kick") { socksOf(uh).forEach(w => { w.send(JSON.stringify({ t: "ev", k: "kicked" })); w.close(); }); logEv("kick", uh, p.n, ""); return send(200, { ok: 1 }); }
            if (route === "link") {   // m.ref = OLD profile, m.to = NEW profile (the one the player is using now)
                const to = findRef(m.to); if (!to || to === uh) return send(400, { error: "pick a different target profile" });
                moveProfile(uh, to, true); return send(200, { ok: 1 });
            }
            if (route === "delete") { if (on.by.has(uh) || ROLE.get(uh)) return send(400, { error: "player is online or staff" }); delete profiles[uh]; delete grants[uh]; saveGrants(); logEv("delete", uh, p.n, ""); mark(); return send(200, { ok: 1 }); }
            return send(404, { error: "unknown route" });
        } catch (e) { console.log("[admin] " + e.message); return send(500, { error: "server error" }); }
    });
};


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
            sendGrants(ws); onJoin(ws);
        } else if (m.t === "save" && ws.uh) {
            doSave(ws, m);
        } else if (m.t === "restore" && ws.uh) {
            doRestore(ws, m, ip);
        } else if (m.t === "s" && ws.room) {
            const pl = ws.room.m.get(ws.id); if (!pl) return; pl.last = Date.now(); const s = pl.s, d = m.d || {}, e = d.e || {};
            s.x = num(d.x); s.y = num(d.y); s.vx = num(d.vx); s.vy = num(d.vy);
            s.f = d.f === -1 ? -1 : 1;
            if (Array.isArray(d.h) && d.h.length >= 4) s.h = d.h.slice(0, 4).map(num);
            s.hu = num(d.hu); pl.rn = cleanName(d.n, 12) || "Monke";
            if (ws.uh && profiles[ws.uh] && profiles[ws.uh].stub) profiles[ws.uh].n = pl.rn;   // new player who has not saved yet: show their name in the dashboard
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
        if (ws.uh && ws.jt && profiles[ws.uh]) { const p = profiles[ws.uh]; p.secs = (p.secs || 0) + Math.min(21600, (Date.now() - ws.jt) / 1000); p.last = Date.now(); mark(); }
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
