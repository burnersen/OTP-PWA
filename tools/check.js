/* OTP-PWA – Prüfungen ohne Browser: node tools/check.js
   Rechnet Codes gegen die Testwerte aus den RFCs, liest und schreibt alle Import- und Exportformate,
   öffnet einen Tresor, den otp-vault (Go) geschrieben hat, und prüft, dass beide Sprachen dieselben Texte haben.
   Mit GOCOMPAT=<Programm> wird zusätzlich ein hier geschriebener Tresor von Go gelesen (siehe tools/gocompat/main.go). */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const A = path.join(ROOT, "app", "assets");
for (const f of ["argon2.js", "noble.js", "qrcode.js", "core.js", "i18n.js", "app.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(A, f), "utf8"), { filename: f });
}
const C = globalThis.OPCore;
const APP = globalThis.OPApp;
const TEXTS = globalThis.OP_TEXTS;

let failed = 0, passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const ascii = (s) => C.base32Encode(Buffer.from(s, "ascii"));

/* ---------- Codes ---------- */

test("HOTP RFC 4226", async () => {
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  const secret = ascii("12345678901234567890");
  for (let i = 0; i < want.length; i++) {
    assert.strictEqual(C.formatCode(await C.hotpValue(secret, i, "SHA1"), 6, "hotp"), want[i]);
  }
});

test("TOTP RFC 6238 (SHA1, SHA256, SHA512)", async () => {
  const keys = {
    SHA1: ascii("12345678901234567890"),
    SHA256: ascii("12345678901234567890123456789012"),
    SHA512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
  };
  const rows = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [secs, s1, s256, s512] of rows) {
    for (const [alg, want] of [["SHA1", s1], ["SHA256", s256], ["SHA512", s512]]) {
      const e = C.normalizeEntry({ issuer: "x", secret: keys[alg], algorithm: alg, digits: 8 });
      e.id = "t";
      const v = await C.codeView(e, secs * 1000);
      assert.strictEqual(v.current, want, alg + " at " + secs);
    }
  }
});

test("Steam-Codes: 5 Zeichen aus dem Steam-Alphabet", async () => {
  const e = C.normalizeEntry({ kind: "steam", issuer: "Steam", secret: "JBSWY3DPEHPK3PXP" });
  assert.strictEqual(e.digits, 5);
  const v = await C.codeView(Object.assign(e, { id: "s" }), 1700000000000);
  assert.match(v.current, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  assert.ok(v.remaining > 0 && v.remaining <= 30);
});

test("Schlüssel normalisieren", () => {
  assert.strictEqual(C.normalizeSecret("jbsw y3dp-ehpk 3pxp=="), "JBSWY3DPEHPK3PXP");
  assert.throws(() => C.normalizeSecret("ABC1"), (e) => e.msg === "e.secretChar");
  assert.throws(() => C.normalizeSecret("   "), (e) => e.msg === "e.secretEmpty");
  assert.throws(() => C.normalizeSecret("A"), (e) => e.msg === "e.secretBase32");
  assert.throws(() => C.normalizeEntry({ secret: "JBSWY3DPEHPK3PXP" }), (e) => e.msg === "e.noName");
  assert.throws(() => C.normalizeEntry({ issuer: "x", secret: "JBSWY3DPEHPK3PXP", algorithm: "MD5" }), (e) => e.msg === "e.algorithm");
  assert.throws(() => C.normalizeEntry({ issuer: "x", secret: "JBSWY3DPEHPK3PXP", period: 2 }), (e) => e.msg === "e.period");
});

test("Base32 in beide Richtungen", () => {
  for (let n = 1; n < 40; n++) {
    const b = C.randomBytes(n);
    assert.deepStrictEqual(Buffer.from(C.base32Decode(C.base32Encode(b))), Buffer.from(b));
  }
});

/* ---------- otpauth und Google ---------- */

test("otpauth-Link lesen und schreiben wie otp-vault", () => {
  const e = C.normalizeEntry(C.parseOTPAuth("otpauth://totp/GitHub:ich@example.org?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"));
  assert.strictEqual(e.issuer, "GitHub");
  assert.strictEqual(e.account, "ich@example.org");
  assert.strictEqual(C.buildOTPAuth(e), "otpauth://totp/GitHub:ich@example.org?algorithm=SHA1&digits=6&issuer=GitHub&period=30&secret=JBSWY3DPEHPK3PXP");
  const sp = C.normalizeEntry(C.parseOTPAuth("otpauth://totp/Meine%20Bank:Herr%20M%C3%BCller?secret=GEZDGNBVGY3TQOJQ&issuer=Meine+Bank&digits=8&algorithm=SHA256"));
  assert.strictEqual(sp.issuer, "Meine Bank");
  assert.strictEqual(sp.account, "Herr Müller");
  assert.strictEqual(sp.digits, 8);
  assert.strictEqual(C.buildOTPAuth(sp), "otpauth://totp/Meine%20Bank:Herr%20M%C3%BCller?algorithm=SHA256&digits=8&issuer=Meine%20Bank&period=30&secret=GEZDGNBVGY3TQOJQ");
  const steam = C.normalizeEntry(C.parseOTPAuth("otpauth://totp/Steam:gamer?secret=MFRGGZDFMZTWQ2LK&issuer=Steam&encoder=steam"));
  assert.strictEqual(steam.kind, "steam");
  assert.ok(C.buildOTPAuth(steam).includes("encoder=steam"));
  const h = C.normalizeEntry(C.parseOTPAuth("otpauth://hotp/Bank?secret=GEZDGNBVGY3TQOJQ&counter=7"));
  assert.strictEqual(h.kind, "hotp");
  assert.strictEqual(h.counter, 7);
  assert.throws(() => C.parseOTPAuth("otpauth://totp/x?issuer=y"), (e) => e.msg === "e.linkNoSecret");
  assert.throws(() => C.parseOTPAuth("https://example.org"), (e) => e.msg === "e.notOtpauth");
});

test("Google-Authenticator-Export hin und zurück", () => {
  const list = [
    C.normalizeEntry({ issuer: "GitHub", account: "ich", secret: "JBSWY3DPEHPK3PXP" }),
    C.normalizeEntry({ kind: "hotp", issuer: "Bank", account: "Müller", secret: "GEZDGNBVGY3TQOJQ", algorithm: "SHA256", digits: 8, counter: 300 }),
  ];
  const link = C.buildMigration(list);
  const back = C.parseMigration(link).map((e) => C.normalizeEntry(e));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].secret, "JBSWY3DPEHPK3PXP");
  assert.strictEqual(back[1].account, "Müller");
  assert.strictEqual(back[1].counter, 300);
  assert.strictEqual(back[1].algorithm, "SHA256");
  assert.strictEqual(back[1].digits, 8);
  const many = Array.from({ length: 23 }, (_, i) => C.normalizeEntry({ issuer: "S" + i, secret: C.base32Encode(C.randomBytes(10)) }));
  assert.strictEqual(C.googleBatches(many).length, 3);
});

test("Webseite fürs Icon erraten", () => {
  assert.deepStrictEqual(C.iconHosts({ issuer: "GitHub", account: "ich@gmail.com" }), ["github.com"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "Firma", account: "max@firma.de" }), ["firma.de"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "", account: "max@meine-firma.de" }), ["meine-firma.de"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "Sparkasse", account: "Max" }), ["sparkasse.de"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "firma.de" }), ["firma.de"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "Meine Bank" }), ["meinebank.de", "meinebank.com"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "Example", website: "https://Login.Example.org/x" }), ["login.example.org"]);
  assert.deepStrictEqual(C.iconHosts({ issuer: "?" }), []);
});

/* ---------- Import ---------- */

test("Text, Schlüssel und CSV importieren", async () => {
  let r = await C.parseImport("jbsw y3dp ehpk 3pxp", "");
  assert.strictEqual(r.format, C.FMT.secret);
  r = await C.parseImport("otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP\n# Kommentar\notpauth://totp/B:b?secret=GEZDGNBVGY3TQOJQ\n", "");
  assert.strictEqual(r.entries.length, 2);
  const csv = 'issuer,account,secret,type,algorithm,digits,period,counter,website,note,otpauth\r\n"Firma, GmbH",ich,JBSWY3DPEHPK3PXP,totp,SHA1,6,30,0,firma.de,"Notiz mit ""Zitat""",\r\n';
  r = await C.parseImport(csv, "");
  assert.strictEqual(r.format, C.FMT.csv);
  assert.strictEqual(r.entries[0].issuer, "Firma, GmbH");
  assert.strictEqual(r.entries[0].note, 'Notiz mit "Zitat"');
  await assert.rejects(C.parseImport("kein link\nzweite zeile", ""), (e) => e.msg === "e.badLine");
});

test("CSV-Export wird wieder gelesen", async () => {
  const list = [C.normalizeEntry({ issuer: "A, B", account: "x", secret: "JBSWY3DPEHPK3PXP", note: 'Zeile\n"zwei"' })];
  const r = await C.parseImport(C.exportCSV(list), "");
  assert.strictEqual(r.entries[0].issuer, "A, B");
  assert.strictEqual(r.entries[0].note, 'Zeile\n"zwei"');
});

test("Aegis unverschlüsselt (auch der eigene Export)", async () => {
  const list = [
    C.normalizeEntry({ issuer: "GitHub", account: "ich", secret: "JBSWY3DPEHPK3PXP", favorite: true, icon: "data:image/png;base64,iVBORw0KGgo=" }),
    C.normalizeEntry({ kind: "hotp", issuer: "Bank", account: "b", secret: "GEZDGNBVGY3TQOJQ", counter: 5 }),
  ];
  const r = await C.parseImport(C.exportAegis(list), "");
  assert.strictEqual(r.format, C.FMT.aegis);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].favorite, true);
  assert.strictEqual(r.entries[0].icon, "data:image/png;base64,iVBORw0KGgo=");
  assert.strictEqual(r.entries[1].counter, 5);
});

async function gcmSeal(key, nonce, plain) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, plain));
}

test("Aegis verschlüsselt (scrypt, AES-GCM)", async () => {
  const pw = "aegis-passwort";
  const master = C.randomBytes(32), salt = C.randomBytes(32), knonce = C.randomBytes(12), dnonce = C.randomBytes(12);
  const derived = await OPNoble.scryptAsync(C.utf8(pw), salt, { N: 1024, r: 8, p: 1, dkLen: 32 });
  const keyCt = await gcmSeal(derived, knonce, master);
  const db = { version: 2, entries: [{ type: "totp", name: "ich", issuer: "Aegis-Test", note: "", favorite: false, info: { secret: "JBSWY3DPEHPK3PXP", algo: "SHA1", digits: 6, period: 30 } }] };
  const dbCt = await gcmSeal(master, dnonce, C.utf8(JSON.stringify(db)));
  const doc = {
    version: 1,
    header: {
      slots: [{ type: 1, uuid: "x", key: C.hexEncode(keyCt.subarray(0, 32)), key_params: { nonce: C.hexEncode(knonce), tag: C.hexEncode(keyCt.subarray(32)) }, n: 1024, r: 8, p: 1, salt: C.hexEncode(salt) }],
      params: { nonce: C.hexEncode(dnonce), tag: C.hexEncode(dbCt.subarray(dbCt.length - 16)) },
    },
    db: C.b64encode(dbCt.subarray(0, dbCt.length - 16)),
  };
  const text = JSON.stringify(doc);
  await assert.rejects(C.parseImport(text, ""), (e) => e.name === "NeedPassword" && e.format === "Aegis");
  await assert.rejects(C.parseImport(text, "falsch"), (e) => e.msg === "e.aegisPassword");
  const r = await C.parseImport(text, pw);
  assert.strictEqual(r.entries[0].issuer, "Aegis-Test");
});

test("2FAS verschlüsselt (PBKDF2, AES-GCM)", async () => {
  const pw = "2fas-passwort";
  const salt = C.randomBytes(16), iv = C.randomBytes(12);
  const base = await crypto.subtle.importKey("raw", C.utf8(pw), "PBKDF2", false, ["deriveBits"]);
  const key = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 10000 }, base, 256));
  const services = [{ name: "Dienst", secret: "JBSWY3DPEHPK3PXP", otp: { account: "ich", digits: 6, period: 30, algorithm: "SHA1", tokenType: "TOTP" } }];
  const ct = await gcmSeal(key, iv, C.utf8(JSON.stringify(services)));
  const text = JSON.stringify({ services: [], servicesEncrypted: C.b64encode(ct) + ":" + C.b64encode(salt) + ":" + C.b64encode(iv), schemaVersion: 4 });
  await assert.rejects(C.parseImport(text, ""), (e) => e.name === "NeedPassword");
  await assert.rejects(C.parseImport(text, "falsch"), (e) => e.msg === "e.twofasPassword");
  const r = await C.parseImport(text, pw);
  assert.strictEqual(r.entries[0].issuer, "Dienst");
  assert.strictEqual(r.entries[0].account, "ich");
});

test("Bitwarden und andOTP", async () => {
  let r = await C.parseImport(JSON.stringify({ encrypted: false, items: [
    { name: "GitHub", favorite: true, login: { username: "ich", totp: "JBSWY3DPEHPK3PXP", uris: [{ uri: "https://github.com/login" }] } },
    { name: "ohne", login: { username: "x", totp: "" } },
    { name: "Steam", login: { username: "g", totp: "steam://MFRGGZDFMZTWQ2LK" } },
  ] }), "");
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].website, "github.com");
  assert.strictEqual(r.entries[1].kind, "steam");
  await assert.rejects(C.parseImport(JSON.stringify({ encrypted: true, items: [] }), ""), (e) => e.msg === "e.bitwardenEncrypted");
  r = await C.parseImport(JSON.stringify([{ secret: "JBSWY3DPEHPK3PXP", label: "GitLab:ich", issuer: "", type: "TOTP", digits: 6, period: 30, algorithm: "SHA1" }]), "");
  assert.strictEqual(r.format, C.FMT.andotp);
  assert.strictEqual(r.entries[0].issuer, "GitLab");
  assert.strictEqual(r.entries[0].account, "ich");
});

/* ---------- Tresor ---------- */

test("Tresor von otp-vault (Go) öffnen", async () => {
  const raw = fs.readFileSync(path.join(__dirname, "fixtures", "otp-vault-go.otpv"), "utf8");
  await assert.rejects(C.openVault(raw, "falsches passwort"), (e) => e.msg === "e.wrongPw");
  const v = await C.openVault(raw, "correct horse battery");
  const list = v.data.entries;
  assert.strictEqual(list.length, 3);
  assert.strictEqual(v.data.saved, 99);
  assert.strictEqual(list[0].issuer, "GitHub");
  assert.strictEqual(list[0].favorite, true);
  assert.strictEqual(list[1].note, "Ä Ö Ü ß");
  assert.strictEqual(list[1].counter, 7);
  assert.strictEqual(list[2].kind, "steam");
  assert.ok(list[2].icon.startsWith("data:image/png"));
  // Mit dem Schlüssel wieder versiegeln und erneut öffnen
  const again = C.seal({ key: v.key, kdf: v.kdf }, v.data);
  const v2 = await C.openVault(again, "correct horse battery");
  assert.deepStrictEqual(v2.data.entries.map(C.cleanEntry), list.map(C.cleanEntry));
  if (process.env.GOCOMPAT) {
    const tmp = path.join(require("os").tmpdir(), "otp-pwa-js.otpv");
    const fresh = await C.newSealKey("noch ein passwort");
    fs.writeFileSync(tmp, C.seal(fresh, { entries: list, saved: 123 }));
    const out = JSON.parse(execFileSync(process.env.GOCOMPAT, ["read", tmp, "noch ein passwort"]).toString());
    fs.unlinkSync(tmp);
    assert.strictEqual(out.entries.length, 3);
    assert.strictEqual(out.entries[1].note, "Ä Ö Ü ß");
    assert.strictEqual(out.saved, 123);
    console.log("    (Go hat den hier geschriebenen Tresor gelesen)");
  }
});

test("Kopf des Tresors ist gebunden (Änderung bricht das Siegel)", async () => {
  const k = await C.newSealKey("ein langes passwort");
  const raw = C.seal(k, { entries: [], saved: 1 });
  const f = JSON.parse(raw);
  f.kdf.time = 2;
  await assert.rejects(C.openVault(JSON.stringify(f), "ein langes passwort"), (e) => e.msg === "e.wrongPw");
  await assert.rejects(C.newSealKey("kurz"), (e) => e.msg === "e.pwShort");
  assert.throws(() => C.readSealed('{"format":"anders"}'), (e) => e.msg === "e.notVault");
  const big = JSON.parse(raw);
  big.kdf.memory = 4 * 1024 * 1024;
  await assert.rejects(C.openVault(JSON.stringify(big), "ein langes passwort"), (e) => e.msg === "e.kdfUnknown");
});

test("Sicherung ist auch ein Import", async () => {
  const k = await C.newSealKey("sicherungs-passwort");
  const raw = C.seal(k, { entries: [C.normalizeEntry({ issuer: "X", secret: "JBSWY3DPEHPK3PXP" })], saved: 5 });
  await assert.rejects(C.parseImport(raw, ""), (e) => e.name === "NeedPassword");
  const r = await C.parseImport(raw, "sicherungs-passwort");
  assert.strictEqual(r.format, C.FMT.otpvault);
  assert.strictEqual(r.entries[0].issuer, "X");
});

/* ---------- PDF und QR ---------- */

test("PDF-Notfallblatt ist ein gültiges PDF", () => {
  const list = Array.from({ length: 8 }, (_, i) => C.normalizeEntry({ issuer: "Dienst Ä€ " + i, account: "name" + i + "@example.org", secret: C.base32Encode(C.randomBytes(20)) }));
  const pdf = C.buildPDF(list, { title: "Notfallblatt", subtitle: "Test", account: "Nutzer", warning: "Sicher aufbewahren", page: "Seite {i} von {n}" }, new Date(2026, 0, 2, 3, 4));
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.ok(text.includes("/Count 2"));
  assert.ok(text.includes("(Seite 2 von 2)"));
  // Jeder Eintrag in der xref-Tabelle zeigt auf "<n> 0 obj"
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  const lines = text.slice(xref).split("\n");
  const count = Number(lines[1].split(" ")[1]);
  for (let i = 1; i < count; i++) {
    const off = Number(lines[2 + i].slice(0, 10));
    assert.ok(text.startsWith(i + " 0 obj", off), "xref " + i);
  }
});

test("QR-Code als SVG", () => {
  const svg = Buffer.from(C.qrSVG("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP").split(",")[1], "base64").toString();
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('fill="#000"'));
});

/* ---------- Oberfläche ---------- */

test("Texte: Deutsch und Englisch haben dieselben Schlüssel", () => {
  const de = Object.keys(TEXTS.de).sort(), en = Object.keys(TEXTS.en).sort();
  assert.deepStrictEqual(de.filter((k) => !TEXTS.en[k]), []);
  assert.deepStrictEqual(en.filter((k) => !TEXTS.de[k]), []);
});

test("Texte: jeder benutzte Schlüssel existiert", () => {
  const sources = ["app/assets/app.js", "app/assets/core.js", "app/views/app.php"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const used = new Set();
  for (const m of sources.matchAll(/["']((?:lock|inst|icon|top|list|card|toast|entry|details|scan|import|export|sheet|restore|backup|update|bio|settings|pal|mixer|wipe|confirm|error|common|lang|e|h)\.[a-zA-Z0-9]+)["']/g)) used.add(m[1]);
  for (const id of Object.keys(APP.PALS.light).concat(Object.keys(APP.PALS.dark), ["own"])) used.add("pal." + id);
  for (const p of APP.PARTS) used.add("mixer." + p);
  const missing = [...used].filter((k) => !(k in TEXTS.de) && !/\.(js|php|png|css|svg)$/.test(k));
  assert.deepStrictEqual(missing, []);
});

test("Designs: Schrift ist überall lesbar", () => {
  for (const mode of ["light", "dark"]) {
    for (const [id, c] of Object.entries(APP.PALS[mode])) {
      const v = APP.derive(c);
      assert.ok(APP.contrast(v["--text"], v["--card"]) >= 4.5, id + " text");
      assert.ok(APP.contrast(v["--code"], v["--card"]) >= 3, id + " code");
      assert.ok(APP.contrast(v["--bar-text"], v["--bar"]) >= 4.5, id + " bar");
      assert.ok(APP.contrast(v["--acc-text"], v["--acc"]) >= 3, id + " acc");
      assert.ok(APP.contrast(v["--hi-text"], v["--hi"]) >= 3, id + " hi");
    }
  }
  assert.deepStrictEqual(APP.hex2hsl(APP.hsl2hex([210, 60, 40])), [210, 60, 40]);
});

test("Hilfen der Oberfläche", () => {
  assert.deepStrictEqual(APP.groupCode("123456"), ["123", "456"]);
  assert.deepStrictEqual(APP.groupCode("1234567"), ["123", "4567"]);
  assert.deepStrictEqual(APP.groupCode("BCDFG"), ["BCDFG"]);
  assert.strictEqual(APP.strength("kurz"), 0);
  assert.strictEqual(APP.strength("vier wörter sind ein satz"), 3);
  assert.ok(APP.matches({ issuer: "GitHub", account: "ich" }, "git"));
  assert.ok(!APP.matches({ issuer: "GitHub", account: "ich" }, "bank"));
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log("ok   " + name);
    } catch (err) {
      failed++;
      console.log("FAIL " + name + "\n     " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n     ") : err));
    }
  }
  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  process.exit(failed ? 1 : 0);
})();
