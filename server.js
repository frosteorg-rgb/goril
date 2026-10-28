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

/* ===================== ADMIN DASHBOARD KEY =====================
   Open http://YOUR-SERVER/admin and type this key. Set ADMIN_KEY as an env var, or let the server create data/admin-key.txt. */
const ADMIN_KEY = process.env.ADMIN_KEY || (() => {
    let k = ""; try { k = fs.readFileSync(path.join(DATA, "admin-key.txt"), "utf8").trim(); } catch (e) { }
    if (k.length < 16) { k = crypto.randomBytes(16).toString("hex"); try { fs.writeFileSync(path.join(DATA, "admin-key.txt"), k); } catch (e) { } }
    return k;
})();
/* ================================================================ */

/* ===================== STAFF LIST (server-side only) =====================
   1. Open the game, walk to the lobby computer, press "Show" under "Your player ID".
   2. Paste that ID below (dashes are fine). It never leaves this file / the server,
      so players cannot see it by viewing the page source.
   3. Restart the server.
   You can also use env vars instead: OWNER_IDS="id1,id2"  MOD_IDS="id3,id4"
   Roles:  owner = everything (incl. ban, give cosmetics, can act on mods)   mod = kick + troll tools */
const STAFF_IDS = { owner: [], mod: [] };   // leave empty and use environment variables instead (this file may be in a public repo):
//   OWNER_ID = your player ID      MOD_ID = a moderator's player ID
//   several people? comma-separate them:  OWNER_ID="id1,id2"   MOD_ID="id3,id4"   (OWNER_IDS / MOD_IDS also work)
/* ======================================================================== */

/* ===================== DISCORD REPORTS (server-side only) =====================
   Player reports are posted to a private Discord channel through a webhook.
   1. In Discord: channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL.
   2. Set it as an environment variable (recommended):  DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."
      or paste it between the quotes below. It never reaches players' browsers.
   Keep the channel private and never put the URL in a public repo. (Needs Node 18+.) */
const WEBHOOK = (process.env.DISCORD_WEBHOOK || cfg.DISCORD_WEBHOOK || "").trim();
const WEBHOOK_OK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i.test(WEBHOOK);   // a placeholder / empty value counts as "not set up"
/* ======================================================================== */

/* ===================== CALL-A-MOD WEBHOOK (server-side only) =====================
   Players press "Call a mod" in the menu: every mod/owner online is notified in-game and a message is posted to a SECOND Discord webhook.
   Set it as an environment variable:  DISCORD_CALLMOD_WEBHOOK="https://discord.com/api/webhooks/..."   (or in config.json). */
const WEBHOOK2 = (process.env.DISCORD_CALLMOD_WEBHOOK || cfg.DISCORD_CALLMOD_WEBHOOK || "").trim();
const WEBHOOK2_OK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i.test(WEBHOOK2);
/* ================================================================================= */

/* ===================== GORILAGENT WEBHOOK (server-side only) =====================
   GorilAgent (the anti-cheat) posts everything it finds to its OWN Discord webhook - separate from reports and call-a-mod.
   Set:  DISCORD_ANTICHEAT_WEBHOOK="https://discord.com/api/webhooks/..."   (or DISCORD_ANTICHEAT_WEBHOOK in config.json)
   Optional: GORILAGENT_AUTOKICK=1 makes it kick non-staff players that reach HIGH RISK (off by default: alerts only). */
const WEBHOOK3 = (process.env.DISCORD_ANTICHEAT_WEBHOOK || cfg.DISCORD_ANTICHEAT_WEBHOOK || "").trim();
const WEBHOOK3_OK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i.test(WEBHOOK3);
const AUTOKICK = !!process.env.GORILAGENT_AUTOKICK;

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const norm = v => String(v == null ? "" : v).toLowerCase().replace(/[^a-f0-9]/g, "");
const ROLE = new Map();           // sha256(id) -> "owner" | "mod"  (raw IDs are never kept in memory)
const addIds = (list, r) => list.forEach(i => { const n = norm(i); if (n.length === 32) ROLE.set(sha(n), r); });
const envList = (...names) => names.map(n => process.env[n] || "").join(",").split(",").map(x => x.trim()).filter(Boolean);   // never undefined
addIds(STAFF_IDS.owner || [], "owner"); addIds(STAFF_IDS.mod || [], "mod");
addIds(envList("OWNER_ID", "OWNER_IDS"), "owner"); addIds(envList("MOD_ID", "MOD_IDS"), "mod"); addIds(envList("CREATOR_ID", "CREATOR_IDS"), "creator");
const CFG = new Set(ROLE.keys());   // staff set in this file / env vars (not editable in-game)
const STF = dp("staff.json");   // staff promoted in-game / from the dashboard (hashed IDs). Old format (array of mods) still loads.
{
    const sj = readJSON(STF, []);
    const mods = Array.isArray(sj) ? sj : (sj.mod || []), owners = Array.isArray(sj) ? [] : (sj.owner || []);
    mods.forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "mod"); }); owners.forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "owner"); });
    (Array.isArray(sj) ? [] : (sj.creator || [])).forEach(h => { if (!ROLE.has(h)) ROLE.set(h, "creator"); });
}
const saveStaff = () => writeJSON(STF, { owner: [...ROLE].filter(([h, r]) => r === "owner" && !CFG.has(h)).map(x => x[0]), mod: [...ROLE].filter(([h, r]) => r === "mod" && !CFG.has(h)).map(x => x[0]), creator: [...ROLE].filter(([h, r]) => r === "creator" && !CFG.has(h)).map(x => x[0]) });
const RANK = { owner: 2, mod: 1, creator: 0.5, "": 0 };
const isStaff = w => w.role === "owner" || w.role === "mod";   // content creators have a role, but none of the staff powers
if (![...ROLE.values()].includes("owner")) console.log("WARNING: no owner is set. Set the OWNER_ID environment variable to your player ID (menu > Show), then restart.");
console.log("Staff loaded: " + [...ROLE.values()].filter(r => r === "owner").length + " owner(s), " + [...ROLE.values()].filter(r => r === "mod").length + " mod(s)");

// bans are stored as hashed IDs in bans.json (delete an entry to unban)
const BANF = dp("bans.json");
let bans = new Set(); try { bans = new Set(JSON.parse(fs.readFileSync(BANF, "utf8"))); } catch (e) { }
const saveBans = () => { try { fs.writeFileSync(BANF, JSON.stringify([...bans])); } catch (e) { } };

/* ---------- COSMETIC CATALOG (server copy: anything not listed here is rejected) ---------- */
const SLOTS = {
    hat: ["beanie", "party", "cowboy", "top", "prop", "halo", "crown", "wiz", "horns", "witch", "pumpkin", "mummy", "skullcap", "gpump", "cc_cap"],
    face: ["shades", "monocle", "stache", "nose", "visor", "vamp", "stitch", "skullmask"],
    back: ["pack", "cape", "wings", "jet", "bat", "ghost", "candybag", "broom", "scythe", "cc_cam"],
    trail: ["spark", "fire", "bubble", "rain", "star", "heart", "bats", "candy", "wisp", "ember", "witchfire", "cc_sub"],
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
    if (creating) { if (num(d.coins) > 20000 || num(d.candy) > 1500) GA.flag(ws, "economy", "new profile imported " + num(d.coins) + " coins / " + num(d.candy) + " candy"); coins = Math.min(coins, 100000); candy = Math.min(candy, 5000); }   // first save = importing the progress the player already has
    else if (ws.role !== "owner") {                         // owners can use their +1000 coins button; everyone else can only gain at a believable rate
        const dt = Math.min(3600, (n - (pr.ls || n)) / 1000), A = 400 + dt * 12;
        if (candy > pr.candy + 20 + dt * 3) { candy = Math.floor(pr.candy + 20 + dt * 3); fix = 1; }
        let cost = 0; for (const k of newPaid) { const it = PRICE[k]; if (it.lk) { if (candy < it.lk) delete own[k]; } else cost += it.p; }
        let max = pr.coins + A - cost; if (max < 0) { newPaid.forEach(k => { if (!PRICE[k].lk) delete own[k]; }); max = pr.coins + A; }
        if (coins > max) { coins = Math.max(0, Math.floor(max)); fix = 1; }
    }
    if (fix) { pr.flags++; logEv("clamp", uh, pr.n, "coins/candy corrected"); GA.flag(ws, "economy", "coins/candy rose faster than possible; server clamped them to " + coins + " / " + candy); }
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
    const L = (tries.get(ip) || []).filter(t => n - t < 3600000); if (L.length >= 10) { GA.flag(ws, "restore", "more than 10 account-restore attempts in an hour"); return note(ws, "Too many tries - wait an hour."); } L.push(n); tries.set(ip, L);
    const old = norm(m.old); if (old.length !== 32) return note(ws, "That does not look like a player ID.");
    const oh = sha(old); if (oh === ws.uh) return note(ws, "That is already your current ID.");
    if (bans.has(oh)) { GA.flag(ws, "banevade", "tried to restore a BANNED account onto a new ID"); return note(ws, "That account is banned."); }
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
const adminFails = new Map(), logTok = new Map(), sess = new Map();   // logTok: one-time links from the in-game staff menu, sess: dashboard sessions they turn into
const sessOK = t => { const e = sess.get(t); if (!e) return false; if (e < Date.now()) { sess.delete(t); return false; } return true; };
setInterval(() => { const n = Date.now(); logTok.forEach((v, k) => v < n && logTok.delete(k)); sess.forEach((v, k) => v < n && sess.delete(k)); }, 60000);
const ipOf = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
const adminOK = req => {
    const ip = ipOf(req), n = Date.now(), F = (adminFails.get(ip) || []).filter(t => n - t < 600000);
    if (F.length >= 10) { GA.raw("Admin dashboard brute force", "Many failed admin-key attempts from " + GA.mask(ip), 0xe62117); return 429; }
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(ADMIN_KEY))) || sessOK(given)) return 200;
    F.push(n); adminFails.set(ip, F); return 401;
};
const adminView = (uh, on) => {
    const p = profiles[uh], o = on.by.get(uh);
    return { ref: uh, id: uh.slice(0, 10), n: p.n, coins: p.coins, candy: p.candy, own: Object.keys(p.own), granted: gl(uh), eq: p.eq, first: p.first, last: p.last, logins: p.logins, secs: Math.round(p.secs || 0), flags: p.flags || 0, stub: p.stub ? 1 : 0, role: ROLE.get(uh) || "", cfg: CFG.has(uh) ? 1 : 0, banned: bans.has(uh) ? 1 : 0, online: o ? 1 : 0, room: o ? o.room : "" };
};
const findRef = r => { r = String(r || "").toLowerCase(); return /^[a-f0-9]{64}$/.test(r) && profiles[r] ? r : null; };
const adminApi = (req, res, route) => {
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(o)); };
    let body = ""; req.on("data", c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
        let m = {}; if (body) try { m = JSON.parse(body); } catch (e) { return send(400, { error: "bad json" }); }
        if (route === "login") {   // exchange the one-time link from the in-game staff menu for a dashboard session (8 h)
            const ip = ipOf(req), n0 = Date.now(), F = (adminFails.get(ip) || []).filter(t => n0 - t < 600000);
            if (F.length >= 10) return send(429, { error: "Too many tries, wait 10 minutes." });
            const tk = String(m.token || ""), exp = logTok.get(tk); logTok.delete(tk);
            if (!exp || exp < n0) { F.push(n0); adminFails.set(ip, F); return send(401, { error: "That link expired - press the button in the game again." }); }
            const t = crypto.randomBytes(24).toString("hex"); sess.set(t, n0 + 8 * 3600000); return send(200, { key: t });
        }
        const st = adminOK(req); if (st !== 200) return send(st, { error: st === 429 ? "Too many wrong keys, wait 10 minutes." : "Wrong key" });
        const on = onlineInfo(), n = Date.now();
        try {
            if (route === "overview") {
                const list = Object.keys(profiles).filter(h => !profiles[h].stub), day = n - 86400000;
                const h24 = stats.hist.filter(x => x[0] > day), peak = h24.reduce((a, x) => Math.max(a, x[1]), on.total);
                return send(200, { online: on.total, unique: on.by.size, rooms: on.rms, peak24: peak, total: list.length, new24: list.filter(h => profiles[h].first > day).length, new7: list.filter(h => profiles[h].first > n - 7 * 86400000).length, active24: list.filter(h => profiles[h].last > day).length, hist: stats.hist, events: events.slice(-80).reverse(), coinsTotal: list.reduce((a, h) => a + profiles[h].coins, 0), banned: bans.size, now: n, webhook: WEBHOOK_OK ? 1 : 0 });
            }
            if (route === "players") {
                const q = str(m.q, 40).toLowerCase(); let L = Object.keys(profiles).filter(h => !profiles[h].stub || on.by.has(h));
                if (q) L = L.filter(h => profiles[h].n.toLowerCase().includes(q) || h.startsWith(q));
                if (m.only === "online") L = L.filter(h => on.by.has(h)); else if (m.only === "staff") L = L.filter(h => ROLE.get(h)); else if (m.only === "banned") L = L.filter(h => bans.has(h));
                L.sort((a, b) => m.sort === "coins" ? profiles[b].coins - profiles[a].coins : m.sort === "first" ? profiles[b].first - profiles[a].first : profiles[b].last - profiles[a].last);
                return send(200, { total: L.length, players: L.slice(0, 300).map(h => adminView(h, on)) });
            }
            if (route === "webhooktest") {
                if (!WEBHOOK_OK) return send(200, { ok: 0, msg: "This server has no valid DISCORD_WEBHOOK. Set it as an environment variable on the host that runs server.js (or in config.json), then restart." });
                fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "goril reports", content: "✅ Test message from the goril admin dashboard. Reports will arrive here." }) })
                    .then(r => send(200, { ok: r.ok ? 1 : 0, msg: r.ok ? "Sent! Check your Discord channel." : "Discord answered " + r.status + (r.status === 404 || r.status === 401 ? " - the webhook was deleted or the URL is wrong." : ".") }))
                    .catch(e => send(200, { ok: 0, msg: "This server could not reach Discord: " + e.message }));
                return;
            }
            if (route === "catalog") return send(200, { items: Object.keys(PRICE).map(k => ({ id: k, p: PRICE[k].p, lk: PRICE[k].lk })).concat([...REG_IDS].filter(k => !PRICE[k]).map(k => ({ id: k, p: 0, lk: 0, gr: 1 }))) });
            if (route === "announce") { const txt = cleanName(m.txt, 80); if (!txt) return send(400, { error: "empty" }); for (const R of rooms.values()) bc(R, { t: "ev", k: "announce", txt }); logEv("announce", "", "", txt); return send(200, { ok: 1 }); }
            if (route === "agent") return send(200, { webhook: WEBHOOK3_OK ? 1 : 0, autokick: AUTOKICK ? 1 : 0, risk: GA.risk(), recent: GA.recent.slice(-100).reverse() });
            if (route === "agenttest") {
                if (!WEBHOOK3_OK) return send(200, { ok: 0, msg: "No valid DISCORD_ANTICHEAT_WEBHOOK is set on this server." });
                fetch(WEBHOOK3, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "GorilAgent", content: "✅ GorilAgent test message. Anti-cheat alerts will arrive here." }) })
                    .then(r => send(200, { ok: r.ok ? 1 : 0, msg: r.ok ? "Sent! Check the anti-cheat channel." : "Discord answered " + r.status }))
                    .catch(e => send(200, { ok: 0, msg: "Could not reach Discord: " + e.message }));
                return;
            }
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
                const r = m.role === "owner" || m.role === "mod" || m.role === "creator" ? m.role : ""; if (CFG.has(uh)) return send(400, { error: "This role is set in server.js / env vars - change it there." });
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
const bad = (pl, ws, why, kind) => { badItem(pl); GA.flag(ws, kind || "cosmetic", why, pl); };
const track = (pl, ws) => {
    const c = pl.cs, s = pl.s, n = Date.now(); if (isStaff(ws)) return;            // staff are exempt (they can fly / teleport)
    c.ups = c.ups.filter(t => n - t < 1000); c.ups.push(n);
    if (c.ups.length > 45 && n - c.flt > 5000) { c.flood++; c.flt = n; GA.flag(ws, "flood", "sent over 45 position updates in one second", pl); }       // the real client sends ~22 updates/sec
    if (s.h.some(v => Math.abs(v) > 100) && n - c.ht > 5000) { c.hand++; c.ht = n; GA.flag(ws, "hands", "arm offsets beyond the allowed range", pl); }
    if (Math.hypot(s.vx, s.vy) > 1900 && n - c.vt > 5000) { c.vel++; c.vt = n; GA.flag(ws, "velocity", "reported velocity " + Math.round(Math.hypot(s.vx, s.vy)) + " px/s (game max 1500)", pl); }   // the game clamps speed to 1500
    const quiet = n - c.fx < 4000 || ws.room.lobby;                            // staff launches/teleports and lobby respawns are legit
    if (c.px != null) {
        const gap = (n - c.pt) / 1000, dist = Math.hypot(s.x - c.px, s.y - c.py);
        if (!quiet && gap < 1.5 && dist > 1000 + 1700 * gap && n - c.tt > 2000) { c.tele++; c.tt = n; GA.flag(ws, "teleport", "moved " + Math.round(dist) + "px in " + gap.toFixed(2) + "s", pl); }
    }
    c.px = s.x; c.py = s.y; c.pt = n; GA.bounds(ws, pl);
    c.smp.push([n, s.x, s.y]); while (c.smp.length && n - c.smp[0][0] > 1000) c.smp.shift();
    const a = c.smp[0], span = (n - a[0]) / 1000;
    if (span >= 0.5 && !quiet) {
        const v = Math.hypot(s.x - a[1], s.y - a[2]) / span;
        if (v > c.maxv) c.maxv = v;
        if (v > 2600 && n - c.st > 3000) { c.spd++; c.st = n; GA.flag(ws, "speed", "averaged " + Math.round(v) + " px/s over 1s (normal max ~1500)", pl); }                // generous margin for network bursts
    }
};
const checkOf = tp => {
    const c = tp.cs, secs = (Date.now() - c.t0) / 1000 | 0, fl = [];
    if (isStaff(tp.ws) && !tp.ws.uc) return { v: "staff", secs, maxv: 0, fl };     // undercover staff look like ordinary clean players
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
    ws.cb = (ws.cb || []).filter(t => n - t < 8000); if (ws.cb.length >= 6) { GA.flag(ws, "chat", "hit the chat rate limit (spam)"); return note(ws, "Slow down a little!"); }
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
    GA.reported(tp, ws, m.why);
    if (!WEBHOOK_OK || typeof fetch !== "function") {
        logEv("reportfail", "", "", "no valid DISCORD_WEBHOOK on this server");
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
        .then(r => { if (!r.ok) { console.log("[report] Discord answered " + r.status); logEv("reportfail", "", "", "Discord answered " + r.status); } })
        .catch(e => { console.log("[report] could not reach Discord: " + e.message); logEv("reportfail", "", "", "cannot reach Discord"); });
    console.log("[report] " + dn(me) + " -> " + dn(tp) + " (" + why + ")");
    note(ws, "Report sent to the staff team. Thank you!");
};


/* ===================== GORILAGENT =====================
   Server-side anti-cheat. Everything it sees is scored per player (score halves every 10 minutes).
   - Immediate alert: staff items on non-staff, fake staff commands, privilege escalation, ban evasion, tampered character size, mass reports.
   - Score alert (>= 10 = SUSPICIOUS, >= 22 = HIGH RISK): speed / teleport / arm / velocity hacks, packet flooding, cosmetics the player does not own,
     illegal cosmetics, coin/candy tampering, leaving the map, chat spam, staff impersonation.
   - Also watches: admin dashboard brute force, connection floods, moderators firing lots of staff actions (possible abuse).
   All alerts go to DISCORD_ANTICHEAT_WEBHOOK, are logged in the dashboard event feed, and ping online staff in game. */
const GA = (() => {
    const WT = { speed: 3, teleport: 5, hands: 4, velocity: 3, flood: 2, cosmetic: 6, unowned: 5, staffitem: 10, economy: 5, bounds: 4, chat: 1, report: 10, fakecmd: 10, privesc: 10, restore: 3, banevade: 10, msgflood: 3, impersonate: 4, selfmod: 10 };
    const LBL = { speed: "Impossible speed", teleport: "Teleporting", hands: "Impossible arm positions", velocity: "Impossible velocity values", flood: "Update flooding", cosmetic: "Illegal cosmetic", unowned: "Wearing a cosmetic they don't own", staffitem: "Staff-only item", economy: "Coins/candy tampering", bounds: "Outside the map", chat: "Chat spam", report: "Mass reports", fakecmd: "Fake staff command", privesc: "Privilege escalation attempt", restore: "Account-restore brute force", banevade: "Ban evasion attempt", msgflood: "Packet flooding", impersonate: "Staff impersonation", selfmod: "Tampered character size" };
    const IMM = new Set(["staffitem", "fakecmd", "privesc", "banevade", "selfmod", "report"]);
    const rec = new Map(), recent = [], q = [], raws = new Map(), rp = new Map(), acts = new Map();
    const BOUNDS = { lobby: [2600, 1500], city: [3400, 1700], forest: [3800, 1700], sky: [3400, 1800], staff: [1800, 900] };
    const mask = ip => String(ip || "?").replace(/^(\d+\.\d+)\.\d+\.\d+$/, "$1.x.x");
    const post = body => { if (!WEBHOOK3_OK || typeof fetch !== "function") return; if (q.length < 40) q.push(body); };
    setInterval(() => {
        const b = q.shift(); if (!b) return;
        fetch(WEBHOOK3, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
            .then(r => { if (!r.ok) console.log("[gorilagent] Discord answered " + r.status); })
            .catch(e => console.log("[gorilagent] could not reach Discord: " + e.message));
    }, 1500);
    const staffPing = txt => { const m = JSON.stringify({ t: "ev", k: "note", txt: String(txt).slice(0, 80) }); for (const w of wss.clients) if (w.readyState === 1 && w.room && isStaff(w)) w.send(m); };
    const mine = ws => ws.room && ws.room.m.get(ws.id);
    const alert = (lvl, ws, r, pl) => {
        const hi = lvl === "high", n = Date.now(), ck = pl ? checkOf(pl) : null;
        const log = r.log.slice(-8).map(x => "[" + ((n - x.t) / 1000 | 0) + "s ago] " + x.kind + ": " + x.d).join("\n");
        post({
            username: "GorilAgent", allowed_mentions: { parse: [] },
            embeds: [{
                title: hi ? "🚨 GorilAgent: HIGH RISK player" : "🕵️ GorilAgent: suspicious activity", color: hi ? 0xe62117 : 0xe8761a, timestamp: new Date(n).toISOString(),
                fields: [
                    { name: "Player", value: "**" + clean(r.name, 12) + "**" + (ws.role ? " (" + ws.role + ")" : "") + "\nref `" + r.ref + "`", inline: true },
                    { name: "Risk score", value: r.score.toFixed(1) + (hi ? " (high risk)" : ""), inline: true },
                    { name: "Room", value: "`" + clean(ws.rname || "-", 40) + "`", inline: true },
                    { name: "What triggered it", value: Object.keys(r.k).map(k => (LBL[k] || k) + " x" + r.cnt[k]).join(", ").slice(0, 900) || "-" },
                    { name: "Recent detections", value: ("```\n" + clean(log, 850) + "\n```").slice(0, 1000) },
                    { name: "Movement check", value: ck ? ("**" + ck.v + "** - peak " + ck.maxv + " px/s over " + ck.secs + "s") : "n/a" },
                    { name: "Suggested action", value: hi ? "Review now. Kick/ban from the staff menu if it checks out." : "Keep an eye on them; use Check in game." }
                ]
            }]
        });
        staffPing("🕵 GorilAgent: " + r.name + " flagged (" + (hi ? "HIGH RISK" : "suspicious") + ")");
        logEv("agent", ws.uh, r.name, (hi ? "HIGH " : "SUSP ") + r.score.toFixed(1));
        console.log("[gorilagent] " + (hi ? "HIGH RISK " : "suspicious ") + r.name + " score " + r.score.toFixed(1));
        if (hi && AUTOKICK && !isStaff(ws) && !ws.role && ws.readyState === 1) { ws.send(JSON.stringify({ t: "ev", k: "kicked" })); ws.close(); }
    };
    const flag = (ws, kind, detail, pl) => {
        if (!ws) return; if (ws.role === "owner") return; if (isStaff(ws) && kind !== "privesc") return;
        const n = Date.now(), key = ws.uh || "id:" + ws.id, P = pl || mine(ws), name = P ? dn(P) : "(not in a room)";
        let r = rec.get(key); if (!r) { r = { name, ref: ws.uh ? ws.uh.slice(0, 10) : "no-id", score: 0, t: n, k: {}, cnt: {}, log: [], alert: 0, hi: 0 }; rec.set(key, r); }
        r.name = name; r.cnt[kind] = (r.cnt[kind] || 0) + 1;
        if (n - (r.k[kind] || 0) < 20000) return;           // count repeats, but only score / log a kind every 20 s
        r.k[kind] = n; r.score = r.score * Math.pow(0.5, (n - r.t) / 600000) + (WT[kind] || 2); r.t = n;
        r.log.push({ t: n, kind: LBL[kind] || kind, d: String(detail).slice(0, 140) }); if (r.log.length > 20) r.log.shift();
        recent.push({ t: n, name, ref: r.ref, kind, detail: String(detail).slice(0, 140), score: +r.score.toFixed(1) }); while (recent.length > 300) recent.shift();
        console.log("[gorilagent] " + name + " " + kind + ": " + detail);
        if (r.score >= 22 && n - r.hi > 600000) { r.hi = n; r.alert = n; alert("high", ws, r, P); }
        else if ((IMM.has(kind) || r.score >= 10) && n - r.alert > 300000) { r.alert = n; alert("sus", ws, r, P); }
    };
    const raw = (title, desc, color) => {
        const n = Date.now(); if (n - (raws.get(title) || 0) < 300000) return; raws.set(title, n);
        post({ username: "GorilAgent", allowed_mentions: { parse: [] }, embeds: [{ title: "🛡 GorilAgent: " + title, description: String(desc).slice(0, 1500), color: color || 0xe8761a, timestamp: new Date(n).toISOString() }] });
        logEv("agent", "", "", title); console.log("[gorilagent] " + title + ": " + desc);
    };
    const reported = (tp, ws, why) => {   // many DIFFERENT players reporting the same person within 15 minutes
        const n = Date.now(), key = tp.ws.uh || "id:" + tp.ws.id, by = ws.uh || "id:" + ws.id;
        const L = (rp.get(key) || []).filter(x => n - x.t < 900000 && x.by !== by); L.push({ by, t: n, why: REASONS[why] ? why : "other" }); rp.set(key, L);
        if (L.length >= 3) { const w2 = {}; L.forEach(x => w2[x.why] = (w2[x.why] || 0) + 1); flag(tp.ws, "report", L.length + " different players reported them in 15 min (" + Object.keys(w2).map(k => REASONS[k] + " x" + w2[k]).join(", ") + ")", tp); }
    };
    const checkOutfit = (ws, pl) => {   // wearing a priced cosmetic the saved profile says they never bought / were given (20 s grace for save lag)
        if (!ws.uh || isStaff(ws)) return; const pr = profiles[ws.uh]; if (!pr || pr.stub) return;
        const n = Date.now(), g = new Set(gl(ws.uh)); pl.ow = pl.ow || {};
        for (const slot in pl.s.e) {
            const v = pl.s.e[slot]; if (!v || v === "none" || !PRICE[v]) continue;
            if (pr.own[v] || g.has(v)) { delete pl.ow[v]; continue; }
            const first = pl.ow[v] || (pl.ow[v] = n); if (n - first > 20000) flag(ws, "unowned", "wearing " + v + " (" + slot + ") but it is not in their saved inventory", pl);
        }
    };
    const checkName = (ws, pl) => {
        if (pl.chk === pl.rn || isStaff(ws)) return; pl.chk = pl.rn;
        if (/\b(owner|admin|staff|moderator)\b|\[(mod|owner|staff)\]/i.test(pl.rn)) return flag(ws, "impersonate", "name \"" + pl.rn + "\" looks like a staff tag", pl);
        for (const o of ws.room.m.values()) if (o !== pl && isStaff(o.ws) && !o.ws.uc && o.rn.toLowerCase() === pl.rn.toLowerCase()) return flag(ws, "impersonate", "copied the name of staff member " + o.rn, pl);
    };
    const bounds = (ws, pl) => {
        const B = BOUNDS[String(ws.rname || "").split("-").pop()]; if (!B) return; const s = pl.s;
        if (s.x < -200 || s.x > B[0] + 200 || s.y < -300 || s.y > B[1] + 500) flag(ws, "bounds", "reported position (" + s.x + "," + s.y + ") is outside the map", pl);
    };
    const staffAct = (ws, k, me) => {
        const n = Date.now(), L = (acts.get(ws.id) || []).filter(t => n - t < 120000); L.push(n); acts.set(ws.id, L);
        if (L.length >= 15) raw("Possible staff abuse", "Moderator **" + clean(dn(me), 12) + "** (ref " + (ws.uh ? ws.uh.slice(0, 10) : "?") + ") used " + L.length + " staff actions in 2 minutes (latest: " + k + ").", 0xe62117);
    };
    const risk = () => [...rec.values()].map(r => ({ name: r.name, ref: r.ref, score: +(r.score * Math.pow(0.5, (Date.now() - r.t) / 600000)).toFixed(1), kinds: r.cnt })).filter(r => r.score >= 1).sort((a, b) => b.score - a.score).slice(0, 25);
    setInterval(() => { const n = Date.now(); rec.forEach((r, k) => { if (n - r.t > 7200000) rec.delete(k); }); rp.forEach((L, k) => { if (!L.some(x => n - x.t < 900000)) rp.delete(k); }); acts.forEach((L, k) => { if (!L.some(t => n - t < 120000)) acts.delete(k); }); }, 600000);
    console.log("GorilAgent anti-cheat: active" + (WEBHOOK3_OK ? " (Discord alerts on)" : " (NO valid DISCORD_ANTICHEAT_WEBHOOK - alerts go to the console / dashboard only)") + (AUTOKICK ? ", auto-kick ON" : ""));
    return { flag, raw, mask, reported, checkOutfit, checkName, bounds, staffAct, risk, recent };
})();

// --- "Call a mod": notifies every mod/owner online (any room) and posts to the call-a-mod Discord webhook ---
const doCallMod = ws => {
    const n = Date.now(), R = ws.room, me = R && R.m.get(ws.id); if (!me) return;
    ws.cml = (ws.cml || []).filter(t => n - t < 3600000);
    if (n - (ws.cm || 0) < 60000) return note(ws, "You already called a mod. Please wait a minute before calling again.");
    if (ws.cml.length >= 5) return note(ws, "You have called a lot - please try again later.");
    const i = ws.rname.lastIndexOf("-"), code = i > 0 ? ws.rname.slice(0, i) : ws.rname, map = i > 0 ? ws.rname.slice(i + 1) : "";
    const nm = dn(me), msg = JSON.stringify({ t: "ev", k: "modcall", n: nm, code, map });
    let cnt = 0; for (const w of wss.clients) if (w !== ws && w.readyState === 1 && w.room && isStaff(w)) { w.send(msg); cnt++; }
    const hook = WEBHOOK2_OK && typeof fetch === "function";
    if (!cnt && !hook) return note(ws, "No moderators are online right now.");
    ws.cm = n; ws.cml.push(n);
    if (hook) {
        const ck = checkOf(me), chat = R.chat.slice(-8).map(c => "[" + ((n - c.at) / 1000 | 0) + "s ago] " + clean(c.n, 12) + ": " + clean(c.t, 120)).join("\n") || "(no recent chat)";
        const body = {
            username: "goril - call a mod", allowed_mentions: { parse: [] },
            embeds: [{
                title: "🆘 A player is asking for a moderator", color: 0xe62117, timestamp: new Date(n).toISOString(),
                fields: [
                    { name: "Player", value: "**" + clean(nm, 12) + "**" + (ws.role ? " (" + ws.role + ")" : ""), inline: true },
                    { name: "Player ID", value: "`" + ref(me) + "`", inline: true },
                    { name: "Room code", value: "`" + clean(code, 16) + "` on **" + clean(map, 10) + "**", inline: true },
                    { name: "Players in that room", value: String(R.m.size), inline: true },
                    { name: "Mods online in game", value: String(cnt), inline: true },
                    { name: "Automatic check", value: ("**" + ck.v + "** - " + (ck.fl.join(", ") || "no flags")).slice(0, 500) },
                    { name: "Recent chat in that room", value: "```\n" + chat.slice(0, 900) + "\n```" }
                ]
            }]
        };
        fetch(WEBHOOK2, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .then(r => { if (!r.ok) { console.log("[callmod] Discord answered " + r.status); logEv("reportfail", "", "", "call-a-mod Discord answered " + r.status); } })
            .catch(e => { console.log("[callmod] could not reach Discord: " + e.message); logEv("reportfail", "", "", "cannot reach Discord (call a mod)"); });
    }
    logEv("callmod", ws.uh, nm, ws.rname); console.log("[callmod] " + nm + " in " + ws.rname + " (" + cnt + " mods online)");
    note(ws, cnt ? "Moderators notified (" + cnt + " online)." : "No mods are online in game - staff were alerted on Discord.");
};

wss.on("connection", (ws, req) => {
    const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
    if ((ips.get(ip) || 0) >= MAX_PER_IP) { GA.raw("Connection flood", "More than " + MAX_PER_IP + " simultaneous connections from " + GA.mask(ip), 0xe8761a); return ws.close(); }
    ips.set(ip, (ips.get(ip) || 0) + 1);
    ws.mw = Date.now(); ws.mn = 0;
    ws.id = "p" + nid++; ws.room = null; ws.role = ""; ws.uh = null; ws.lc = 0; ws.uc = 0; ws.ucn = "";
    ws.on("message", raw => {
        const tn = Date.now(); if (tn - ws.mw >= 1000) { ws.mw = tn; ws.mn = 0; } if (++ws.mn > 120) { GA.flag(ws, "msgflood", "sent over 120 packets in one second"); return ws.close(); }   // flood protection (real traffic is ~25 msgs/sec)
        let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m !== "object") return;
        if (m.t === "join" && !ws.room) {
            // the role comes ONLY from the server's own list, matched against the player's permanent ID
            const uid = norm(m.uid); ws.uh = uid.length === 32 ? sha(uid) : null;
            if (ws.uh && bans.has(ws.uh)) { ws.send(JSON.stringify({ t: "ev", k: "banned" })); return ws.close(); }
            ws.role = (ws.uh && ROLE.get(ws.uh)) || "";
            ws.mu = ws.uh && (smute.get(ws.uh) || 0) > Date.now() ? 1 : 0;
            const name = str(m.room, 40).toLowerCase().replace(/[^a-z0-9-]/g, "") || "public-lobby";
            // the staff room only lets verified staff in (role comes from the server list, never the client)
            if (/-staff$/.test(name) && !isStaff(ws)) { ws.send(JSON.stringify({ t: "ev", k: "denied" })); return ws.close(); }
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
            if (ws.role !== "owner" && d.z != null && Math.abs((+d.z || 1) - 1) > 0.01) GA.flag(ws, isStaff(ws) ? "privesc" : "selfmod", "sent a character size of " + (+d.z || 0).toFixed(2) + " (owner-only)", pl);
            s.z = ws.role === "owner" && !ws.uc ? Math.max(0.3, Math.min(4, +d.z || 1)) : 1;   // character size is an owner-only effect
            GA.checkName(ws, pl);
            if (ws.uh && profiles[ws.uh] && profiles[ws.uh].stub) profiles[ws.uh].n = pl.rn;   // new player who has not saved yet: show their name in the dashboard
            s.n = ws.uc ? ws.ucn : pl.rn;                 // undercover staff are always shown with the server-picked name
            // every slot is checked against the server catalog. Staff items need a staff role (checked HERE, not on the client),
            // "st_o*" items are owner-only, and staff items are never shown while undercover.
            const ok = (slot, v) => {
                v = str(v, 12); if (v === "" || v === "none") return v; if (!SLOT_OK[slot].has(v)) { bad(pl, ws, "wore an item that does not exist: " + v + " (" + slot + ")"); return ""; }
                if (v.startsWith("cc_")) { if (ws.role || (ws.uh && gl(ws.uh).includes(v))) return v; bad(pl, ws, "wore content-creator item " + v + " without being given it"); return ""; }   // content creator items: only if the owner gave them to this player
                if (!v.startsWith("st_")) return v;
                if (!isStaff(ws) || ws.uc) { if (!isStaff(ws)) bad(pl, ws, "wore staff-only item " + v + " without a staff role (could also be a just-demoted staff member)", "staffitem"); return ""; } return v.startsWith("st_o") && ws.role !== "owner" ? "" : v;
            };
            s.e = { hat: ok("hat", e.hat), face: ok("face", e.face), back: ok("back", e.back), trail: ok("trail", e.trail), hand: ok("hand", e.hand) };
            GA.checkOutfit(ws, pl); track(pl, ws);
        } else if (m.t === "chat" && ws.room) {
            chatMsg(ws, m);
        } else if (m.t === "rtc" && ws.room) {
            relay(ws, m);
        } else if (m.t === "check" && ws.room) {
            doCheck(ws, m);
        } else if (m.t === "report" && ws.room) {
            doReport(ws, m);
        } else if (m.t === "callmod" && ws.room) {
            doCallMod(ws);
        } else if (m.t === "cmd" && ws.room && !ws.role) {
            GA.flag(ws, "fakecmd", "sent a staff command (" + str(m.k, 12) + ") without any staff role");
        } else if (m.t === "cmd" && ws.room && ws.role) {
            // staff tools: re-checked here on every command, the client is never trusted
            const now = Date.now(); if (now - ws.lc < (isStaff(ws) ? 150 : 900)) return; ws.lc = now;
            const R = ws.room, me = R.m.get(ws.id); if (!me) return;
            const k = str(m.k, 12), O = ws.role === "owner";
            if (!isStaff(ws)) {   // content creators: a few harmless troll effects, on ordinary players only (never staff or other creators)
                if (!["launch", "lowgrav", "invert",].includes(k)) { GA.flag(ws, "privesc", "content creator sent a staff command (" + k + ")", me); return; }
                const tp = R.m.get(str(m.to, 12)); if (!tp || tp.ws === ws || tp.ws.role) return;
                tp.cs.fx = Date.now(); tp.ws.send(JSON.stringify({ t: "fx", k, x: me.s.x, y: me.s.y })); return;
            }
            if (k === "undercover") {   // any staff: look like a normal player (no role tag, no staff items, random common name)
                const on = m.on === 1 || m.on === true;
                if (on && !ws.uc) { ws.uc = 1; ws.ucn = pickName(R); me.s.n = ws.ucn; } else if (!on) { ws.uc = 0; me.s.n = me.rn; }
                ws.send(JSON.stringify({ t: "ev", k: "uc", on: ws.uc, name: ws.uc ? ws.ucn : "" }));
                console.log("[staff] " + ws.role + " " + me.rn + " -> undercover " + (ws.uc ? "ON as " + ws.ucn : "OFF")); return;
            }
            if (k === "adminlink") {   // OWNER ONLY: hand out a one-time (60 s) link that signs the dashboard in without typing the key
                if (!O) { GA.flag(ws, "privesc", "moderator tried the owner-only admin link", me); return; } const t = crypto.randomBytes(18).toString("hex"); logTok.set(t, Date.now() + 60000);
                ws.send(JSON.stringify({ t: "ev", k: "adminlink", path: "/admin#t=" + t })); logEv("adminlink", ws.uh, me.rn, ""); return;
            }
            if (k === "announce") { const txt = cleanName(m.txt, 80); if (txt) bc(R, { t: "ev", k: "announce", txt }); return; }
            if (O && !R.lobby && k === "newround") { R.st = "wait"; R.t = 1; R.m.forEach(p => p.s.it = 0); console.log("[staff] owner " + me.rn + " -> new round"); return; }
            if (O && !R.lobby && k === "endround") { if (R.st === "play") { R.st = "end"; R.t = 5; bc(R, { t: "ev", k: "end", last: R.last }); } console.log("[staff] owner " + me.rn + " -> end round"); return; }
            if (k === "give" || k === "revoke") {   // OWNER ONLY. Saved on the server by the target's hashed ID; clients can never add to it.
                if (!O) { GA.flag(ws, "privesc", "moderator tried to give/take cosmetics", me); return; }
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
            console.log("[staff] " + ws.role + " " + me.rn + " -> " + k + " -> " + tp.rn); if (ws.role === "mod") GA.staffAct(ws, k, me);
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
            else if (k === "creator" || k === "uncreator") {   // owner makes / removes content creators live; saved in staff.json
                if (!O || !tp.ws.uh || tp.ws === ws || isStaff(tp.ws) || CFG.has(tp.ws.uh)) return;
                if (k === "uncreator" && tp.ws.role !== "creator") return;
                if (k === "creator") { ROLE.set(tp.ws.uh, "creator"); tp.ws.role = "creator"; } else { ROLE.delete(tp.ws.uh); tp.ws.role = ""; }
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
