/* OTP-PWA (https://github.com/burnersen/OTP-PWA)
   Copyright (C) 2026 burnersen
   SPDX-License-Identifier: GPL-3.0-only

   Der Kern ohne Oberfläche: Codes rechnen (TOTP, HOTP, Steam), otpauth-Links lesen und schreiben,
   Importe aus anderen Apps, Exporte, das verschlüsselte Vault-Format und das PDF-Notfallblatt.
   Alles ist eine Übertragung von otp-vault (Go) nach JavaScript, damit Sicherungen zwischen
   beiden Programmen hin und her gehen. Läuft im Browser und in Node (tools/check.js).

   Fehler für den Benutzer sind UserError mit Schlüsseln aus i18n.js (msg, hint, vars),
   die Oberfläche übersetzt sie. Fehlt eine Bibliothek, wirft der Kern einen normalen Fehler. */
"use strict";

(function (root) {
  /* ---------- Fehler ---------- */

  class UserError extends Error {
    constructor(msg, hint, vars) {
      super(msg);
      this.name = "UserError";
      this.msg = msg;
      this.hint = hint || "";
      this.vars = vars || {};
    }
  }
  const uerr = (msg, hint, vars) => new UserError(msg, hint, vars);

  // Verschlüsselte Datei ohne Passwort: die Oberfläche fragt nach und versucht es noch mal
  class NeedPassword extends Error {
    constructor(format) {
      super("password needed");
      this.name = "NeedPassword";
      this.format = format;
    }
  }

  /* ---------- Bytes, Base64, Base32, Hex, UTF-8 ---------- */

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const utf8 = (s) => enc.encode(s);
  const fromUtf8 = (b) => dec.decode(b);

  function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Standard-Base64 mit oder ohne Auffüllung, auch mit URL-Zeichen. null = kaputt.
  function b64decode(s) {
    s = String(s || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*=*$/.test(s)) return null;
    s = s.replace(/=+$/, "");
    if (s.length % 4 === 1) return null;
    s += "===".slice((s.length + 3) % 4);
    try {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  function hexDecode(s) {
    s = String(s || "");
    if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) return null;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  const hexEncode = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function base32Encode(bytes) {
    let out = "", bits = 0, val = 0;
    for (const b of bytes) {
      val = (val << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += B32[(val >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }

  // Wie Go mit NoPadding: übrige Bits müssen null sein, sonst ist der Text kein sauberes Base32
  function base32Decode(s) {
    s = String(s).replace(/=+$/, "");
    if (!s.length || /[^A-Z2-7]/.test(s)) return null;
    const rem = s.length % 8;
    if (rem === 1 || rem === 3 || rem === 6) return null;
    const out = [];
    let bits = 0, val = 0;
    for (const c of s) {
      val = ((val << 5) | B32.indexOf(c)) & 0xffff;
      bits += 5;
      if (bits >= 8) {
        out.push((val >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    if (bits > 0 && (val & ((1 << bits) - 1)) !== 0) return null;
    return out.length ? new Uint8Array(out) : null;
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }

  function wipe(b) {
    if (b && b.fill) b.fill(0);
  }

  function newID() {
    return hexEncode(randomBytes(12));
  }

  function uuid4() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = hexEncode(b);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  /* ---------- Einträge und Codes ---------- */

  const KIND_TOTP = "totp", KIND_HOTP = "hotp", KIND_STEAM = "steam";
  const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

  // Was man so einfügt (Leerzeichen, Striche, Auffüllung, Kleinbuchstaben) wird zu reinem Base32
  function normalizeSecret(s) {
    let out = "";
    for (const r of String(s || "")) {
      if (" -\t\n\r=".includes(r)) continue;
      if (r >= "a" && r <= "z") out += r.toUpperCase();
      else if ((r >= "A" && r <= "Z") || (r >= "2" && r <= "7")) out += r;
      else throw uerr("e.secretChar", "h.secretChar", { c: r });
    }
    if (!out) throw uerr("e.secretEmpty", "h.secretEmpty");
    if (!base32Decode(out)) throw uerr("e.secretBase32", "h.secretBase32");
    return out;
  }

  const intOr0 = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };

  // Füllt Standardwerte und prüft jedes Feld, damit sich aus einem geprüften Eintrag immer ein Code rechnen lässt
  function normalizeEntry(e) {
    e.kind = String(e.kind || "").trim().toLowerCase() || KIND_TOTP;
    if (![KIND_TOTP, KIND_HOTP, KIND_STEAM].includes(e.kind)) throw uerr("e.kind", "h.kind", { k: e.kind });
    e.secret = normalizeSecret(e.secret);
    e.algorithm = String(e.algorithm || "").trim().replace(/-/g, "").toUpperCase() || "SHA1";
    if (!["SHA1", "SHA256", "SHA512"].includes(e.algorithm)) throw uerr("e.algorithm", "h.algorithm", { a: e.algorithm });
    e.digits = intOr0(e.digits);
    e.period = intOr0(e.period);
    e.counter = Math.max(0, intOr0(e.counter));
    if (e.kind === KIND_STEAM) {
      e.digits = 5;
      e.algorithm = "SHA1";
    }
    if (!e.digits) e.digits = 6;
    if (e.digits < 5 || e.digits > 10) throw uerr("e.digits", "h.digits", { n: e.digits });
    if (!e.period) e.period = 30;
    if (e.period < 5 || e.period > 600) throw uerr("e.period", "h.period", { n: e.period });
    e.issuer = String(e.issuer || "").trim();
    e.account = String(e.account || "").trim();
    e.website = normalizeHost(e.website);
    e.note = String(e.note || "");
    e.icon = String(e.icon || "");
    e.favorite = !!e.favorite;
    if (!e.issuer && !e.account) throw uerr("e.noName", "h.noName");
    return e;
  }

  // Ein Eintrag genau in der Form, die otp-vault in die Datei schreibt (gleiche Felder, gleiche Reihenfolge)
  function cleanEntry(e) {
    const o = {
      id: String(e.id || ""), kind: e.kind, issuer: e.issuer, account: e.account, secret: e.secret,
      algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter || 0,
    };
    if (e.website) o.website = e.website;
    if (e.icon) o.icon = e.icon;
    if (e.note) o.note = e.note;
    if (e.favorite) o.favorite = true;
    o.created = intOr0(e.created);
    o.updated = intOr0(e.updated);
    return o;
  }

  // HMAC-Schlüssel und fertige Codes werden gemerkt, solange der Vault offen ist (forget() beim Sperren)
  const keyCache = new Map();
  const codeCache = new Map();

  function forget() {
    keyCache.clear();
    codeCache.clear();
  }

  async function hmacKey(secret, algorithm) {
    const id = algorithm + "|" + secret;
    let k = keyCache.get(id);
    if (!k) {
      const raw = base32Decode(secret);
      if (!raw) throw uerr("e.secretBase32", "h.secretBase32");
      const hash = { SHA256: "SHA-256", SHA512: "SHA-512" }[algorithm] || "SHA-1";
      k = await root.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash }, false, ["sign"]);
      wipe(raw);
      keyCache.set(id, k);
    }
    return k;
  }

  // RFC 4226: HMAC über den Zähler, dann dynamisches Abschneiden
  async function hotpValue(secret, counter, algorithm) {
    const msg = new Uint8Array(8);
    let c = BigInt(counter);
    for (let i = 7; i >= 0; i--) {
      msg[i] = Number(c & 0xffn);
      c >>= 8n;
    }
    const sum = new Uint8Array(await root.crypto.subtle.sign("HMAC", await hmacKey(secret, algorithm), msg));
    const off = sum[sum.length - 1] & 0x0f;
    return ((sum[off] & 0x7f) * 0x1000000 + sum[off + 1] * 0x10000 + sum[off + 2] * 0x100 + sum[off + 3]);
  }

  function formatCode(v, digits, kind) {
    if (kind === KIND_STEAM) {
      let out = "";
      for (let i = 0; i < 5; i++) {
        out += STEAM_ALPHABET[v % STEAM_ALPHABET.length];
        v = Math.floor(v / STEAM_ALPHABET.length);
      }
      return out;
    }
    return String(v % Math.pow(10, Math.min(digits, 10))).padStart(digits, "0");
  }

  async function codeFor(e, counter) {
    const id = e.algorithm + "|" + e.secret + "|" + e.kind + "|" + e.digits + "|" + counter;
    let code = codeCache.get(id);
    if (code === undefined) {
      code = formatCode(await hotpValue(e.secret, counter, e.algorithm), e.digits, e.kind);
      if (codeCache.size > 2000) codeCache.clear();
      codeCache.set(id, code);
    }
    return code;
  }

  // Was die Oberfläche für einen Eintrag in einem Moment zeigt
  async function codeView(e, nowMs) {
    const v = { id: e.id, current: "", next: "", remaining: 0, period: e.period };
    try {
      if (e.kind === KIND_HOTP) {
        v.current = await codeFor(e, e.counter);
        v.next = await codeFor(e, e.counter + 1);
        return v;
      }
      const secs = Math.floor(nowMs / 1000);
      const step = Math.floor(secs / e.period);
      v.current = await codeFor(e, step);
      v.next = await codeFor(e, step + 1);
      v.remaining = e.period - (secs % e.period);
    } catch (err) {
      v.current = "------";
    }
    return v;
  }

  /* ---------- otpauth-Links ---------- */

  function decodeURIPart(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  // Wie url.Values in Go: '+' ist ein Leerzeichen, %xx wird dekodiert, der erste Wert zählt
  function queryParams(q) {
    const out = {};
    for (const part of String(q || "").split("&")) {
      if (!part) continue;
      const i = part.indexOf("=");
      const k = decodeURIPart((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
      const v = i < 0 ? "" : decodeURIPart(part.slice(i + 1).replace(/\+/g, " "));
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  // Liest einen otpauth://-Link (Key Uri Format von Google Authenticator). Der Dienst kann im Namen ("GitHub:ich"),
  // im Parameter oder in beiden stehen, der Parameter gewinnt. Noch nicht normalisiert.
  function parseOTPAuth(raw) {
    const m = /^otpauth:\/\/([^/?#]*)\/?([^?#]*)(?:\?([^#]*))?/i.exec(String(raw || "").trim());
    if (!m) throw uerr("e.notOtpauth", "h.notOtpauth");
    const e = { kind: m[1].toLowerCase(), issuer: "", account: "", secret: "", algorithm: "", digits: 0, period: 0, counter: 0 };
    if (![KIND_TOTP, KIND_HOTP, KIND_STEAM].includes(e.kind)) throw uerr("e.linkKind", "h.linkKind", { k: m[1] });
    const label = decodeURIPart(m[2]);
    const i = label.indexOf(":");
    if (i >= 0) {
      e.issuer = label.slice(0, i).trim();
      e.account = label.slice(i + 1).trim();
    } else {
      e.account = label.trim();
    }
    const q = queryParams(m[3]);
    if ((q.issuer || "").trim()) e.issuer = q.issuer.trim();
    e.secret = q.secret || "";
    e.algorithm = q.algorithm || "";
    e.digits = /^\d+$/.test(q.digits || "") ? Number(q.digits) : 0;
    e.period = /^\d+$/.test(q.period || "") ? Number(q.period) : 0;
    e.counter = /^\d+$/.test(q.counter || "") ? Number(q.counter) : 0;
    if (String(q.encoder || "").toLowerCase() === "steam" || (e.kind === KIND_TOTP && e.issuer.toLowerCase() === "steam" && e.digits === 5)) {
      e.kind = KIND_STEAM;
    }
    if (!e.secret) throw uerr("e.linkNoSecret", "h.linkNoSecret");
    return e;
  }

  // Wie url.PathEscape in Go: ':' und '@' bleiben stehen, das erwartet jede App im Namen
  function pathEscape(s) {
    return encodeURIComponent(s)
      .replace(/%(24|26|2B|3A|3D|40)/g, (x, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }

  // Wie url.QueryEscape in Go, nur mit %20 statt '+' für Leerzeichen (so schreibt es otp-vault)
  const queryEscape = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  // Der Link, den andere Apps verstehen. Steam wird zu totp mit encoder=steam (lesen Aegis, 2FAS, KeePassXC).
  function buildOTPAuth(e) {
    let kind = e.kind;
    const q = { secret: e.secret, algorithm: e.algorithm, digits: String(e.digits) };
    if (e.issuer) q.issuer = e.issuer;
    if (kind === KIND_HOTP) q.counter = String(e.counter || 0);
    else if (kind === KIND_STEAM) {
      kind = KIND_TOTP;
      q.encoder = "steam";
      q.period = String(e.period);
    } else q.period = String(e.period);
    const label = e.issuer ? e.issuer + ":" + e.account : e.account;
    const qs = Object.keys(q).sort().map((k) => k + "=" + queryEscape(q[k])).join("&");
    return "otpauth://" + kind + "/" + pathEscape(label) + "?" + qs;
  }

  // "https://www.GitHub.com/login" wird zu "www.github.com"
  function normalizeHost(s) {
    s = String(s || "").trim().toLowerCase();
    if (!s) return "";
    if (!s.includes("://")) s = "https://" + s;
    let h;
    try {
      h = new URL(s).hostname;
    } catch (e) {
      return "";
    }
    if (!h.includes(".") || /[ _]/.test(h)) return "";
    return h;
  }

  // Dienste, deren Name nicht ihre Domain ist (wie in otp-vault, dazu einige deutsche)
  const KNOWN_SITES = {
    google: "google.com", gmail: "google.com", microsoft: "microsoft.com", outlook: "outlook.com",
    amazon: "amazon.com", "amazon web services": "aws.amazon.com", aws: "aws.amazon.com",
    apple: "apple.com", facebook: "facebook.com", meta: "facebook.com", instagram: "instagram.com",
    twitter: "x.com", x: "x.com", github: "github.com", gitlab: "gitlab.com",
    discord: "discord.com", steam: "steampowered.com", "epic games": "epicgames.com",
    paypal: "paypal.com", dropbox: "dropbox.com", proton: "proton.me", protonmail: "proton.me",
    bitwarden: "bitwarden.com", cloudflare: "cloudflare.com", nextcloud: "nextcloud.com",
    netcup: "netcup.de", contabo: "contabo.com", hetzner: "hetzner.com", ionos: "ionos.de",
    gmx: "gmx.net", "web.de": "web.de", ebay: "ebay.de", mastodon: "joinmastodon.org",
    reddit: "reddit.com", linkedin: "linkedin.com", twitch: "twitch.tv", ubisoft: "ubisoft.com",
    "battle.net": "battle.net", blizzard: "battle.net", nintendo: "nintendo.com", playstation: "playstation.com",
    sony: "playstation.com", xbox: "xbox.com", wordpress: "wordpress.com", binance: "binance.com",
    coinbase: "coinbase.com", kraken: "kraken.com", tesla: "tesla.com", slack: "slack.com",
    zoom: "zoom.us", atlassian: "atlassian.com", npm: "npmjs.com", pypi: "pypi.org",
    docker: "docker.com", "docker hub": "hub.docker.com", digitalocean: "digitalocean.com",
    sparkasse: "sparkasse.de", "deutsche bank": "deutsche-bank.de", commerzbank: "commerzbank.de",
    ing: "ing.de", "ing-diba": "ing.de", dkb: "dkb.de", n26: "n26.com", comdirect: "comdirect.de",
    "consorsbank": "consorsbank.de", "volksbank": "vr.de", "postbank": "postbank.de", "trade republic": "traderepublic.com",
    "scalable capital": "scalable.capital", telekom: "telekom.de", vodafone: "vodafone.de", "1&1": "1und1.de",
    strato: "strato.de", "all-inkl": "all-inkl.com", "all-inkl.com": "all-inkl.com", elster: "elster.de",
    "t-online": "t-online.de", posteo: "posteo.de", "mailbox.org": "mailbox.org", tutanota: "tuta.com", tuta: "tuta.com",
    plesk: "plesk.com", synology: "synology.com", ubiquiti: "ui.com", unifi: "ui.com", "home assistant": "home-assistant.io",
    openai: "openai.com", anthropic: "anthropic.com", claude: "claude.ai", figma: "figma.com", notion: "notion.so",
    shopify: "shopify.com", stripe: "stripe.com", "ko-fi": "ko-fi.com", patreon: "patreon.com", heroku: "heroku.com",
    vercel: "vercel.com", netlify: "netlify.com", namecheap: "namecheap.com", godaddy: "godaddy.com", ovh: "ovhcloud.com",
  };

  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Webseiten, von denen sich das Icon eines Eintrags holen lässt, die wahrscheinlichste zuerst.
  // Die E-Mail-Domain zählt nur, wenn sie zum Dienst passt: bei „GitHub, ich@gmail.com“ ist gmail.com falsch.
  function iconHosts(e) {
    const out = [];
    const add = (h) => { h = normalizeHost(h); if (h && !out.includes(h)) out.push(h); };
    add(e.website);
    const issuer = String(e.issuer || "").trim();
    const key = issuer.toLowerCase();
    if (KNOWN_SITES[key]) add(KNOWN_SITES[key]);
    if (/^[^\s]+\.[a-z]{2,}$/i.test(issuer)) add(issuer);
    const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(e.account || "").trim());
    if (m) {
      const domain = m[1].toLowerCase();
      const name = domain.split(".").slice(-2, -1)[0] || "";
      if (!issuer || (slug(issuer) && (slug(name) === slug(issuer) || slug(domain).startsWith(slug(issuer))))) add(domain);
    }
    const s = slug(issuer);
    if (s.length >= 2 && !out.length) {
      add(s + ".de");
      add(s + ".com");
    }
    return out.slice(0, 3);
  }

  /* ---------- Google Authenticator: otpauth-migration://offline?data=<Protobuf> ---------- */

  function protoReader(b) {
    let p = 0;
    const varint = () => {
      let v = 0n, shift = 0n;
      for (let i = 0; i < 10; i++) {
        if (p >= b.length) throw new Error("proto");
        const c = b[p++];
        v |= BigInt(c & 0x7f) << shift;
        if (c < 0x80) return v;
        shift += 7n;
      }
      throw new Error("proto");
    };
    return {
      more: () => p < b.length,
      next() {
        const key = Number(varint());
        const field = key >>> 3, wire = key & 7;
        if (wire === 0) return { field, wire, val: varint() };
        if (wire === 1) { if (p + 8 > b.length) throw new Error("proto"); p += 8; return { field, wire }; }
        if (wire === 5) { if (p + 4 > b.length) throw new Error("proto"); p += 4; return { field, wire }; }
        if (wire === 2) {
          const n = Number(varint());
          if (n > b.length - p) throw new Error("proto");
          const data = b.subarray(p, p + n);
          p += n;
          return { field, wire, data };
        }
        throw new Error("proto");
      },
    };
  }

  function parseMigration(raw) {
    const bad = () => uerr("e.migration", "h.migration");
    const m = /^otpauth-migration:\/\/[^?]*\?(.*)$/i.exec(String(raw || "").trim());
    if (!m) throw bad();
    const data = (queryParams(m[1]).data || "").replace(/ /g, "+");
    const payload = b64decode(data);
    if (!payload) throw bad();
    const out = [];
    try {
      const r = protoReader(payload);
      while (r.more()) {
        const f = r.next();
        if (f.field !== 1 || f.wire !== 2) continue;
        out.push(parseMigrationEntry(f.data));
      }
    } catch (err) {
      throw bad();
    }
    if (!out.length) throw uerr("e.migrationEmpty", "h.migrationEmpty");
    return out;
  }

  function parseMigrationEntry(msg) {
    const e = { kind: KIND_TOTP, algorithm: "SHA1", digits: 6, issuer: "", account: "", secret: "", period: 0, counter: 0 };
    const r = protoReader(msg);
    while (r.more()) {
      const f = r.next();
      const val = f.val === undefined ? 0 : Number(f.val);
      switch (f.field) {
        case 1: e.secret = base32Encode(f.data || new Uint8Array()); break;
        case 2: e.account = fromUtf8(f.data || new Uint8Array()); break;
        case 3: e.issuer = fromUtf8(f.data || new Uint8Array()); break;
        case 4: e.algorithm = { 2: "SHA256", 3: "SHA512", 4: "MD5" }[val] || "SHA1"; break;
        case 5: if (val === 2) e.digits = 8; break;
        case 6: if (val === 1) e.kind = KIND_HOTP; break;
        case 7: e.counter = val; break;
      }
    }
    // Der Name ist oft "Dienst:Konto" wie im otpauth-Link
    const i = e.account.indexOf(":");
    if (i > 0) {
      const head = e.account.slice(0, i).trim();
      if (!e.issuer) e.issuer = head;
      if (head.toLowerCase() === e.issuer.toLowerCase()) e.account = e.account.slice(i + 1).trim();
    }
    return e;
  }

  function pushVarint(out, v) {
    v = BigInt(v);
    while (v >= 0x80n) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
  }
  const pushVarintField = (out, field, v) => { pushVarint(out, field << 3); pushVarint(out, v); };
  const pushBytes = (out, field, data) => { pushVarint(out, (field << 3) | 2); pushVarint(out, data.length); for (const x of data) out.push(x); };

  // Einträge im Exportformat von Google Authenticator (für den Export und die Tests)
  function buildMigration(list) {
    const payload = [];
    for (const e of list) {
      const key = base32Decode(e.secret);
      if (!key) continue;
      const m = [];
      pushBytes(m, 1, key);
      pushBytes(m, 2, utf8(e.account));
      pushBytes(m, 3, utf8(e.issuer));
      pushVarintField(m, 4, { SHA256: 2, SHA512: 3 }[e.algorithm] || 1);
      pushVarintField(m, 5, e.digits === 8 ? 2 : 1);
      let typ = 2;
      if (e.kind === KIND_HOTP) {
        typ = 1;
        pushVarintField(m, 7, e.counter || 0);
      }
      pushVarintField(m, 6, typ);
      pushBytes(payload, 1, m);
    }
    pushVarintField(payload, 2, 1);
    pushVarintField(payload, 3, 1);
    pushVarintField(payload, 4, 0);
    return "otpauth-migration://offline?data=" + encodeURIComponent(b64encode(Uint8Array.from(payload)));
  }

  // Google Authenticator kennt nur 6 oder 8 Stellen und 30 Sekunden, und höchstens 10 Konten pro Code
  function googleBatches(list) {
    const fit = list.filter((e) => e.kind !== KIND_STEAM && (e.digits === 6 || e.digits === 8) && !(e.kind === KIND_TOTP && e.period !== 30));
    if (!fit.length) throw uerr("e.googleNone", "h.googleNone");
    const out = [];
    for (let i = 0; i < fit.length; i += 10) out.push(buildMigration(fit.slice(i, i + 10)));
    return out;
  }

  /* ---------- Import ---------- */

  const FMT = {
    otpvault: "otp-vault backup", text: "otpauth links", secret: "secret", migration: "Google Authenticator",
    aegis: "Aegis", twofas: "2FAS", andotp: "andOTP", bitwarden: "Bitwarden", csv: "CSV",
  };
  const MAX_IMPORT = 20 << 20;

  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

  // Findet heraus, was der Text ist, und liefert {format, entries} (noch nicht normalisiert).
  // Verschlüsselte Dateien brauchen das Passwort, ohne kommt NeedPassword.
  async function parseImport(text, password) {
    text = String(text || "");
    if (text.length > MAX_IMPORT) throw uerr("e.importLarge", "h.importLarge");
    text = text.replace(/^﻿/, "");
    const trimmed = text.trim();
    if (!trimmed) throw uerr("e.importEmpty", "h.importEmpty");
    if (trimmed[0] === "{" || trimmed[0] === "[") return parseJSONImport(trimmed, password || "");
    return parseTextImport(trimmed);
  }

  async function parseJSONImport(text, password) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw uerr("e.jsonDamaged", "h.jsonDamaged");
    }
    if (Array.isArray(doc)) return parseJSONArray(doc);
    if (!doc || typeof doc !== "object") throw uerr("e.jsonUnknown", "h.jsonUnknown");
    if (str(doc.format).includes("otp-vault")) {
      if (!password) throw new NeedPassword(FMT.otpvault);
      const v = await openVault(text, password);
      wipe(v.key);
      return { format: FMT.otpvault, entries: v.data.entries };
    }
    if (has(doc, "db") && has(doc, "header")) return { format: FMT.aegis, entries: await parseAegis(doc, password) };
    if (has(doc, "services") || has(doc, "servicesEncrypted")) return { format: FMT.twofas, entries: await parse2FAS(doc, password) };
    if (has(doc, "items")) {
      if (doc.encrypted === true) throw uerr("e.bitwardenEncrypted", "h.bitwardenEncrypted");
      return { format: FMT.bitwarden, entries: parseBitwarden(doc.items) };
    }
    throw uerr("e.jsonUnknown", "h.jsonUnknown");
  }

  // andOTP (Objekte) oder eine Liste von otpauth-Links
  function parseJSONArray(arr) {
    const out = [];
    let format = FMT.andotp;
    for (const it of arr) {
      if (typeof it === "string") {
        out.push(parseOTPAuth(it));
        format = FMT.text;
        continue;
      }
      if (!it || typeof it !== "object" || !str(it.secret)) throw uerr("e.andotp", "h.andotp");
      const e = {
        kind: str(it.type).toLowerCase(), secret: str(it.secret), issuer: str(it.issuer), account: str(it.label),
        digits: intOr0(it.digits), algorithm: str(it.algorithm), period: intOr0(it.period), counter: intOr0(it.counter),
      };
      const i = e.account.indexOf(":");
      if (i > 0 && (!e.issuer || e.account.slice(0, i).toLowerCase() === e.issuer.toLowerCase())) {
        e.issuer = e.account.slice(0, i).trim();
        e.account = e.account.slice(i + 1).trim();
      }
      out.push(e);
    }
    return { format, entries: out };
  }

  async function aesGcmOpen(key, nonce, ct) {
    const k = await root.crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    return new Uint8Array(await root.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
  }

  const concat = (a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
  };

  const ICON_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
  const iconMimeOK = (m) => ICON_MIMES.includes(String(m || "").trim().toLowerCase());

  // "data:image/png;base64,AAAA" in Typ und Daten zerlegen, null = kein brauchbares Bild
  function splitDataURL(s) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(s || ""));
    if (!m || !iconMimeOK(m[1])) return null;
    return { mime: m[1], data: m[2] };
  }

  // Aegis, unverschlüsselt und mit Passwort (scrypt-Schlüsselplätze, AES-256-GCM)
  async function parseAegis(doc, password) {
    const damaged = () => uerr("e.aegisDamaged", "h.aegisDamaged");
    const h = doc.header || {};
    let db = doc.db;
    if (Array.isArray(h.slots) && h.slots.length && h.params) {
      if (!password) throw new NeedPassword(FMT.aegis);
      if (typeof db !== "string") throw damaged();
      const master = await aegisMasterKey(h.slots, password);
      const ct = b64decode(db), nonce = hexDecode(h.params.nonce), tag = hexDecode(h.params.tag);
      if (!ct || !nonce || !tag) throw damaged();
      let plain;
      try {
        plain = await aesGcmOpen(master, nonce, concat(ct, tag));
      } catch (e) {
        throw uerr("e.aegisDecrypt", "h.aegisDamaged");
      }
      try {
        db = JSON.parse(fromUtf8(plain));
      } catch (e) {
        throw damaged();
      }
    }
    if (!db || !Array.isArray(db.entries)) throw damaged();
    return db.entries.map((a) => {
      const info = a.info || {};
      const e = {
        kind: str(a.type).toLowerCase(), issuer: str(a.issuer), account: str(a.name), note: str(a.note), favorite: !!a.favorite,
        secret: str(info.secret), algorithm: str(info.algo), digits: intOr0(info.digits), period: intOr0(info.period), counter: intOr0(info.counter),
      };
      if (a.icon && iconMimeOK(a.icon_mime)) e.icon = "data:" + a.icon_mime + ";base64," + a.icon;
      return e;
    });
  }

  async function aegisMasterKey(slots, password) {
    for (const s of slots) {
      if (!s || s.type !== 1) continue;
      const salt = hexDecode(s.salt), key = hexDecode(s.key), kp = s.key_params || {};
      const nonce = hexDecode(kp.nonce), tag = hexDecode(kp.tag);
      const n = intOr0(s.n), r = intOr0(s.r), p = intOr0(s.p);
      if (!salt || !key || !nonce || !tag || n <= 1 || n > 1 << 22 || r <= 0 || p <= 0) continue;
      const derived = await root.OPNoble.scryptAsync(utf8(password), salt, { N: n, r, p, dkLen: 32, maxmem: 2 ** 31 });
      try {
        return await aesGcmOpen(derived, nonce, concat(key, tag));
      } catch (e) {
        /* nächster Platz */
      }
    }
    throw uerr("e.aegisPassword", "h.aegisPassword");
  }

  // 2FAS, unverschlüsselt oder mit Passwort (PBKDF2 SHA-256, 10000 Runden, AES-256-GCM; "Daten:Salz:IV" in Base64)
  async function parse2FAS(doc, password) {
    const damaged = () => uerr("e.twofasDamaged", "h.twofasDamaged");
    let services = doc.services;
    if (typeof doc.servicesEncrypted === "string" && doc.servicesEncrypted) {
      if (!password) throw new NeedPassword(FMT.twofas);
      const parts = doc.servicesEncrypted.split(":");
      if (parts.length !== 3) throw damaged();
      const ct = b64decode(parts[0]), salt = b64decode(parts[1]), iv = b64decode(parts[2]);
      if (!ct || !salt || !iv) throw damaged();
      const base = await root.crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
      const key = new Uint8Array(await root.crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 10000 }, base, 256));
      let plain;
      try {
        plain = await aesGcmOpen(key, iv, ct);
      } catch (e) {
        throw uerr("e.twofasPassword", "h.twofasPassword");
      }
      try {
        services = JSON.parse(fromUtf8(plain));
      } catch (e) {
        throw damaged();
      }
    }
    if (!Array.isArray(services)) throw damaged();
    return services.map((s) => {
      const o = s.otp || {};
      return {
        kind: str(o.tokenType).toLowerCase(), secret: str(s.secret), issuer: str(o.issuer) || str(s.name), account: str(o.account) || str(o.label),
        digits: intOr0(o.digits), period: intOr0(o.period), algorithm: str(o.algorithm), counter: intOr0(o.counter),
      };
    });
  }

  function parseBitwarden(items) {
    if (!Array.isArray(items)) throw uerr("e.bitwardenDamaged", "h.bitwardenDamaged");
    const out = [];
    for (const it of items) {
      const login = it && it.login;
      if (!login || !str(login.totp).trim()) continue;
      const site = Array.isArray(login.uris) && login.uris.length ? str(login.uris[0] && login.uris[0].uri) : "";
      const e = entryFromTOTPField(login.totp, it.name, login.username, site);
      e.favorite = !!it.favorite;
      out.push(e);
    }
    if (!out.length) throw uerr("e.bitwardenNone", "h.bitwardenNone");
    return out;
  }

  // Was Passwortmanager im TOTP-Feld haben: otpauth-Link, "steam://GEHEIM" oder das blanke Geheimnis
  function entryFromTOTPField(field, issuer, account, site) {
    field = str(field).trim();
    let e;
    if (/^otpauth:\/\//i.test(field)) e = parseOTPAuth(field);
    else if (/^steam:\/\//i.test(field)) e = { kind: KIND_STEAM, secret: field.slice(8) };
    else e = { secret: field };
    if (!e.issuer) e.issuer = str(issuer).trim();
    if (!e.account) e.account = str(account).trim();
    e.website = normalizeHost(site);
    return e;
  }

  const shorten = (s, n) => ([...s].length <= n ? s : [...s].slice(0, n).join("") + "...");

  // Text: otpauth-Links, Google-Export-Links, CSV oder ein einzelnes Geheimnis
  function parseTextImport(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const first = lines[0].trim().toLowerCase();
    if (text.includes(",") && !first.startsWith("otpauth") && csvHeader(first)) return { format: FMT.csv, entries: parseCSV(text) };
    const out = [];
    let format = FMT.text;
    for (let line of lines) {
      line = line.trim();
      const low = line.toLowerCase();
      if (!line || line.startsWith("#")) continue;
      if (low.startsWith("otpauth-migration://")) {
        out.push(...parseMigration(line));
        format = FMT.migration;
      } else if (low.startsWith("steam://") && lines.length === 1) {
        return { format: FMT.secret, entries: [{ kind: KIND_STEAM, issuer: "Steam", secret: line.slice(8) }] };
      } else if (low.startsWith("otpauth://")) {
        out.push(parseOTPAuth(line));
      } else if (!out.length && lines.length === 1) {
        let sec;
        try {
          sec = normalizeSecret(line);
        } catch (err) {
          throw uerr("e.notSecret", "h.notSecret");
        }
        return { format: FMT.secret, entries: [{ secret: sec }] };
      } else {
        throw uerr("e.badLine", "h.badLine", { line: shorten(line, 40) });
      }
    }
    if (!out.length) throw uerr("e.noAccount", "h.noAccount");
    return { format, entries: out };
  }

  const CSV_COLUMNS = {
    issuer: ["issuer", "service", "title", "name"],
    account: ["account", "username", "user", "login_username", "email", "label"],
    secret: ["secret", "totp", "login_totp", "otp", "key", "seed", "otpauth", "uri"],
    website: ["website", "url", "login_uri"],
    algorithm: ["algorithm", "algo"],
    digits: ["digits"],
    period: ["period"],
    type: ["type", "kind"],
    counter: ["counter"],
    note: ["note", "notes"],
  };

  function csvHeader(first) {
    const cells = first.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return CSV_COLUMNS.secret.some((n) => cells.includes(n));
  }

  // CSV nach RFC 4180, nachsichtig mit Anführungszeichen mitten im Feld (wie LazyQuotes in Go)
  function csvRows(text) {
    const rows = [];
    let row = [], field = "", i = 0, quoted = false, started = false;
    const endField = () => { row.push(field); field = ""; started = false; };
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"' && !started) { quoted = true; started = true; i++; continue; }
      if (c === ",") { endField(); i++; continue; }
      if (c === "\r" && text[i + 1] === "\n") { i++; continue; }
      if (c === "\n") { endField(); rows.push(row); row = []; i++; continue; }
      field += c;
      started = true;
      i++;
    }
    if (field !== "" || row.length) { endField(); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }

  // CSV mit Kopfzeile: Export von otp-vault, Bitwarden, KeePassXC und den meisten Tabellen. Zeilen ohne Geheimnis fallen weg.
  function parseCSV(text) {
    const rows = csvRows(text);
    if (rows.length < 2) throw uerr("e.csvRead", "h.csvRead");
    const col = {}, rank = {};
    rows[0].forEach((h, i) => {
      h = h.trim().toLowerCase();
      for (const [field, names] of Object.entries(CSV_COLUMNS)) {
        const r = names.indexOf(h);
        if (r >= 0 && (!(field in rank) || r < rank[field])) {
          col[field] = i;
          rank[field] = r;
        }
      }
    });
    if (!("secret" in col)) throw uerr("e.csvNoSecret", "h.csvNoSecret");
    const get = (row, f) => (f in col && col[f] < row.length ? row[col[f]].trim() : "");
    const out = [];
    for (const row of rows.slice(1)) {
      const field = get(row, "secret");
      if (!field) continue;
      const e = entryFromTOTPField(field, get(row, "issuer"), get(row, "account"), get(row, "website"));
      if (!/^otpauth:\/\//i.test(field)) {
        const t = get(row, "type").toLowerCase();
        if ([KIND_TOTP, KIND_HOTP, KIND_STEAM].includes(t)) e.kind = t;
        e.algorithm = get(row, "algorithm");
        e.digits = intOr0(get(row, "digits"));
        e.period = intOr0(get(row, "period"));
        e.counter = intOr0(get(row, "counter"));
      }
      e.note = get(row, "note");
      out.push(e);
    }
    if (!out.length) throw uerr("e.csvNoRows", "h.csvNoRows");
    return out;
  }

  /* ---------- Export ---------- */

  function exportURIList(list) {
    return list.map((e) => buildOTPAuth(e) + "\r\n").join("");
  }

  function csvField(s) {
    s = String(s);
    if (s === "") return s;
    if (/[",\r\n]/.test(s) || /^\s/.test(s) || s === "\\.") return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCSV(list) {
    const rows = [["issuer", "account", "secret", "type", "algorithm", "digits", "period", "counter", "website", "note", "otpauth"]];
    for (const e of list) {
      rows.push([e.issuer, e.account, e.secret, e.kind, e.algorithm, e.digits, e.period, e.counter || 0, e.website || "", e.note || "", buildOTPAuth(e)]);
    }
    return rows.map((r) => r.map(csvField).join(",") + "\r\n").join("");
  }

  // Unverschlüsselter Aegis-Export (Datenbank Version 2), lesen Aegis, 2FAS, Ente Auth und andere
  function exportAegis(list) {
    const entries = list.map((e) => {
      const info = { secret: e.secret, algo: e.algorithm, digits: e.digits, period: e.period };
      if (e.counter) info.counter = e.counter;
      const icon = splitDataURL(e.icon);
      return {
        type: e.kind, uuid: uuid4(), name: e.account, issuer: e.issuer, note: e.note || "", favorite: !!e.favorite,
        icon: icon ? icon.data : null, icon_mime: icon ? icon.mime : null, info,
      };
    });
    return JSON.stringify({ db: { entries, groups: [], version: 2 }, header: { params: null, slots: null }, version: 1 }, null, 4);
  }

  /* ---------- Das Vault-Format von otp-vault ----------
     {"format":"otp-vault","version":1,
      "kdf":{"name":"argon2id","time":3,"memory":65536,"threads":4,"salt":"..."},
      "cipher":"xchacha20poly1305","nonce":"...","data":"..."}
     Schlüssel aus dem Passwort mit Argon2id, der Kopf ist als zusätzliche Daten an den verschlüsselten Block gebunden. */

  const VAULT_FORMAT = "otp-vault", VAULT_VERSION = 1, CIPHER = "xchacha20poly1305", KDF_NAME = "argon2id";
  const MIN_PASSWORD = 8;
  // Mehr Speicher lässt sich auf dem Handy nicht verlangen, otp-vault nimmt 64 MiB
  const MAX_KDF_MEMORY = 256 * 1024;
  const DEFAULT_KDF = { name: KDF_NAME, time: 3, memory: 64 * 1024, threads: 4 };

  async function argon2id(password, salt, p) {
    if (root.hashwasm && root.hashwasm.argon2id) {
      try {
        return await root.hashwasm.argon2id({
          password, salt, parallelism: p.threads, iterations: p.time, memorySize: p.memory, hashLength: 32, outputType: "binary",
        });
      } catch (e) {
        /* WebAssembly gesperrt oder zu wenig Speicher: langsamer, aber gleiches Ergebnis */
      }
    }
    if (!root.OPNoble) throw new Error("argon2 missing");
    return root.OPNoble.argon2idAsync(password, salt, { t: p.time, m: p.memory, p: p.threads, dkLen: 32 });
  }

  function kdfOK(p) {
    return p && p.name === KDF_NAME && p.time >= 1 && p.time <= 64 && p.threads >= 1 && p.threads <= 255 &&
      p.memory >= 8 * 1024 && p.memory <= MAX_KDF_MEMORY && Number.isInteger(p.time) && Number.isInteger(p.memory) && Number.isInteger(p.threads);
  }

  async function deriveKey(password, p) {
    if (!kdfOK(p)) throw uerr("e.kdfUnknown", "h.kdfUnknown");
    const salt = b64decode(p.salt);
    if (!salt || salt.length < 8) throw uerr("e.salt", "h.useBackup");
    const key = await argon2id(password, salt, p);
    return { kdf: { name: p.name, time: p.time, memory: p.memory, threads: p.threads, salt: p.salt }, key: new Uint8Array(key) };
  }

  async function newSealKey(password) {
    if ([...String(password || "")].length < MIN_PASSWORD) throw uerr("e.pwShort", "h.pwShort", { n: MIN_PASSWORD });
    return deriveKey(password, Object.assign({}, DEFAULT_KDF, { salt: b64encode(randomBytes(16)) }));
  }

  const additionalData = (p) => utf8([VAULT_FORMAT, VAULT_VERSION, CIPHER, p.name, p.time, p.memory, p.threads, p.salt].join("/"));

  // Verschlüsselt {entries, saved} und liefert den Dateiinhalt
  function seal(k, data) {
    if (!k || !k.key || k.key.length !== 32) throw new Error("vault is locked");
    const plain = utf8(JSON.stringify({ entries: data.entries.map(cleanEntry), saved: intOr0(data.saved) }));
    const nonce = randomBytes(24);
    const ct = root.OPNoble.xchacha20poly1305(k.key, nonce, additionalData(k.kdf)).encrypt(plain);
    wipe(plain);
    return JSON.stringify({
      format: VAULT_FORMAT, version: VAULT_VERSION,
      kdf: { name: k.kdf.name, time: k.kdf.time, memory: k.kdf.memory, threads: k.kdf.threads, salt: k.kdf.salt },
      cipher: CIPHER, nonce: b64encode(nonce), data: b64encode(ct),
    }, null, 2);
  }

  // Prüft den lesbaren Kopf eines Vaults oder einer Sicherung
  function readSealed(raw) {
    let f;
    try {
      f = JSON.parse(String(raw || "").replace(/^﻿/, ""));
    } catch (e) {
      f = null;
    }
    if (!f || f.format !== VAULT_FORMAT) throw uerr("e.notVault", "h.notVault");
    if (f.version !== VAULT_VERSION || f.cipher !== CIPHER) throw uerr("e.vaultVersion", "h.vaultVersion", { v: f.version });
    return f;
  }

  function openWithKey(f, k) {
    const nonce = b64decode(f.nonce), data = b64decode(f.data);
    if (!nonce || !data) throw uerr("e.fileDamaged", "h.useBackup");
    if (nonce.length !== 24) throw uerr("e.nonce", "h.useBackup");
    let plain;
    try {
      plain = root.OPNoble.xchacha20poly1305(k.key, nonce, additionalData(f.kdf)).decrypt(data);
    } catch (e) {
      throw uerr("e.wrongPw", "h.wrongPw");
    }
    let v;
    try {
      v = JSON.parse(fromUtf8(plain));
    } catch (e) {
      throw uerr("e.contentDamaged", "h.useBackup");
    } finally {
      wipe(plain);
    }
    if (!v || typeof v !== "object") throw uerr("e.contentDamaged", "h.useBackup");
    return { entries: Array.isArray(v.entries) ? v.entries : [], saved: intOr0(v.saved) };
  }

  // Öffnet Vault oder Sicherung mit dem Passwort und liefert den Schlüssel mit, damit ohne Passwort weiter gespeichert werden kann
  async function openVault(raw, password) {
    const f = readSealed(raw);
    const k = await deriveKey(password, f.kdf || {});
    try {
      return { data: openWithKey(f, k), key: k.key, kdf: k.kdf };
    } catch (e) {
      wipe(k.key);
      throw e;
    }
  }

  // Gleicher Schlüssel? (für Passwort ändern und Face ID). Ohne frühen Abbruch verglichen.
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  /* ---------- Hilfen für die Liste ---------- */

  function sortEntries(list) {
    return list.slice().sort((a, b) => {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
      const ai = a.issuer.toLowerCase(), bi = b.issuer.toLowerCase();
      if (ai !== bi) return ai < bi ? -1 : 1;
      const aa = a.account.toLowerCase(), ba = b.account.toLowerCase();
      return aa < ba ? -1 : aa > ba ? 1 : 0;
    });
  }

  const duplicateOf = (list, e) => list.find((x) => x.secret === e.secret && x.kind === e.kind) || null;

  function label(e) {
    if (e.issuer && e.account) return e.issuer + " (" + e.account + ")";
    return e.issuer || e.account;
  }

  function entryDetails(e) {
    if (e.kind === KIND_HOTP) return "HOTP · " + e.algorithm + " · " + e.digits + " · counter " + (e.counter || 0);
    if (e.kind === KIND_STEAM) return "Steam · 30 s";
    return "TOTP · " + e.algorithm + " · " + e.digits + " · " + e.period + " s";
  }

  /* ---------- QR-Codes ---------- */

  function qrMatrix(text) {
    if (typeof root.qrcode !== "function") throw new Error("qrcode missing");
    const q = root.qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    return { size: n, dark: (x, y) => q.isDark(y, x) };
  }

  // QR-Code als SVG-Data-URL für die Seite
  function qrSVG(text) {
    const code = qrMatrix(text);
    const quiet = 4, n = code.size + 2 * quiet;
    let d = "";
    for (let y = 0; y < code.size; y++) {
      for (let x = 0; x < code.size;) {
        if (!code.dark(x, y)) { x++; continue; }
        const start = x;
        while (x < code.size && code.dark(x, y)) x++;
        d += "M" + (start + quiet) + " " + (y + quiet) + "h" + (x - start) + "v1h-" + (x - start) + "z";
      }
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n + '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
    return "data:image/svg+xml;base64," + b64encode(utf8(svg));
  }

  /* ---------- PDF-Notfallblatt (A4, sechs Karten pro Seite, wie in otp-vault) ---------- */

  const A4W = 595.28, A4H = 841.89, MARGIN = 36, COLS = 2, ROWS = 3, GAP = 12, HEADER = 54, FOOTER = 34, QR = 128;

  const f2 = (n) => n.toFixed(2), f3 = (n) => n.toFixed(3), f1 = (n) => n.toFixed(1);

  // Text in Windows-1252 für einen PDF-String, Zeichen außerhalb werden zu "?"
  function winAnsi(s) {
    const extra = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "™": 0x99 };
    let out = "";
    for (const ch of String(s)) {
      const r = ch.codePointAt(0);
      let c;
      if (ch === "(" || ch === ")" || ch === "\\") { out += "\\"; c = r; }
      else if (r >= 0x20 && r < 0x7f) c = r;
      else if (r >= 0xa0 && r <= 0xff) c = r;
      else c = extra[ch] || 63;
      out += c >= 0x80 ? "\\" + c.toString(8).padStart(3, "0") : String.fromCharCode(c);
    }
    return out;
  }

  function fit(s, width, size, avg) {
    const max = Math.floor(width / (size * avg));
    const r = [...String(s)];
    if (r.length <= max || max < 4) return s;
    return r.slice(0, max - 1).join("") + "…";
  }

  function groupSecret(s) {
    const parts = s.match(/.{1,4}/g) || [];
    const lines = [];
    for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(" "));
    return lines;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // texts: title, subtitle, account, warning, page ("Seite {i} von {n}")
  function buildPDF(list, texts, now) {
    now = now || new Date();
    const perPage = COLS * ROWS;
    const pageCount = Math.max(1, Math.ceil(list.length / perPage));
    const cardW = (A4W - 2 * MARGIN - GAP * (COLS - 1)) / COLS;
    const cardH = (A4H - 2 * MARGIN - HEADER - FOOTER - GAP * (ROWS - 1)) / ROWS;
    const date = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes());
    const pages = [];
    for (let pi = 0; pi < pageCount; pi++) {
      let c = "";
      const text = (font, size, x, y, gray, s) => { c += "BT /" + font + " " + f1(size) + " Tf " + f3(gray) + " g " + f2(x) + " " + f2(y) + " Td (" + winAnsi(s) + ") Tj ET\n"; };
      const centered = (font, size, cx, y, gray, s, avg) => text(font, size, cx - [...String(s)].length * size * avg / 2, y, gray, s);
      const top = A4H - MARGIN;
      text("F2", 16, MARGIN, top - 16, 0.1, texts.title);
      text("F1", 9, MARGIN, top - 31, 0.35, texts.subtitle);
      text("F1", 9, A4W - MARGIN - date.length * 9 * 0.52, top - 16, 0.35, date);
      for (let i = 0; i < perPage; i++) {
        const e = list[pi * perPage + i];
        if (!e) break;
        const col = i % COLS, row = Math.floor(i / COLS);
        const x = MARGIN + col * (cardW + GAP);
        const y = top - HEADER - row * (cardH + GAP);
        c += f3(0.75) + " G 0.8 w " + f2(x) + " " + f2(y - cardH) + " " + f2(cardW) + " " + f2(cardH) + " re S\n";
        const cx = x + cardW / 2;
        const q = qrMatrix(buildOTPAuth(e));
        const cell = QR / q.size, qx = cx - QR / 2, qtop = y - 12;
        c += "0 g\n";
        for (let r = 0; r < q.size; r++) {
          for (let k = 0; k < q.size;) {
            if (!q.dark(k, r)) { k++; continue; }
            const start = k;
            while (k < q.size && q.dark(k, r)) k++;
            c += f3(qx + start * cell) + " " + f3(qtop - (r + 1) * cell - 0.05) + " " + f3((k - start) * cell) + " " + f3(cell + 0.1) + " re\n";
          }
        }
        c += "f\n";
        let ty = y - 12 - QR - 18;
        const issuer = e.issuer || e.account;
        centered("F2", 12, cx, ty, 0.1, fit(issuer, cardW - 16, 12, 0.56), 0.56);
        ty -= 14;
        if (e.account && e.account !== issuer) centered("F1", 9.5, cx, ty, 0.2, fit(texts.account + ": " + e.account, cardW - 16, 9.5, 0.52), 0.52);
        ty -= 14;
        for (const line of groupSecret(e.secret)) {
          centered("F3", 8.5, cx, ty, 0.1, line, 0.6);
          ty -= 10.5;
        }
        centered("F1", 7.5, cx, ty - 2, 0.4, entryDetails(e), 0.5);
      }
      text("F1", 8, MARGIN, MARGIN + 6, 0.35, texts.warning);
      const pg = String(texts.page || "{i} / {n}").replace("{i}", pi + 1).replace("{n}", pageCount);
      text("F1", 8, A4W - MARGIN - pg.length * 8 * 0.52, MARGIN + 6, 0.35, pg);
      pages.push(c);
    }
    return writePDF(pages, texts.title, now);
  }

  function writePDF(pages, title, now) {
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = [];
    const obj = (body) => {
      offsets.push(out.length);
      out += offsets.length + " 0 obj\n" + body + "\nendobj\n";
    };
    const first = 7;
    const kids = pages.map((p, i) => (first + 2 * i) + " 0 R").join(" ");
    const d = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    obj("<< /Type /Catalog /Pages 2 0 R >>");
    obj("<< /Type /Pages /Kids [" + kids + "] /Count " + pages.length + " >>");
    obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    obj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
    obj("<< /Title (" + winAnsi(title) + ") /Producer (OTP-PWA) /CreationDate (D:" + d + "Z) >>");
    pages.forEach((p, i) => {
      obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f2(A4W) + " " + f2(A4H) + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents " + (first + 2 * i + 1) + " 0 R >>");
      obj("<< /Length " + p.length + " >>\nstream\n" + p + "endstream");
    });
    const xref = out.length;
    out += "xref\n0 " + (offsets.length + 1) + "\n0000000000 65535 f \n";
    for (const o of offsets) out += String(o).padStart(10, "0") + " 00000 n \n";
    out += "trailer\n<< /Size " + (offsets.length + 1) + " /Root 1 0 R /Info 6 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }

  root.OPCore = {
    UserError, NeedPassword, FMT, MIN_PASSWORD,
    utf8, fromUtf8, b64encode, b64decode, hexEncode, hexDecode, base32Encode, base32Decode, randomBytes, wipe, newID, uuid4,
    normalizeSecret, normalizeEntry, cleanEntry, hotpValue, formatCode, codeView, forget,
    parseOTPAuth, buildOTPAuth, normalizeHost, iconHosts, parseMigration, buildMigration, googleBatches,
    parseImport, splitDataURL, iconMimeOK, exportURIList, exportCSV, exportAegis,
    newSealKey, deriveKey, seal, readSealed, openWithKey, openVault, sameBytes, kdfOK,
    sortEntries, duplicateOf, label, entryDetails, qrMatrix, qrSVG, buildPDF, csvRows,
  };
})(typeof window !== "undefined" ? window : globalThis);
