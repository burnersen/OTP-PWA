/* OTP-PWA (https://github.com/burnersen/OTP-PWA)
   Copyright (C) 2026 burnersen
   SPDX-License-Identifier: GPL-3.0-only

   Die Oberfläche. Schlichtes JavaScript ohne Framework und ohne Build-Schritt.
   Alles bleibt auf dem Gerät: der Tresor liegt verschlüsselt in IndexedDB (genau im Dateiformat von otp-vault),
   Schlüssel und Konten sind nur im Speicher, solange entsperrt ist. Werte aus dem Tresor oder einem Import
   werden immer mit textContent gesetzt, nie als HTML: ein Name kann nichts einschleusen.

   Die reinen Hilfen stehen auf window.OPApp und werden von tools/check.js ohne Browser geprüft. */
"use strict";

(function (root) {
  const C = root.OPCore;
  const TEXTS = root.OP_TEXTS;
  const RING = 2 * Math.PI * 17; // Umfang des Countdown-Rings
  const doc = root.document;

  /* ---------- Einstellungen (nur dieses Gerät, nichts davon ist geheim) ---------- */

  const DEFAULTS = {
    lang: "", mode: "auto", palL: "navy", palD: "nacht", custL: null, custD: null,
    fs: 100, cs: 100, compact: false, showNext: true, hideCodes: false,
    autoLock: 5, leaveLock: 60, clip: 30, remind: 30, bioAuto: true, autoIcons: true,
  };

  const LS = {
    get(k, d) {
      try {
        const v = root.localStorage.getItem("op_" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try { root.localStorage.setItem("op_" + k, JSON.stringify(v)); } catch (e) { /* voll oder gesperrt: dann eben nicht gemerkt */ }
    },
    del(k) {
      try { root.localStorage.removeItem("op_" + k); } catch (e) { /* egal */ }
    },
  };

  const state = {
    lang: "de",
    s: Object.assign({}, DEFAULTS),
    hasVault: false,
    vault: null,        // {key, kdf, data: {entries, saved}} solange entsperrt
    codes: {},          // id -> CodeView
    query: "",
    editing: null,
    menuFor: null,
    iconFor: null,
    importText: "",
    preview: null,      // {format, items, list}
    googleQRs: [],
    googleAt: 0,
    exportFile: null,   // {name, blob, kind}
    tickTimer: 0,
    lastActive: Date.now(),
    hiddenAt: 0,
    bio: null,          // gespeicherte Face-ID-Bindung
    bioPending: null,   // Face ID halb eingerichtet (zweites Antippen nötig)
    swReg: null,
    swWaiting: false,
    installEvent: null,
    revealed: {},       // id -> Zeitpunkt, bis wann der Code trotz „unscharf“ zu sehen ist
    restoreRaw: "",
    version: doc ? doc.documentElement.dataset.version || "" : "",
  };

  /* ---------- reine Hilfen ---------- */

  function t(key, vars) {
    let text = (TEXTS[state.lang] || TEXTS.de)[key];
    if (text === undefined) text = TEXTS.en[key];
    if (text === undefined) return key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, n) => (vars[n] === undefined ? m : String(vars[n])));
    return text;
  }

  // Fehler in Meldung und Tipp zerlegen, in der Sprache der Seite
  function errText(err) {
    if (err && err.name === "UserError") return { msg: t(err.msg, err.vars), hint: err.hint ? t(err.hint, err.vars) : "" };
    if (err && err.name === "NotAllowedError") return { msg: t("e.cancelled"), hint: "" };
    if (err && err.name === "QuotaExceededError") return { msg: t("e.storageFull"), hint: t("h.storageFull") };
    const raw = String(err && err.message ? err.message : err || "");
    return { msg: t("e.unexpected"), hint: raw };
  }

  // Code zum Lesen teilen: 123 456, 1234 5678, 123 4567
  function groupCode(code) {
    if (!/^\d{6,10}$/.test(code)) return [code];
    const half = Math.floor(code.length / 2);
    return [code.slice(0, half), code.slice(half)];
  }

  function ringOffset(remaining, period) {
    if (!period) return 0;
    const left = Math.max(0, Math.min(period, remaining));
    return RING * (1 - left / period);
  }

  // Stärke eines neuen Master-Passworts: 0 schwach, 1 okay, 2 gut, 3 sehr gut
  function strength(pw) {
    if (!pw) return -1;
    const len = [...pw].length;
    let classes = 0;
    if (/[a-z]/.test(pw)) classes++;
    if (/[A-Z]/.test(pw)) classes++;
    if (/\d/.test(pw)) classes++;
    if (/[^A-Za-z0-9]/.test(pw)) classes++;
    const words = pw.trim().split(/\s+/).length;
    if (len < 8) return 0;
    if (len >= 20 || (words >= 4 && len >= 16)) return 3;
    if (len >= 14 || (len >= 12 && classes >= 3)) return 2;
    return 1;
  }

  function matches(e, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return [e.issuer, e.account, e.note, e.website].some((s) => (s || "").toLowerCase().includes(q));
  }

  function hue(s) {
    let h = 0;
    for (const c of s || "?") h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  const displayName = (e) => e.issuer || e.account || "?";
  const nowSecs = () => Math.floor(Date.now() / 1000);

  function fmtSize(n) {
    return n < 1024 ? n + " B" : n < 1024 * 1024 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }

  function fmtDate(ms) {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleString(state.lang === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ---------- Farben und Designs ---------- */

  // Sieben Grundfarben pro Design, alles andere wird daraus abgeleitet
  const PARTS = ["bg", "card", "text", "acc", "bar", "hi", "code"];
  const mixer = { open: false, mode: "light", part: "acc", col: null, start: null, hsl: {} };
  const PALS = {
    light: {
      navy: { bg: "#f3f5f9", card: "#ffffff", text: "#1b2333", acc: "#1c3f78", bar: "#1c3f78", hi: "#ffc400", code: "#1c3f78" },
      ozean: { bg: "#f2f5fa", card: "#ffffff", text: "#131c2b", acc: "#2563eb", bar: "#1d4ed8", hi: "#f59e0b", code: "#1d4ed8" },
      wald: { bg: "#f2f6f4", card: "#ffffff", text: "#13201d", acc: "#0f766e", bar: "#115e59", hi: "#facc15", code: "#0f766e" },
      beere: { bg: "#f9f3f6", card: "#ffffff", text: "#261a22", acc: "#9d2463", bar: "#831843", hi: "#fbbf24", code: "#9d2463" },
      graphit: { bg: "#f4f4f5", card: "#ffffff", text: "#18181b", acc: "#27272a", bar: "#27272a", hi: "#ffc400", code: "#18181b" },
    },
    dark: {
      nacht: { bg: "#0f1522", card: "#182133", text: "#e7ecf5", acc: "#4d7cc7", bar: "#13213d", hi: "#ffc400", code: "#9cc0ff" },
      lagune: { bg: "#0f1720", card: "#18232e", text: "#e7eef3", acc: "#2dd4bf", bar: "#0d2a2c", hi: "#fde047", code: "#5eead4" },
      glut: { bg: "#17120e", card: "#221b15", text: "#f1e9e0", acc: "#fb923c", bar: "#2c1c10", hi: "#fde047", code: "#fdba74" },
      pflaume: { bg: "#150f1a", card: "#201828", text: "#efe7f3", acc: "#f08bd0", bar: "#2a1533", hi: "#fde047", code: "#f5b0e0" },
      schwarz: { bg: "#000000", card: "#111113", text: "#ededee", acc: "#e4e4e7", bar: "#000000", hi: "#ffc400", code: "#ffffff" },
    },
  };

  const isHex = (v) => /^#[0-9a-f]{6}$/.test(v);
  const okCols = (c) => (c && PARTS.every((k) => isHex(c[k])) ? Object.fromEntries(PARTS.map((k) => [k, c[k]])) : null);
  const hex2rgb = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  const rgb2hex = (a) => "#" + a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, f) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * f)); };
  const lum = (x) => {
    const [r, g, b] = hex2rgb(x).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const onColor = (c) => (contrast(c, "#ffffff") >= contrast(c, "#101418") ? "#ffffff" : "#101418");

  function hsl2hex([h, s, l]) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
    return rgb2hex([f(0), f(8), f(4)]);
  }

  function hex2hsl(x) {
    const [r, g, b] = hex2rgb(x).map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0;
    if (d) h = ((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
    return [Math.round(h), Math.round((d ? d / (1 - Math.abs(2 * l - 1)) : 0) * 100), Math.round(l * 100)];
  }

  // Aus den sieben Grundfarben alle Farben der Oberfläche
  function derive(c) {
    const dark = lum(c.bg) < 0.2;
    return {
      "--bg": c.bg, "--card": c.card, "--text": c.text, "--mut": mix(c.text, c.bg, 0.42), "--line": mix(c.text, c.bg, 0.85),
      "--acc": c.acc, "--acc-2": mix(c.acc, dark ? "#ffffff" : "#000000", 0.12), "--acc-soft": mix(c.acc, c.card, dark ? 0.78 : 0.88), "--acc-text": onColor(c.acc),
      "--hi": c.hi, "--hi-text": contrast(c.hi, c.bar) >= 3 && lum(c.hi) > 0.4 ? (lum(c.bar) < 0.3 ? c.bar : "#101418") : onColor(c.hi), "--hi-soft": mix(c.hi, c.card, dark ? 0.8 : 0.85),
      "--bar": c.bar, "--bar-text": onColor(c.bar), "--code": c.code, "--track": mix(c.text, c.card, 0.86),
      "--ok": dark ? "#4ade80" : "#1e8e5a", "--warn": dark ? "#fcd34d" : "#9a6b00",
      "--danger": dark ? "#ff8a80" : "#b3261e", "--danger-soft": dark ? "#3a1d1d" : "#fdecea",
      "--shadow": dark ? "none" : "0 1px 2px rgba(20, 35, 70, .06), 0 4px 14px rgba(20, 35, 70, .06)",
      "color-scheme": dark ? "dark" : "light",
    };
  }
  const VARS = Object.keys(derive(PALS.light.navy));

  const darkMq = root.matchMedia ? root.matchMedia("(prefers-color-scheme: dark)") : { matches: false, addEventListener() {} };
  // Beim Farbmischen gilt die Seite (hell oder dunkel), die gerade gemischt wird
  const curMode = () => (mixer.open ? mixer.mode : state.s.mode === "auto" ? (darkMq.matches ? "dark" : "light") : state.s.mode);

  // Die Farben für hell oder dunkel: fertiges Design oder das eigene aus dem Farbmischer
  function colorsFor(mode) {
    const pal = mode === "dark" ? state.s.palD : state.s.palL;
    const own = okCols(mode === "dark" ? state.s.custD : state.s.custL);
    if (pal === "own" && own) return own;
    return PALS[mode][pal] || PALS[mode][mode === "dark" ? "nacht" : "navy"];
  }

  function setVars(el, vars) {
    for (const k of VARS) el.style.setProperty(k, vars[k]);
  }

  function applyTheme() {
    const mode = curMode();
    const html = doc.documentElement;
    const vars = derive(colorsFor(mode));
    setVars(html, vars);
    html.style.setProperty("--fs", String(state.s.fs / 100));
    html.style.setProperty("--cs", String(state.s.cs / 100));
    html.dataset.theme = mode;
    const meta = doc.querySelector("meta[name=theme-color]");
    if (meta) meta.content = vars["--bar"];
    // Merkzettel für boot.js: beim nächsten Start sofort in den richtigen Farben
    LS.set("paint", { mode: state.s.mode, light: derive(colorsFor("light")), dark: derive(colorsFor("dark")), fs: String(state.s.fs / 100), cs: String(state.s.cs / 100) });
  }

  /* ---------- Speicher auf dem Gerät (IndexedDB) ---------- */

  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = root.indexedDB.open("otp-pwa", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const r = db.transaction("kv", "readonly").objectStore("kv").get(key);
        r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
        r.onerror = () => reject(r.error);
      });
    },
    // Mehrere Schlüssel in einem Rutsch: entweder alle geschrieben oder keiner (null löscht)
    async put(obj) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        const st = tx.objectStore("kv");
        for (const [k, v] of Object.entries(obj)) {
          if (v === null) st.delete(k);
          else st.put(v, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("aborted"));
      });
    },
    async clear() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  /* ---------- DOM-Hilfen ---------- */

  const el = (id) => doc.getElementById(id);

  function make(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function svgIcon(path, extra) {
    const ns = "http://www.w3.org/2000/svg";
    const s = doc.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    if (path) {
      const p = doc.createElementNS(ns, "path");
      p.setAttribute("d", path);
      s.appendChild(p);
    }
    if (extra) extra(s, ns);
    return s;
  }

  function applyTexts() {
    doc.documentElement.lang = state.lang;
    doc.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
    doc.querySelectorAll("[data-i18n-ph]").forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
    doc.querySelectorAll("[data-i18n-label]").forEach((n) => {
      n.title = t(n.dataset.i18nLabel);
      n.setAttribute("aria-label", t(n.dataset.i18nLabel));
    });
    doc.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));
    el("lock-eye").textContent = el("lock-pw").type === "password" ? t("lock.show") : t("lock.hide");
    fillSelects();
    if (!el("lock-view").hidden) showLock();
    if (state.vault) render();
    if (!el("install-view").hidden) showInstall();
    renderBanners();
  }

  let toastTimer = 0;
  function toast(text, bad) {
    const n = el("toast");
    n.textContent = text;
    n.classList.toggle("bad", !!bad);
    n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, bad ? 6000 : 2600);
  }

  /* ---------- Dialoge ---------- */

  const DIALOGS = ["dlg-entry", "dlg-details", "dlg-icon", "dlg-import", "dlg-export", "dlg-google", "dlg-scan", "dlg-settings", "dlg-mixer", "dlg-restore", "dlg-confirm", "dlg-error"];
  let dialogStack = [];

  function openDialog(id, keep) {
    closeMenu();
    if (keep) {
      const cur = DIALOGS.find((d) => !el(d).hidden);
      if (cur && cur !== id) dialogStack.push(cur);
    } else {
      dialogStack = [];
    }
    DIALOGS.forEach((d) => { el(d).hidden = d !== id; });
    el("overlay").hidden = false;
    el(id).scrollTop = 0;
  }

  // Was ein geschlossener Dialog nicht behalten darf: Schlüssel, Link und QR-Codes, eingetippte Passwörter.
  // Mit all (beim Sperren) auch die Texte von Hinzufügen und Import.
  function wipeDialogs(all) {
    el("details-secret").textContent = "";
    el("details-uri").textContent = "";
    el("details-qr").removeAttribute("src");
    el("google-qr").removeAttribute("src");
    state.googleQRs = [];
    for (const id of ["entry-secret", "export-pw", "export-pw2", "import-pw", "pw-old", "pw-new", "pw-new2", "restore-pw"]) el(id).value = "";
    if (all) {
      el("import-text").value = "";
      el("import-list").textContent = "";
      el("export-list").textContent = "";
      state.importText = "";
      state.preview = null;
      state.editing = null;
      state.exportFile = null;
      state.restoreRaw = "";
    }
  }

  function closeDialog() {
    stopScanner();
    if (mixer.open && !el("dlg-mixer").hidden) {
      mixer.open = false;
      applyTheme();
      palButtons("light");
      palButtons("dark");
    }
    if (dialogStack.length) {
      const back = dialogStack.pop();
      DIALOGS.forEach((d) => { el(d).hidden = d !== back; });
      return;
    }
    el("overlay").hidden = true;
    DIALOGS.forEach((d) => { el(d).hidden = true; });
    wipeDialogs(false);
    state.preview = null;
    state.exportFile = null;
  }

  function showError(err) {
    const e = errText(err);
    el("error-msg").textContent = e.msg;
    el("error-hint").textContent = e.hint;
    openDialog("dlg-error", true);
  }

  function setInlineError(id, err) {
    if (!err) { el(id).textContent = ""; return; }
    const e = errText(err);
    el(id).textContent = e.hint ? e.msg + "\n" + e.hint : e.msg;
  }

  let confirmResolve = null;
  // typeWord: zur Sicherheit muss ein Wort eingetippt werden (für „Alles löschen“)
  function confirmDialog(title, text, yes, typeWord) {
    el("confirm-title").textContent = title;
    el("confirm-text").textContent = text;
    el("confirm-yes").textContent = yes || t("common.delete");
    el("confirm-type-row").hidden = !typeWord;
    el("confirm-type").value = "";
    el("confirm-type-label").textContent = typeWord ? t("confirm.type", { w: typeWord }) : "";
    el("confirm-yes").disabled = !!typeWord;
    el("confirm-type").oninput = () => { el("confirm-yes").disabled = el("confirm-type").value.trim().toLowerCase() !== String(typeWord).toLowerCase(); };
    openDialog("dlg-confirm", true);
    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  /* ---------- Umgebung: installiert? iPhone? ---------- */

  const isStandalone = () => !!(root.navigator.standalone ||
    (root.matchMedia && ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].some((m) => root.matchMedia("(display-mode: " + m + ")").matches)));
  const isIOS = () => /iPad|iPhone|iPod/.test(root.navigator.userAgent) || (root.navigator.platform === "MacIntel" && root.navigator.maxTouchPoints > 1);

  /* ---------- Sperrbildschirm ---------- */

  function showLock() {
    el("main-view").hidden = true;
    el("lock-view").hidden = false;
    const create = !state.hasVault;
    el("lock-title").textContent = t(create ? "lock.createTitle" : "lock.unlockTitle");
    el("lock-lead").textContent = t(create ? "lock.createLead" : "lock.unlockLead");
    el("lock-submit").textContent = t(create ? "lock.create" : "lock.unlock");
    el("lock-pw2-row").hidden = !create;
    el("lock-meter").hidden = !create;
    el("lock-pw").autocomplete = create ? "new-password" : "current-password";
    el("lock-restore").hidden = !create;
    el("lock-reset").hidden = create;
    const bio = !create && !!state.bio;
    el("lock-bio").hidden = !bio;
    el("lock-bio-text").textContent = t("bio.unlock", { name: bioName() });
    updateMeter();
  }

  function updateMeter() {
    if (state.hasVault) { el("lock-hint").textContent = ""; return; }
    const s = strength(el("lock-pw").value);
    const colors = ["#b3261e", "#d99a00", "#3a8f5c", "#1e8e5a"];
    const keys = ["lock.strengthWeak", "lock.strengthOk", "lock.strengthGood", "lock.strengthGreat"];
    el("lock-meter-bar").style.width = s < 0 ? "0" : (s + 1) * 25 + "%";
    el("lock-meter-bar").style.background = s < 0 ? "transparent" : colors[s];
    el("lock-hint").textContent = s < 0 ? "" : t(keys[s]);
  }

  async function submitLock(ev) {
    ev.preventDefault();
    const pw = el("lock-pw").value;
    el("lock-error").textContent = "";
    if (!state.hasVault) {
      if ([...pw].length < C.MIN_PASSWORD) { el("lock-error").textContent = t("lock.short"); return; }
      if (pw !== el("lock-pw2").value) { el("lock-error").textContent = t("lock.mismatch"); return; }
    }
    const btn = el("lock-submit");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t("lock.working");
    try {
      if (state.hasVault) await unlockWithPassword(pw);
      else await createVault(pw);
      el("lock-pw").value = "";
      el("lock-pw2").value = "";
      enterVault();
    } catch (err) {
      setInlineError("lock-error", err);
      el("lock-pw").select();
    } finally {
      btn.disabled = false;
      if (!el("lock-view").hidden) showLock();
    }
  }

  async function createVault(pw) {
    const k = await C.newSealKey(pw);
    const data = { entries: [], saved: nowSecs() };
    const raw = C.seal(k, data);
    await DB.put({ vault: raw, vault_bak: raw });
    state.vault = { key: k.key, kdf: k.kdf, data };
    state.hasVault = true;
    askPersist();
  }

  async function unlockWithPassword(pw) {
    const raw = await DB.get("vault");
    if (!raw) { state.hasVault = false; throw new C.UserError("e.noVault", "h.noVault"); }
    try {
      const v = await C.openVault(raw, pw);
      state.vault = { key: v.key, kdf: v.kdf, data: v.data };
    } catch (err) {
      // Kaputte Datei (nicht falsches Passwort): mit dem vorigen Stand versuchen
      if (err && err.msg && err.msg !== "e.wrongPw" && err.msg !== "e.pwShort") {
        const bak = await DB.get("vault_bak");
        if (bak && bak !== raw) {
          const v = await C.openVault(bak, pw);
          state.vault = { key: v.key, kdf: v.kdf, data: v.data };
          await DB.put({ vault: bak });
          toast(t("toast.fromBak"), true);
          return;
        }
      }
      throw err;
    }
  }

  // Bittet den Browser, die Daten nicht bei Platzmangel wegzuräumen
  function askPersist() {
    try {
      if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist().catch(() => {});
    } catch (e) { /* gibt es nicht überall */ }
  }

  /* ---------- Sicherung wiederherstellen (vom Sperrbildschirm aus) ---------- */

  async function restoreFileChosen() {
    const f = el("restore-file").files[0];
    el("restore-file").value = "";
    if (!f) return;
    el("lock-error").textContent = "";
    try {
      const raw = await readText(f);
      C.readSealed(raw);
      state.restoreRaw = raw;
      el("restore-lead").textContent = t("restore.lead", { file: f.name });
      el("restore-error").textContent = "";
      el("restore-pw").value = "";
      openDialog("dlg-restore");
      setTimeout(() => el("restore-pw").focus(), 50);
    } catch (err) {
      setInlineError("lock-error", err);
    }
  }

  async function submitRestore(ev) {
    ev.preventDefault();
    const btn = el("restore-go");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t("lock.working");
    try {
      const raw = state.restoreRaw;
      const v = await C.openVault(raw, el("restore-pw").value);
      await DB.put({ vault: raw, vault_bak: raw, bio: null });
      state.bio = null;
      state.hasVault = true;
      state.vault = { key: v.key, kdf: v.kdf, data: v.data };
      state.restoreRaw = "";
      askPersist();
      closeDialog();
      enterVault();
      toast(t("toast.restored", { n: v.data.entries.length }));
    } catch (err) {
      setInlineError("restore-error", err);
    } finally {
      btn.disabled = false;
      btn.textContent = t("restore.go");
    }
  }

  async function wipeAll(fromLock) {
    const ok = await confirmDialog(t("wipe.title"), t("wipe.text"), t("wipe.yes"), t("wipe.word"));
    if (!ok) return;
    try {
      await DB.clear();
      LS.del("lastBackup");
      LS.del("snooze");
      state.bio = null;
      state.hasVault = false;
      lock(true);
      if (fromLock) showLock();
      toast(t("toast.wiped"));
    } catch (err) {
      showError(err);
    }
  }

  /* ---------- entsperrt ---------- */

  function enterVault() {
    state.lastActive = Date.now();
    el("lock-view").hidden = true;
    el("main-view").hidden = false;
    render();
    tick();
    renderBanners();
  }

  // Sperren: Schlüssel und Konten vergessen, alles Sichtbare leeren
  function lock(silent) {
    if (state.vault) C.wipe(state.vault.key);
    state.vault = null;
    state.codes = {};
    state.revealed = {};
    C.forget();
    clearTimeout(state.tickTimer);
    el("cards").textContent = "";
    el("overlay").hidden = true;
    DIALOGS.forEach((d) => { el(d).hidden = true; });
    dialogStack = [];
    stopScanner();
    wipeDialogs(true);
    closeMenu();
    el("search").value = "";
    state.query = "";
    showLock();
    if (!silent) toast(t("toast.locked"));
  }

  const entries = () => (state.vault ? state.vault.data.entries : []);

  // Speichert den Tresor verschlüsselt. Der vorige Stand bleibt als vault_bak liegen (wie vault.otpv.bak bei otp-vault).
  async function persist() {
    const v = state.vault;
    v.data.saved = nowSecs();
    const raw = C.seal({ key: v.key, kdf: v.kdf }, v.data);
    const old = await DB.get("vault");
    await DB.put({ vault: raw, vault_bak: old || raw });
  }

  // Führt eine Änderung aus und speichert. Klappt das Speichern nicht, wird die Änderung zurückgenommen.
  async function change(fn) {
    const before = entries().map((e) => Object.assign({}, e));
    try {
      const r = fn(state.vault.data.entries);
      await persist();
      return r;
    } catch (err) {
      if (state.vault) state.vault.data.entries = before;
      throw err;
    }
  }

  function normalizedCopy(e) {
    return C.normalizeEntry(Object.assign({}, e));
  }

  async function addEntry(input) {
    const e = normalizedCopy(input);
    const dup = C.duplicateOf(entries(), e);
    if (dup) throw new C.UserError("e.duplicate", "h.duplicate", { name: C.label(dup) });
    const now = nowSecs();
    e.id = C.newID();
    e.created = now;
    e.updated = now;
    await change((list) => list.push(e));
    return e;
  }

  async function updateEntry(input) {
    const old = entries().find((x) => x.id === input.id);
    if (!old) throw new C.UserError("e.gone", "h.gone");
    if (!String(input.secret || "").trim()) input.secret = old.secret;
    const e = normalizedCopy(input);
    const other = entries().find((x) => x.id !== e.id && x.secret === e.secret && x.kind === e.kind);
    if (other) throw new C.UserError("e.sameSecret", "h.sameSecret", { name: C.label(other) });
    e.id = old.id;
    e.created = old.created;
    e.updated = nowSecs();
    // Neue Webseite: das alte Icon gehörte zur alten (außer man hat gleichzeitig ein anderes gewählt)
    if (e.website !== (old.website || "") && e.icon === (old.icon || "")) e.icon = "";
    await change((list) => { list[list.findIndex((x) => x.id === e.id)] = e; });
    return e;
  }

  async function modifyEntry(id, fn) {
    await change((list) => {
      const e = list.find((x) => x.id === id);
      if (!e) throw new C.UserError("e.gone", "h.gone");
      fn(e);
      e.updated = nowSecs();
    });
  }

  async function removeEntry(id) {
    await change((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  }

  // Übernimmt, was ein Import gefunden hat. Doppelte (im Tresor oder zweimal im Import) werden übersprungen.
  async function addMany(list) {
    let added = 0, skipped = 0;
    const now = nowSecs();
    const fresh = [];
    for (const raw of list) {
      let e;
      try {
        e = normalizedCopy(raw);
      } catch (err) {
        skipped++;
        continue;
      }
      if (C.duplicateOf(entries(), e) || C.duplicateOf(fresh, e)) { skipped++; continue; }
      e.id = C.newID();
      e.created = now;
      e.updated = now;
      fresh.push(e);
      added++;
    }
    if (added) await change((all) => all.push(...fresh));
    return { added, skipped, ids: fresh.map((e) => e.id) };
  }

  /* ---------- Liste und Karten ---------- */

  function visibleEntries() {
    return C.sortEntries(entries()).filter((e) => matches(e, state.query));
  }

  function render() {
    if (!state.vault) return;
    const all = entries();
    const list = visibleEntries();
    el("count-label").textContent = all.length === 1 ? t("list.count1") : t("list.countN", { n: all.length });
    el("empty").hidden = all.length > 0;
    el("no-match").hidden = all.length === 0 || list.length > 0;
    el("no-match").textContent = t("list.noMatch", { q: state.query });
    doc.body.classList.toggle("hide-codes", !!state.s.hideCodes);
    el("cards").classList.toggle("compact", !!state.s.compact);
    const cards = el("cards");
    cards.textContent = "";
    for (const e of list) cards.appendChild(card(e));
    updateCodes();
  }

  function avatar(e) {
    const a = make("div", "avatar");
    const letter = () => {
      a.textContent = displayName(e).slice(0, 1).toUpperCase();
      a.style.background = "hsl(" + hue(displayName(e).toLowerCase()) + " 55% 42%)";
    };
    if (e.icon && C.splitDataURL(e.icon)) {
      const img = doc.createElement("img");
      img.alt = "";
      img.src = e.icon;
      img.onerror = () => { img.remove(); letter(); };
      a.appendChild(img);
    } else {
      letter();
    }
    return a;
  }

  function card(e) {
    const c = make("article", "card");
    c.dataset.id = e.id;
    if (state.revealed[e.id] > Date.now()) c.classList.add("revealed");
    const head = make("div", "card-head");
    head.appendChild(avatar(e));
    const names = make("div", "names");
    names.appendChild(make("div", "issuer", displayName(e)));
    if (e.issuer && e.account) names.appendChild(make("div", "account", e.account));
    head.appendChild(names);
    const fav = make("button", "icon-btn" + (e.favorite ? " fav-on" : ""));
    fav.type = "button";
    fav.title = t("card.favorite");
    fav.setAttribute("aria-label", t("card.favorite"));
    fav.setAttribute("aria-pressed", String(!!e.favorite));
    fav.appendChild(svgIcon("m12 3 2.7 5.6 6.1.8-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.8z"));
    fav.onclick = () => toggleFavorite(e.id);
    head.appendChild(fav);
    const more = make("button", "icon-btn");
    more.type = "button";
    more.title = t("card.menu");
    more.setAttribute("aria-label", t("card.menu"));
    more.appendChild(svgIcon("M12 6h.01M12 12h.01M12 18h.01"));
    more.onclick = (ev) => { ev.stopPropagation(); openMenu(e.id, more); };
    head.appendChild(more);
    c.appendChild(head);

    const body = make("div", "card-body");
    const code = make("button", "code");
    code.type = "button";
    code.title = t("card.copy");
    code.setAttribute("aria-label", t("card.copy"));
    code.onclick = () => copyCode(e.id, false, code);
    body.appendChild(code);
    if (e.kind === "hotp") {
      const b = make("button", "hotp-btn", t("card.nextHotp"));
      b.type = "button";
      b.onclick = () => nextHOTP(e.id);
      body.appendChild(b);
    } else {
      const ring = make("div", "ring");
      ring.appendChild(svgIcon("", (s, ns) => {
        for (const cls of ["track", "arc"]) {
          const circ = doc.createElementNS(ns, "circle");
          circ.setAttribute("cx", "21"); circ.setAttribute("cy", "21"); circ.setAttribute("r", "17");
          circ.setAttribute("class", cls);
          if (cls === "arc") circ.setAttribute("stroke-dasharray", String(RING));
          s.appendChild(circ);
        }
        s.setAttribute("viewBox", "0 0 42 42");
      }));
      ring.appendChild(make("span", "secs"));
      body.appendChild(ring);
    }
    // In der kompakten Ansicht steht das Menü hinter dem Code
    const more2 = make("button", "icon-btn more-btn");
    more2.type = "button";
    more2.setAttribute("aria-label", t("card.menu"));
    more2.appendChild(svgIcon("M12 6h.01M12 12h.01M12 18h.01"));
    more2.onclick = (ev) => { ev.stopPropagation(); openMenu(e.id, more2); };
    body.appendChild(more2);
    c.appendChild(body);

    const foot = make("div", "card-foot");
    const nextWrap = make("span", "next-wrap");
    if (state.s.showNext) {
      nextWrap.appendChild(doc.createTextNode(t("card.next") + " "));
      const nb = make("button", "next-code");
      nb.type = "button";
      nb.title = t("card.copy");
      nb.onclick = () => copyCode(e.id, true, nb);
      nextWrap.appendChild(nb);
    }
    foot.appendChild(nextWrap);
    const badges = make("span", "");
    if (e.kind === "hotp") badges.appendChild(make("span", "badge", t("card.counter", { n: e.counter })));
    else if (e.kind === "steam") badges.appendChild(make("span", "badge", "Steam"));
    else if (e.digits !== 6 || e.period !== 30 || e.algorithm !== "SHA1") {
      badges.appendChild(make("span", "badge", e.algorithm + " · " + e.digits + " · " + e.period + "s"));
    }
    foot.appendChild(badges);
    c.appendChild(foot);
    return c;
  }

  function fillCode(btn, code) {
    btn.textContent = "";
    groupCode(code || "").forEach((p, i) => {
      if (i > 0) btn.appendChild(make("span", "gap"));
      btn.appendChild(doc.createTextNode(p));
    });
  }

  function updateCodes() {
    const now = Date.now();
    doc.querySelectorAll(".card").forEach((c) => {
      const v = state.codes[c.dataset.id];
      c.classList.toggle("revealed", state.revealed[c.dataset.id] > now);
      if (!v) return;
      const code = c.querySelector(".code");
      if (code.dataset.code !== v.current) {
        fillCode(code, v.current);
        code.dataset.code = v.current;
      }
      const next = c.querySelector(".next-code");
      if (next && next.textContent !== v.next) next.textContent = v.next;
      const ring = c.querySelector(".ring");
      if (ring) {
        const arc = ring.querySelector(".arc");
        const old = Number(ring.dataset.rem || 0);
        if (v.remaining > old) {
          arc.style.transition = "none"; // neue Periode: zurückspringen, nicht rückwärts laufen
          arc.getBoundingClientRect();
        }
        arc.style.strokeDashoffset = String(ringOffset(v.remaining - 1, v.period));
        if (v.remaining > old) root.requestAnimationFrame(() => { arc.style.transition = ""; });
        ring.dataset.rem = v.remaining;
        ring.querySelector(".secs").textContent = v.remaining;
        const urgent = v.remaining <= 5;
        ring.classList.toggle("urgent", urgent);
        code.classList.toggle("urgent", urgent);
      }
    });
  }

  // Rechnet die Codes der sichtbaren Konten und plant die nächste Runde selbst (kurz nach jeder vollen Sekunde)
  async function tick() {
    clearTimeout(state.tickTimer);
    if (!state.vault || doc.hidden) return;
    try {
      const now = Date.now();
      const views = await Promise.all(visibleEntries().map((e) => C.codeView(e, now)));
      if (!state.vault) return;
      for (const v of views) state.codes[v.id] = v;
      updateCodes();
    } catch (err) { /* nächste Runde */ }
    if (state.vault) state.tickTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 30);
  }

  /* ---------- Kopieren ---------- */

  let clipTimer = 0;

  // Muss direkt im Klick passieren (ohne await davor), sonst lässt das iPhone nicht in die Zwischenablage
  function writeClipboard(text) {
    try {
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
        return root.navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
      }
    } catch (e) { /* weiter mit dem alten Weg */ }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function scheduleClear() {
    clearTimeout(clipTimer);
    const secs = state.s.clip;
    if (secs > 0) {
      clipTimer = setTimeout(() => {
        try { root.navigator.clipboard.writeText(" ").catch(() => {}); } catch (e) { /* manche Geräte erlauben das nur nach einem Tipp */ }
      }, secs * 1000);
    }
  }

  function copyCode(id, next, btn) {
    const v = state.codes[id];
    if (!v || !v.current || v.current === "------") return;
    // Unscharfe Codes: erster Tipp zeigt, zweiter kopiert
    if (state.s.hideCodes && !(state.revealed[id] > Date.now())) {
      state.revealed[id] = Date.now() + 15000;
      updateCodes();
      return;
    }
    const code = next ? v.next : v.current;
    writeClipboard(code).then((ok) => {
      if (!ok) { toast(t("toast.copyFailed"), true); return; }
      btn.classList.remove("flash");
      btn.getBoundingClientRect();
      btn.classList.add("flash");
      if (root.navigator.vibrate) root.navigator.vibrate(12);
      toast(state.s.clip > 0 ? t("toast.copiedClear", { s: state.s.clip }) : t("toast.copied"));
      scheduleClear();
    });
  }

  async function toggleFavorite(id) {
    try {
      await modifyEntry(id, (e) => { e.favorite = !e.favorite; });
      render();
    } catch (err) { showError(err); }
  }

  async function nextHOTP(id) {
    try {
      await modifyEntry(id, (e) => { e.counter = (e.counter || 0) + 1; });
      render();
      tick();
    } catch (err) { showError(err); }
  }

  /* ---------- Kartenmenü ---------- */

  let menuOpenedAt = 0;
  function openMenu(id, anchor) {
    menuOpenedAt = Date.now();
    const m = el("card-menu");
    state.menuFor = id;
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(r.right - w, root.innerWidth - w - 8)) + "px";
    m.style.top = (r.bottom + h + 8 > root.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  }

  function closeMenu() {
    el("card-menu").hidden = true;
    state.menuFor = null;
  }

  async function menuAction(act) {
    const id = state.menuFor;
    closeMenu();
    const e = entries().find((x) => x.id === id);
    if (!e) return;
    try {
      switch (act) {
        case "edit": openEntry(e); break;
        case "details": openDetails(e); break;
        case "icon": openIconDialog(e); break;
        case "delete":
          if (await confirmDialog(t("confirm.delete", { name: displayName(e) }), t("confirm.deleteText"))) {
            await removeEntry(id);
            render();
            toast(t("toast.deleted"));
          }
          break;
      }
    } catch (err) { showError(err); }
  }

  /* ---------- Bilder: Icons und QR-Codes ---------- */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new C.UserError("e.badImage", "h.badImage")); };
      img.src = url;
    });
  }

  // Icon als kleines PNG (96 × 96), damit der Tresor klein bleibt
  async function iconFromFile(file) {
    const img = await loadImage(file);
    const n = 96;
    const canvas = doc.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    const w = img.naturalWidth || img.width || n, h = img.naturalHeight || img.height || n;
    const s = Math.min(n / w, n / h);
    ctx.drawImage(img, (n - w * s) / 2, (n - h * s) / 2, w * s, h * s);
    return canvas.toDataURL("image/png");
  }

  async function iconFileChosen() {
    const f = el("icon-file").files[0];
    if (!f || !state.iconFor) return;
    try {
      const url = await iconFromFile(f);
      await setIcon(state.iconFor, url, null);
    } catch (err) {
      if (!el("dlg-icon").hidden) setInlineError("icon-error", err);
      else showError(err);
    }
  }

  /* ---------- Icons von der Webseite des Dienstes ----------
     Die App selbst ruft keine fremden Seiten ab. Das Icon holt der eigene Server (index.php?action=icon),
     er bekommt dafür nur den Namen der Webseite. Auf dem Gerät wird es auf 96 × 96 Pixel als PNG umgerechnet
     und verschlüsselt im Tresor gespeichert, danach ist es auch ohne Netz da. */

  async function fetchIconFrom(param) {
    const q = param.url ? "url=" + encodeURIComponent(param.url) : "host=" + encodeURIComponent(param.host);
    const r = await root.fetch("./?action=icon&" + q, { headers: { "X-OTP-PWA": "1" }, credentials: "omit", cache: "no-store" });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).error || ""; } catch (e) { /* keine Meldung */ }
      const err = new Error(msg || "HTTP " + r.status);
      err.status = r.status;
      throw err;
    }
    return iconFromFile(await r.blob());
  }

  // Probiert die wahrscheinlichen Webseiten des Eintrags der Reihe nach. null = keine hatte ein Icon.
  async function findIcon(e) {
    for (const host of C.iconHosts(e)) {
      try {
        return { icon: await fetchIconFrom({ host }), host };
      } catch (err) {
        // Kein Netz, Server ohne curl oder gebremst: weitere Versuche bringen jetzt nichts
        if (!err.status || err.status === 429 || err.status === 501) throw err;
      }
    }
    return null;
  }

  // Icon setzen (oder mit "" entfernen) und überall neu zeichnen, wo der Eintrag zu sehen ist
  async function setIcon(id, icon, host) {
    await modifyEntry(id, (x) => {
      x.icon = icon;
      if (host && !x.website) x.website = host;
    });
    const e = entries().find((x) => x.id === id);
    const old = doc.querySelector('.card[data-id="' + id + '"] .avatar');
    if (e && old) old.replaceWith(avatar(e));
    if (e && state.iconFor === id && !el("dlg-icon").hidden) fillIconDialog(e);
  }

  const iconQueue = { ids: [], running: false, found: 0, missed: 0, report: false, failed: null };

  // Icons im Hintergrund holen, eins nach dem anderen. report: am Ende melden, wie viele gefunden wurden.
  function queueIcons(ids, report) {
    for (const id of ids) if (!iconQueue.ids.includes(id)) iconQueue.ids.push(id);
    if (report) iconQueue.report = true;
    if (!iconQueue.running) runIconQueue();
  }

  async function runIconQueue() {
    iconQueue.running = true;
    while (iconQueue.ids.length && state.vault) {
      const id = iconQueue.ids.shift();
      const e = entries().find((x) => x.id === id);
      if (!e || e.icon) continue;
      try {
        const r = await findIcon(e);
        if (!state.vault) break;
        if (r) {
          await setIcon(id, r.icon, r.host);
          iconQueue.found++;
        } else {
          iconQueue.missed++;
        }
      } catch (err) {
        iconQueue.missed += 1 + iconQueue.ids.length;
        iconQueue.ids = [];
        iconQueue.failed = err;
      }
    }
    if (iconQueue.report && state.vault) {
      toast(iconQueue.failed && !iconQueue.found ? t("icon.offline") : t("toast.iconsDone", { found: iconQueue.found, missed: iconQueue.missed }), !!iconQueue.failed && !iconQueue.found);
    }
    Object.assign(iconQueue, { running: false, found: 0, missed: 0, report: false, failed: null });
  }

  function openIconDialog(e) {
    state.iconFor = e.id;
    el("icon-site").value = e.website || C.iconHosts(e)[0] || "";
    el("icon-error").textContent = "";
    fillIconDialog(e);
    openDialog("dlg-icon");
  }

  function fillIconDialog(e) {
    const box = el("icon-preview");
    box.textContent = "";
    box.appendChild(avatar(e));
    el("icon-name").textContent = displayName(e);
    el("icon-account").textContent = e.issuer && e.account ? e.account : "";
    el("icon-remove").hidden = !e.icon;
  }

  async function iconFromSite(ev) {
    ev.preventDefault();
    const raw = el("icon-site").value.trim();
    const id = state.iconFor;
    el("icon-error").textContent = "";
    if (!raw || !id) return;
    // Eine ganze Adresse mit Pfad (Seite oder direkt ein Bild) geht so an den Server, sonst nur der Name
    const full = /^https?:\/\/[^/]+\/.+/i.test(raw);
    const host = C.normalizeHost(raw);
    if (!full && !host) { el("icon-error").textContent = t("icon.badSite"); return; }
    const btn = el("icon-fetch");
    btn.disabled = true;
    btn.textContent = t("lock.working");
    try {
      const icon = await fetchIconFrom(full ? { url: raw.replace(/^http:/i, "https:") } : { host });
      await setIcon(id, icon, host);
      await modifyEntry(id, (x) => { if (host) x.website = host; });
      toast(t("icon.saved"));
    } catch (err) {
      el("icon-error").textContent = !err.status ? t("icon.offline") : err.status === 404 ? t("icon.notFound", { site: host || raw }) : err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = t("icon.fetch");
    }
  }

  function scanCanvas(source, w, h, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const canvas = doc.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(source, 0, 0, cw, ch);
    return { data: ctx.getImageData(0, 0, cw, ch), w: cw, h: ch };
  }

  async function decodeImage(file) {
    if (typeof root.jsQR !== "function") return null;
    const img = await loadImage(file);
    // Große Bilder werden verkleinert: schneller, und jsQR liest sie genauso gut
    for (const side of [1600, 900, 2400]) {
      const c = scanCanvas(img, img.naturalWidth, img.naturalHeight, side);
      const r = root.jsQR(c.data.data, c.w, c.h, { inversionAttempts: "attemptBoth" });
      if (r && r.data) return r.data;
    }
    return null;
  }

  const isImage = (file) => /^image\//.test(file.type) || /\.(png|jpe?g|gif|bmp|webp|heic)$/i.test(file.name);

  function readText(file) {
    return file.arrayBuffer().then((buf) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch (e) {
        throw new C.UserError("e.notText", "h.notText");
      }
    });
  }

  /* ---------- Kamera ---------- */

  const scan = { stream: null, timer: 0, onResult: null, multi: false, seen: new Set() };

  function hasCamera() {
    return !!(root.navigator.mediaDevices && root.navigator.mediaDevices.getUserMedia);
  }

  // Öffnet die Kamera. multi: weiter scannen, bis man „Fertig“ tippt (für mehrere Google-Export-Codes)
  async function openScanner(onResult, multi) {
    scan.onResult = onResult;
    scan.multi = !!multi;
    scan.seen = new Set();
    el("scan-lead").textContent = t(multi ? "scan.leadMulti" : "scan.lead");
    el("scan-status").textContent = "";
    el("scan-error").textContent = "";
    openDialog("dlg-scan", true);
    if (!hasCamera()) { el("scan-error").textContent = t("scan.noCamera"); return; }
    try {
      scan.stream = await root.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      if (el("dlg-scan").hidden) { stopScanner(); return; }
      const v = el("scan-video");
      v.srcObject = scan.stream;
      await v.play().catch(() => {});
      scanLoop();
    } catch (err) {
      el("scan-error").textContent = err && err.name === "NotAllowedError" ? t("scan.denied") : t("scan.noCamera");
    }
  }

  function scanLoop() {
    clearTimeout(scan.timer);
    const v = el("scan-video");
    if (!scan.stream) return;
    if (v.readyState >= 2 && v.videoWidth && typeof root.jsQR === "function") {
      const c = scanCanvas(v, v.videoWidth, v.videoHeight, 720);
      const r = root.jsQR(c.data.data, c.w, c.h, { inversionAttempts: "dontInvert" });
      if (r && r.data && !scan.seen.has(r.data)) {
        scan.seen.add(r.data);
        if (root.navigator.vibrate) root.navigator.vibrate(30);
        const cb = scan.onResult;
        if (!scan.multi) {
          stopScanner();
          closeDialog();
          if (cb) cb(r.data);
          return;
        }
        if (cb) cb(r.data);
        el("scan-status").textContent = t("scan.count", { n: scan.seen.size });
      }
    }
    scan.timer = setTimeout(scanLoop, 180);
  }

  function stopScanner() {
    clearTimeout(scan.timer);
    if (scan.stream) {
      scan.stream.getTracks().forEach((tr) => tr.stop());
      scan.stream = null;
    }
    const v = el("scan-video");
    if (v) v.srcObject = null;
  }

  /* ---------- Hinzufügen und Bearbeiten ---------- */

  function openEntry(e) {
    state.editing = e || null;
    el("entry-title").textContent = t(e ? "entry.editTitle" : "entry.addTitle");
    el("entry-save").textContent = t(e ? "entry.save" : "entry.add");
    el("entry-secret").value = "";
    el("entry-secret-hint").textContent = t(e ? "entry.secretKeep" : "entry.secretHint");
    el("entry-issuer").value = e ? e.issuer : "";
    el("entry-account").value = e ? e.account : "";
    el("entry-website").value = e ? e.website || "" : "";
    el("entry-note").value = e ? e.note || "" : "";
    el("entry-kind").value = e ? e.kind : "totp";
    el("entry-alg").value = e ? e.algorithm : "SHA1";
    el("entry-digits").value = String(e ? e.digits : 6);
    el("entry-period").value = String(e ? e.period : 30);
    el("entry-counter").value = String(e ? e.counter || 0 : 0);
    el("entry-adv").open = !!(e && (e.kind !== "totp" || e.digits !== 6 || e.period !== 30 || e.algorithm !== "SHA1"));
    el("entry-parsed").hidden = true;
    el("entry-error").textContent = "";
    el("entry-scan").hidden = !hasCamera();
    kindChanged();
    openDialog("dlg-entry");
  }

  function kindChanged() {
    const k = el("entry-kind").value;
    el("entry-counter-row").hidden = k !== "hotp";
    el("entry-period-row").hidden = k === "hotp";
    el("entry-digits").disabled = k === "steam";
    el("entry-alg").disabled = k === "steam";
  }

  let parseTimer = 0;
  function secretChanged() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(parseSecret, 250);
  }

  // Erkennt, was eingefügt wurde (Schlüssel, Link, Google-Export) und füllt die Felder vor
  async function parseSecret() {
    const text = el("entry-secret").value.trim();
    const note = el("entry-parsed");
    note.hidden = true;
    note.textContent = "";
    if (!text || state.editing) return;
    try {
      const r = await C.parseImport(text, "");
      if (r.entries.length > 1 || /^otpauth-migration:/i.test(text)) {
        note.appendChild(doc.createTextNode(t("entry.many", { n: r.entries.length }) + " "));
        const b = make("button", "link", t("entry.toImport"));
        b.type = "button";
        b.onclick = () => openImport(text);
        note.appendChild(b);
        note.hidden = false;
        return;
      }
      const e = r.entries[0];
      const fill = (id, v) => { if (v && !el(id).value) el(id).value = v; };
      fill("entry-issuer", e.issuer);
      fill("entry-account", e.account);
      fill("entry-website", e.website);
      fill("entry-note", e.note);
      if (/^otpauth/i.test(text) || e.kind === "steam") {
        const n = Object.assign({ issuer: "x" }, e);
        try { C.normalizeEntry(n); } catch (err) { /* wird beim Speichern gemeldet */ }
        el("entry-kind").value = n.kind || "totp";
        el("entry-alg").value = n.algorithm || "SHA1";
        el("entry-digits").value = String(n.digits || 6);
        el("entry-period").value = String(n.period || 30);
        el("entry-counter").value = String(n.counter || 0);
        el("entry-adv").open = n.kind !== "totp" || n.digits !== 6 || n.period !== 30 || n.algorithm !== "SHA1";
        kindChanged();
      }
      note.textContent = t("entry.parsed", { format: r.format });
      note.hidden = false;
      el("entry-error").textContent = "";
    } catch (err) {
      if (err && err.name === "NeedPassword") return;
      setInlineError("entry-error", err);
    }
  }

  async function saveEntry(ev) {
    ev.preventDefault();
    const raw = el("entry-secret").value.trim();
    let input = {
      id: state.editing ? state.editing.id : "",
      kind: el("entry-kind").value,
      issuer: el("entry-issuer").value.trim(),
      account: el("entry-account").value.trim(),
      secret: raw,
      algorithm: el("entry-alg").value,
      digits: Number(el("entry-digits").value) || 6,
      period: Number(el("entry-period").value) || 30,
      counter: Number(el("entry-counter").value) || 0,
      website: el("entry-website").value.trim(),
      note: el("entry-note").value.trim(),
      icon: state.editing ? state.editing.icon || "" : "",
      favorite: state.editing ? !!state.editing.favorite : false,
    };
    const btn = el("entry-save");
    if (btn.disabled) return;
    btn.disabled = true;
    const editing = !!state.editing;
    try {
      // Ein Link oder ein steam://-Schlüssel bringt seine eigenen Angaben mit, die Felder ergänzen nur
      if (!editing && /^(otpauth|steam):\/\//i.test(raw)) {
        const p = (await C.parseImport(raw, "")).entries[0];
        input = Object.assign({}, p, {
          issuer: input.issuer || p.issuer, account: input.account || p.account, website: input.website || p.website || "",
          note: input.note || p.note || "", icon: "", favorite: false,
          kind: el("entry-adv").open ? input.kind : p.kind, algorithm: el("entry-adv").open ? input.algorithm : p.algorithm,
          digits: el("entry-adv").open ? input.digits : p.digits, period: el("entry-adv").open ? input.period : p.period,
          counter: el("entry-adv").open ? input.counter : p.counter,
        });
      }
      if (!input.issuer && !input.account) { el("entry-error").textContent = t("entry.needName"); return; }
      const v = editing ? await updateEntry(input) : await addEntry(input);
      if (state.s.autoIcons && !v.icon) queueIcons([v.id], false);
      closeDialog();
      toast(editing ? t("toast.saved") : t("toast.added", { name: displayName(v) }));
      render();
      tick();
      renderBanners();
    } catch (err) {
      setInlineError("entry-error", err);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Import ---------- */

  function openImport(text) {
    state.preview = null;
    state.importText = "";
    el("import-text").value = text || "";
    el("import-text").placeholder = t("import.pastePh");
    el("import-error").textContent = "";
    el("import-scan").hidden = !hasCamera();
    showImportStep("input");
    openDialog("dlg-import");
    if (text) readImport();
  }

  function showImportStep(step) {
    el("import-step-input").hidden = step !== "input";
    el("import-step-password").hidden = step !== "password";
    el("import-step-preview").hidden = step !== "preview";
    el("dlg-import").scrollTop = 0;
  }

  async function importFiles(files) {
    el("import-error").textContent = "";
    const lines = [];
    const problems = [];
    let textFile = null;
    for (const f of files) {
      try {
        if (isImage(f)) {
          const data = await decodeImage(f);
          if (data) lines.push(data);
          else problems.push(t("import.noQr", { file: f.name }));
        } else if (!textFile) {
          textFile = { name: f.name, text: await readText(f) };
        }
      } catch (err) {
        problems.push(t("import.badFile", { file: f.name }) + " " + errText(err).msg);
      }
    }
    if (problems.length) el("import-error").textContent = problems.join("\n");
    if (textFile && !lines.length) {
      el("import-text").value = textFile.text.length < 20000 ? textFile.text : "";
      el("import-text").placeholder = textFile.name;
      await runImport(textFile.text, "");
      return;
    }
    if (lines.length) {
      addImportLines(lines);
      await readImport();
    }
  }

  function addImportLines(lines) {
    const box = el("import-text");
    const have = box.value.split("\n").map((s) => s.trim());
    const add = lines.filter((l) => !have.includes(l.trim()));
    if (add.length) box.value = (box.value.trim() ? box.value.trim() + "\n" : "") + add.join("\n");
  }

  async function readImport() {
    const text = el("import-text").value.trim() || state.importText;
    await runImport(text, "");
  }

  async function runImport(text, password) {
    state.importText = text;
    el("import-error").textContent = "";
    const btn = password ? el("import-pw-go") : el("import-read");
    btn.disabled = true;
    try {
      let r;
      try {
        r = await C.parseImport(text, password);
      } catch (err) {
        if (err && err.name === "NeedPassword") {
          el("import-pw-title").textContent = t("import.passwordTitle", { format: err.format });
          el("import-pw").value = "";
          el("import-pw-error").textContent = "";
          showImportStep("password");
          setTimeout(() => el("import-pw").focus(), 50);
          return;
        }
        throw err;
      }
      el("import-pw").value = "";
      buildPreview(r);
    } catch (err) {
      setInlineError(password ? "import-pw-error" : "import-error", err);
    } finally {
      btn.disabled = false;
    }
  }

  function buildPreview(r) {
    const have = entries();
    const items = r.entries.map((raw, i) => {
      const e = Object.assign({}, raw);
      const it = { index: i, missing: false, problem: "", duplicate: false };
      try {
        C.normalizeEntry(e);
      } catch (err) {
        if (err && err.msg === "e.noName" && e.secret) it.missing = true;
        else it.problem = errText(err).msg;
      }
      it.duplicate = !!C.duplicateOf(have, e) || r.entries.slice(0, i).some((x) => x.secret && String(x.secret).toUpperCase().replace(/[\s=-]/g, "") === e.secret && (x.kind || "totp") === e.kind);
      it.kind = e.kind;
      it.issuer = e.issuer || "";
      it.account = e.account || "";
      it.icon = e.icon || "";
      it.details = it.problem ? "" : C.entryDetails(e);
      return it;
    });
    state.preview = { format: r.format, items, list: r.entries };
    showPreview();
  }

  function showPreview() {
    const p = state.preview;
    el("import-found").textContent = t("import.found", { n: p.items.length, format: p.format });
    const list = el("import-list");
    list.textContent = "";
    for (const it of p.items) {
      const li = make("li");
      li.dataset.index = it.index;
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = !it.duplicate && !it.problem;
      cb.disabled = !!it.problem;
      cb.setAttribute("aria-label", it.issuer || it.account || t("import.namePh"));
      cb.onchange = () => { li.classList.toggle("off", !cb.checked); updateCommit(); };
      li.appendChild(cb);
      li.appendChild(avatar({ issuer: it.issuer, account: it.account, icon: it.icon }));
      const names = make("div", "names");
      if (it.missing) {
        const iss = doc.createElement("input");
        iss.type = "text"; iss.className = "imp-issuer"; iss.placeholder = t("import.namePh");
        const acc = doc.createElement("input");
        acc.type = "text"; acc.className = "imp-account"; acc.placeholder = t("import.accountPh");
        iss.oninput = acc.oninput = updateCommit;
        names.appendChild(iss);
        names.appendChild(acc);
      } else {
        names.appendChild(make("div", "issuer", it.issuer || it.account || "?"));
        if (it.issuer && it.account) names.appendChild(make("div", "account", it.account));
        else if (it.details) names.appendChild(make("div", "account", it.details));
      }
      li.appendChild(names);
      if (it.problem) li.appendChild(make("span", "tag problem", t("import.problem") + ": " + it.problem));
      else if (it.duplicate) li.appendChild(make("span", "tag dup", t("import.dup")));
      else if (it.missing) li.appendChild(make("span", "tag missing", t("import.missing")));
      li.classList.toggle("off", !cb.checked);
      list.appendChild(li);
    }
    el("import-commit-error").textContent = "";
    showImportStep("preview");
    updateCommit();
  }

  function importChoices() {
    return [...el("import-list").children].map((li) => {
      const iss = li.querySelector(".imp-issuer"), acc = li.querySelector(".imp-account");
      return {
        index: Number(li.dataset.index),
        include: li.querySelector("input[type=checkbox]").checked,
        issuer: iss ? iss.value.trim() : "",
        account: acc ? acc.value.trim() : "",
      };
    });
  }

  function updateCommit() {
    const n = importChoices().filter((c) => c.include).length;
    el("import-commit").textContent = t("import.take", { n });
    el("import-commit").disabled = n === 0;
  }

  async function commitImport() {
    const p = state.preview;
    if (!p) return;
    const take = [];
    for (const c of importChoices()) {
      if (!c.include) continue;
      const it = p.items.find((x) => x.index === c.index);
      if (it && it.missing && !c.issuer && !c.account) { el("import-commit-error").textContent = t("entry.needName"); return; }
      const e = Object.assign({}, p.list[c.index]);
      if (c.issuer) e.issuer = c.issuer;
      if (c.account) e.account = c.account;
      take.push(e);
    }
    const btn = el("import-commit");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await addMany(take);
      if (state.s.autoIcons && r.ids.length) queueIcons(r.ids, false);
      const skipped = r.skipped + p.items.length - take.length;
      state.preview = null;
      closeDialog();
      toast(t("toast.imported", { n: r.added, s: skipped }));
      render();
      tick();
      renderBanners();
    } catch (err) {
      setInlineError("import-commit-error", err);
    } finally {
      btn.disabled = false;
    }
  }

  async function pasteIntoImport() {
    try {
      const text = await root.navigator.clipboard.readText();
      if (text && text.trim()) {
        addImportLines([text.trim()]);
        await readImport();
      } else {
        el("import-error").textContent = t("import.clipEmpty");
      }
    } catch (err) {
      el("import-error").textContent = t("import.clipDenied");
    }
  }

  /* ---------- QR-Code und Schlüssel ---------- */

  function openDetails(e) {
    el("details-name").textContent = e.issuer && e.account ? e.issuer + " · " + e.account : displayName(e);
    const uri = C.buildOTPAuth(e);
    el("details-qr").src = C.qrSVG(uri);
    el("details-qr").classList.add("details-sensitive");
    el("details-secret").textContent = e.secret.replace(/(.{4})/g, "$1 ").trim();
    el("details-uri").textContent = uri;
    el("details-copy-secret").onclick = () => copyText(e.secret);
    el("details-copy-uri").onclick = () => copyText(uri);
    openDialog("dlg-details");
  }

  function copyText(text) {
    writeClipboard(text).then((ok) => {
      if (!ok) { toast(t("toast.copyFailed"), true); return; }
      toast(state.s.clip > 0 ? t("toast.copiedClear", { s: state.s.clip }) : t("details.copied"));
      scheduleClear();
    });
  }

  /* ---------- Export ---------- */

  function openExport(kind) {
    const list = el("export-list");
    list.textContent = "";
    for (const e of C.sortEntries(entries())) {
      const li = make("li");
      const lab = make("label");
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = e.id;
      cb.onchange = updateExportCount;
      lab.appendChild(cb);
      lab.appendChild(make("span", "", displayName(e) + (e.issuer && e.account ? " · " + e.account : "")));
      li.appendChild(lab);
      list.appendChild(li);
    }
    const r = doc.querySelector("input[name=export-kind][value=" + (kind || "backup") + "]");
    if (r) r.checked = true;
    el("export-pw").value = "";
    el("export-pw2").value = "";
    el("export-error").textContent = "";
    el("export-pick").open = false;
    el("export-step-choose").hidden = false;
    el("export-step-ready").hidden = true;
    exportKindChanged();
    updateExportCount();
    openDialog("dlg-export");
  }

  function exportKind() {
    const r = doc.querySelector("input[name=export-kind]:checked");
    return r ? r.value : "backup";
  }

  function exportKindChanged() {
    const k = exportKind();
    el("export-pw-row").hidden = k !== "backup-pw";
    el("export-warn").hidden = !["aegis", "uris", "csv"].includes(k);
    el("export-go").textContent = k === "google" ? t("export.show") : t("export.make");
  }

  function exportSelection() {
    const boxes = [...el("export-list").querySelectorAll("input[type=checkbox]")];
    const on = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
    return { list: C.sortEntries(entries()).filter((e) => on.has(e.id)), total: boxes.length };
  }

  function updateExportCount() {
    const s = exportSelection();
    el("export-count").textContent = "(" + s.list.length + "/" + s.total + ")";
    el("export-go").disabled = s.list.length === 0;
  }

  async function runExport(ev) {
    ev.preventDefault();
    const k = exportKind();
    const sel = exportSelection().list;
    el("export-error").textContent = "";
    if (k === "backup-pw") {
      if ([...el("export-pw").value].length < C.MIN_PASSWORD) { el("export-error").textContent = t("lock.short"); return; }
      if (el("export-pw").value !== el("export-pw2").value) { el("export-error").textContent = t("lock.mismatch"); return; }
    }
    const btn = el("export-go");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t("lock.working");
    try {
      if (k === "google") {
        state.googleQRs = C.googleBatches(sel).map((l) => C.qrSVG(l));
        state.googleAt = 0;
        showGoogle();
        openDialog("dlg-google", true);
        return;
      }
      const day = today();
      let data, name, type;
      switch (k) {
        case "backup":
          data = C.seal({ key: state.vault.key, kdf: state.vault.kdf }, { entries: sel, saved: nowSecs() });
          name = "otp-vault-" + day + ".otpv"; type = "application/octet-stream";
          break;
        case "backup-pw": {
          const key = await C.newSealKey(el("export-pw").value);
          data = C.seal(key, { entries: sel, saved: nowSecs() });
          C.wipe(key.key);
          name = "otp-vault-" + day + ".otpv"; type = "application/octet-stream";
          break;
        }
        case "pdf":
          data = C.buildPDF(sel, { title: t("sheet.title"), subtitle: t("sheet.subtitle"), account: t("sheet.account"), warning: t("sheet.warning"), page: t("sheet.page") }, new Date());
          name = "otp-vault-sheet-" + day + ".pdf"; type = "application/pdf";
          break;
        case "aegis":
          data = C.exportAegis(sel); name = "otp-vault-" + day + ".json"; type = "application/json";
          break;
        case "uris":
          data = C.exportURIList(sel); name = "otp-vault-" + day + ".txt"; type = "text/plain";
          break;
        case "csv":
          data = C.exportCSV(sel); name = "otp-vault-" + day + ".csv"; type = "text/csv";
          break;
      }
      el("export-pw").value = "";
      el("export-pw2").value = "";
      const blob = new Blob([data], { type });
      state.exportFile = { name, blob, type, kind: k };
      showExportReady();
    } catch (err) {
      setInlineError("export-error", err);
    } finally {
      btn.disabled = false;
      exportKindChanged();
    }
  }

  function shareFile() {
    const f = state.exportFile;
    if (!f) return null;
    for (const type of [f.type, "application/octet-stream", "text/plain"]) {
      try {
        const file = new File([f.blob], f.name, { type });
        if (root.navigator.canShare && root.navigator.canShare({ files: [file] })) return file;
      } catch (e) { /* nächster Typ */ }
    }
    return null;
  }

  function showExportReady() {
    const f = state.exportFile;
    el("export-step-choose").hidden = true;
    el("export-step-ready").hidden = false;
    el("export-file").textContent = f.name;
    el("export-size").textContent = fmtSize(f.blob.size);
    el("export-ready-warn").hidden = !["aegis", "uris", "csv"].includes(f.kind);
    const canShare = !!shareFile();
    // Ein Knopf: wo das Gerät teilen kann, das Teilen-Menü (dort ist auch „In Dateien sichern“), sonst herunterladen
    el("export-save-text").textContent = t(canShare ? "export.share" : "export.download");
    el("export-save").onclick = canShare ? doShare : doDownload;
    el("export-ready-lead").textContent = t(canShare ? "export.readyShare" : "export.readyDownload");
    el("dlg-export").scrollTop = 0;
  }

  function markBackup(kind) {
    if (kind === "backup" || kind === "backup-pw") {
      LS.set("lastBackup", Date.now());
      LS.set("lastBackupSaved", state.vault ? state.vault.data.saved : 0);
      renderBanners();
    }
  }

  // Teilen-Menü des Geräts: auf dem iPhone „In Dateien sichern“, AirDrop, Mail und so weiter
  function doShare() {
    const f = state.exportFile;
    const file = shareFile();
    if (!f || !file) return;
    root.navigator.share({ files: [file], title: f.name }).then(() => {
      markBackup(f.kind);
      toast(t("toast.shared"));
    }).catch((err) => {
      if (err && err.name === "AbortError") return;
      toast(errText(err).msg, true);
    });
  }

  function doDownload() {
    const f = state.exportFile;
    if (!f) return;
    const url = URL.createObjectURL(f.blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = f.name;
    a.rel = "noopener";
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markBackup(f.kind);
    toast(t("toast.downloaded", { name: f.name }));
  }

  function showGoogle() {
    const n = state.googleQRs.length, i = state.googleAt;
    el("google-qr").src = state.googleQRs[i] || "";
    el("google-lead").textContent = t("export.googleLead", { i: i + 1, n });
    el("google-prev").hidden = n < 2;
    el("google-next").hidden = n < 2;
    el("google-prev").disabled = i === 0;
    el("google-next").disabled = i >= n - 1;
  }

  /* ---------- Hinweisleisten ---------- */

  function banner(cls, title, text, buttons) {
    const b = make("div", "banner " + (cls || ""));
    const txt = make("div", "txt");
    txt.appendChild(make("b", "", title));
    if (text) txt.appendChild(make("span", "", text));
    b.appendChild(txt);
    const row = make("div", "row");
    for (const [label, fn, primary] of buttons) {
      const btn = make("button", primary ? "primary" : "ghost", label);
      btn.type = "button";
      btn.onclick = fn;
      row.appendChild(btn);
    }
    b.appendChild(row);
    return b;
  }

  function backupDue() {
    if (!state.vault || !entries().length || !state.s.remind) return false;
    const last = LS.get("lastBackup", 0);
    if (LS.get("snooze", 0) > Date.now()) return false;
    if (!last) return true;
    const changed = state.vault.data.saved > LS.get("lastBackupSaved", 0);
    return changed && Date.now() - last > state.s.remind * 86400000;
  }

  function renderBanners() {
    const box = el("banners");
    if (!box) return;
    box.textContent = "";
    if (state.swWaiting) {
      box.appendChild(banner("", t("update.title"), t("update.text"), [[t("update.now"), applyUpdate, true]]));
    }
    if (backupDue()) {
      const last = LS.get("lastBackup", 0);
      box.appendChild(banner("warn", t(last ? "backup.dueTitle" : "backup.noneTitle"), last ? t("backup.dueText", { date: fmtDate(last) }) : t("backup.noneText"), [
        [t("backup.later"), () => { LS.set("snooze", Date.now() + 86400000); renderBanners(); }],
        [t("backup.now"), () => openExport("backup"), true],
      ]));
    }
  }

  /* ---------- Im Browser: nur die Anleitung zum Installieren ----------
     Das Programm läuft nur als installierte App. So landet der Tresor nie aus Versehen im Speicher des Browsers
     (auf dem iPhone sind Safari und die App vom Home-Bildschirm getrennt), und die Webseite selbst nimmt nichts an. */

  function platform() {
    const ua = root.navigator.userAgent;
    if (isIOS()) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? "iosOther" : "ios";
    if (/Android/i.test(ua)) return "android";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return "macSafari";
    return "desktop";
  }

  const STEP_ICONS = {
    share: "M12 3v12M8 7l4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8",
    menu: "M12 6h.01M12 12h.01M12 18h.01",
    install: "M12 4v11m0 0-4-4m4 4 4-4M4 20h16",
  };

  // Ein Schritt der Anleitung, {share} usw. wird zum passenden Symbol
  function stepItem(text) {
    const li = make("li");
    const span = make("span");
    for (const part of text.split(/(\{\w+\})/)) {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m && STEP_ICONS[m[1]]) {
        const ico = make("span", "ico");
        ico.appendChild(svgIcon(STEP_ICONS[m[1]]));
        span.appendChild(ico);
      } else if (part) {
        span.appendChild(doc.createTextNode(part));
      }
    }
    li.appendChild(span);
    return li;
  }

  function showInstall() {
    el("lock-view").hidden = true;
    el("main-view").hidden = true;
    el("install-view").hidden = false;
    const p = platform();
    const steps = {
      ios: ["inst.ios1", "inst.ios2", "inst.ios3", "inst.ios4"],
      iosOther: ["inst.ios1", "inst.ios2", "inst.ios3", "inst.ios4"],
      android: ["inst.android1", "inst.android2", "inst.android3"],
      desktop: ["inst.desktop1", "inst.desktop2"],
      macSafari: ["inst.mac1", "inst.mac2"],
      firefox: ["inst.firefox"],
    }[p];
    el("inst-title").textContent = t(p.startsWith("ios") ? "inst.titleIos" : p === "android" ? "inst.titleAndroid" : "inst.titleDesktop");
    const ol = el("inst-steps");
    ol.textContent = "";
    for (const k of steps) ol.appendChild(stepItem(t(k)));
    el("inst-button").hidden = !state.installEvent;
    el("inst-hint").textContent = p === "ios" ? t("inst.private") : p === "iosOther" ? t("inst.iosOther") + " " + t("inst.private") : "";
  }

  function promptInstall() {
    const ev = state.installEvent;
    if (!ev) return;
    state.installEvent = null;
    ev.prompt();
    ev.userChoice.then((r) => {
      if (r && r.outcome === "accepted") el("inst-done").hidden = false;
    }).finally(showInstall);
  }

  /* ---------- Updates (Service Worker) ---------- */

  let reloading = false;

  function registerSW() {
    if (!("serviceWorker" in root.navigator) || !root.isSecureContext) return;
    root.navigator.serviceWorker.register("./?action=sw", { scope: "./", updateViaCache: "none" }).then((reg) => {
      state.swReg = reg;
      const check = () => {
        if (reg.waiting && root.navigator.serviceWorker.controller) {
          state.swWaiting = true;
          renderBanners();
        }
      };
      check();
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => { if (w.state === "installed") check(); });
      });
    }).catch(() => { /* ohne Service Worker läuft die Seite trotzdem, nur nicht offline */ });
    root.navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) root.location.reload();
    });
  }

  function applyUpdate() {
    const reg = state.swReg;
    if (!reg || !reg.waiting) { root.location.reload(); return; }
    reloading = true;
    reg.waiting.postMessage("skipWaiting");
    setTimeout(() => root.location.reload(), 4000);
  }

  let lastUpdateCheck = 0;
  function checkUpdate(force) {
    if (!state.swReg || (!force && Date.now() - lastUpdateCheck < 3600000)) return Promise.resolve();
    lastUpdateCheck = Date.now();
    return state.swReg.update().catch(() => {});
  }

  async function serverInfo() {
    try {
      const r = await root.fetch("./?action=version", { cache: "no-store", credentials: "omit" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  /* ---------- Face ID / Fingerabdruck (WebAuthn mit PRF) ----------
     Ein Passkey auf diesem Gerät liefert nach Face ID ein Geheimnis (PRF). Damit wird der Tresor-Schlüssel
     verschlüsselt gespeichert. Ohne Face ID kommt niemand an diesen Schlüssel, das Passwort geht immer zusätzlich. */

  function bioName() {
    return isIOS() ? "Face ID" : t("bio.generic");
  }

  function bioPossible() {
    return !!(root.PublicKeyCredential && root.navigator.credentials && root.isSecureContext);
  }

  async function prfKey(prfOut) {
    const base = await root.crypto.subtle.importKey("raw", prfOut, "HKDF", false, ["deriveKey"]);
    return root.crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: C.utf8("OTP-PWA face unlock v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function bioEval(credId, prfSalt) {
    const a = await root.navigator.credentials.get({
      publicKey: {
        challenge: C.randomBytes(32), rpId: root.location.hostname, timeout: 60000, userVerification: "required",
        allowCredentials: [{ type: "public-key", id: credId, transports: ["internal", "hybrid"] }],
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const r = a && a.getClientExtensionResults ? a.getClientExtensionResults().prf : null;
    if (!r || !r.results || !r.results.first) throw new C.UserError("e.bioNoPrf", "h.bioNoPrf");
    return new Uint8Array(r.results.first);
  }

  async function bioStore(credId, prfSalt, prfOut) {
    const k = await prfKey(prfOut);
    const iv = C.randomBytes(12);
    const ad = C.utf8(state.vault.kdf.salt);
    const ct = new Uint8Array(await root.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, k, state.vault.key));
    const bio = { v: 1, id: C.b64encode(credId), salt: C.b64encode(prfSalt), iv: C.b64encode(iv), ct: C.b64encode(ct), kdfSalt: state.vault.kdf.salt, at: Date.now() };
    await DB.put({ bio });
    state.bio = bio;
    state.bioPending = null;
  }

  // Einrichten: Passkey anlegen, dann das PRF-Geheimnis holen (manche Geräte liefern es gleich mit)
  async function bioSetup() {
    const prfSalt = C.randomBytes(32);
    const cred = await root.navigator.credentials.create({
      publicKey: {
        rp: { name: "OTP-PWA", id: root.location.hostname },
        user: { id: C.randomBytes(16), name: "OTP-PWA " + root.location.hostname, displayName: "OTP-PWA" },
        challenge: C.randomBytes(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 60000, attestation: "none",
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    if (!ext.prf || ext.prf.enabled === false) throw new C.UserError("e.bioNoPrf", "h.bioNoPrf");
    const credId = new Uint8Array(cred.rawId);
    const first = ext.prf.results && ext.prf.results.first;
    if (first) {
      await bioStore(credId, prfSalt, new Uint8Array(first));
      return true;
    }
    state.bioPending = { credId, prfSalt };
    try {
      await bioStore(credId, prfSalt, await bioEval(credId, prfSalt));
      return true;
    } catch (err) {
      if (err && err.name === "NotAllowedError") return false; // noch einmal tippen (eigener Knopf)
      state.bioPending = null;
      throw err;
    }
  }

  async function bioFinish() {
    const p = state.bioPending;
    if (!p) return;
    try {
      await bioStore(p.credId, p.prfSalt, await bioEval(p.credId, p.prfSalt));
      toast(t("bio.on", { name: bioName() }));
    } catch (err) {
      showError(err);
    }
    renderBio();
  }

  async function bioOff() {
    await DB.put({ bio: null });
    state.bio = null;
    state.bioPending = null;
  }

  async function bioUnlock(auto) {
    const b = state.bio;
    if (!b || state.vault) return;
    const btn = el("lock-bio");
    btn.disabled = true;
    el("lock-error").textContent = "";
    try {
      const raw = await DB.get("vault");
      const f = C.readSealed(raw);
      if (f.kdf.salt !== b.kdfSalt) {
        await bioOff();
        throw new C.UserError("e.bioStale", "h.bioStale");
      }
      const out = await bioEval(C.b64decode(b.id), C.b64decode(b.salt));
      const k = await prfKey(out);
      let key;
      try {
        key = new Uint8Array(await root.crypto.subtle.decrypt({ name: "AES-GCM", iv: C.b64decode(b.iv), additionalData: C.utf8(b.kdfSalt) }, k, C.b64decode(b.ct)));
      } catch (e) {
        throw new C.UserError("e.bioStale", "h.bioStale");
      }
      const data = C.openWithKey(f, { key, kdf: f.kdf });
      state.vault = { key, kdf: f.kdf, data };
      enterVault();
    } catch (err) {
      if (!auto || !(err && (err.name === "NotAllowedError" || err.name === "AbortError" || err.name === "SecurityError"))) setInlineError("lock-error", err);
      showLock();
    } finally {
      btn.disabled = false;
    }
  }

  async function renderBio() {
    const box = el("bio-box");
    const name = bioName();
    el("set-bio-label").textContent = t("bio.toggle", { name });
    el("set-bio").checked = !!state.bio;
    el("set-bio-finish").hidden = !state.bioPending;
    el("set-bio-finish").textContent = t("bio.finish", { name });
    let possible = bioPossible();
    if (possible) {
      try { possible = await root.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { possible = false; }
    }
    el("set-bio").disabled = !possible && !state.bio;
    el("set-bio-hint").textContent = !possible && !state.bio ? t("bio.unavailable", { name }) : state.bio ? t("bio.onHint", { name }) : t("bio.offHint", { name });
    box.hidden = false;
  }

  async function bioToggle() {
    const box = el("set-bio");
    const on = box.checked;
    box.disabled = true;
    try {
      if (on) {
        const done = await bioSetup();
        if (done) toast(t("bio.on", { name: bioName() }));
      } else {
        await bioOff();
        toast(t("bio.off", { name: bioName() }));
      }
    } catch (err) {
      showError(err);
    }
    box.disabled = false;
    renderBio();
  }

  /* ---------- Einstellungen ---------- */

  function saveSettings(patch) {
    Object.assign(state.s, patch);
    LS.set("settings", state.s);
    applyTheme();
    if (patch.lang) {
      state.lang = state.s.lang;
      applyTexts();
      if (!el("dlg-settings").hidden) fillSettings();
    } else if (state.vault) {
      render();
      tick();
    }
    renderBanners();
  }

  function fillSelects() {
    const opts = (id, values, labelOf) => {
      const sel = el(id);
      const cur = sel.value;
      sel.textContent = "";
      for (const v of values) {
        const o = make("option", "", labelOf(v));
        o.value = String(v);
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
    };
    opts("set-autolock", [1, 2, 5, 10, 15, 30, 60, 0], (m) => (m === 0 ? t("settings.never") : m === 1 ? t("settings.minute") : t("settings.minutes", { n: m })));
    opts("set-leavelock", [0, 10, 30, 60, 300, 900, -1], (s) => (s === -1 ? t("settings.never") : s === 0 ? t("settings.immediately") : s < 60 ? t("settings.seconds", { n: s }) : s === 60 ? t("settings.minute") : t("settings.minutes", { n: s / 60 })));
    opts("set-clipboard", [10, 20, 30, 45, 60, 120, 0], (s) => (s === 0 ? t("settings.never") : t("settings.seconds", { n: s })));
    opts("set-remind", [7, 14, 30, 60, 90, 0], (d) => (d === 0 ? t("settings.never") : t("settings.days", { n: d })));
  }

  function palButtons(mode) {
    const row = el(mode === "dark" ? "pals-dark" : "pals-light");
    row.textContent = "";
    row.setAttribute("aria-label", t(mode === "dark" ? "settings.palDark" : "settings.palLight"));
    const pk = mode === "dark" ? "palD" : "palL", ck = mode === "dark" ? "custD" : "custL";
    const cur = state.s[pk];
    const add = (id, name, cols) => {
      const b = make("button", "pal");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(cur === id && (id !== "own" || !!okCols(state.s[ck]))));
      const dot = make("span", "dot");
      const i = make("i");
      if (cols) i.style.background = "linear-gradient(135deg, " + cols.bar + " 0 50%, " + cols.hi + " 50% 100%)";
      else dot.appendChild(svgIcon("M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"));
      if (cols) dot.appendChild(i);
      b.appendChild(dot);
      b.appendChild(make("span", "", name));
      b.onclick = () => {
        if (id === "own") {
          const start = okCols(state.s[ck]) || Object.assign({}, colorsFor(mode));
          saveSettings({ [ck]: start, [pk]: "own" });
          openMixer(mode);
        } else {
          saveSettings({ [pk]: id });
        }
        palButtons(mode);
      };
      row.appendChild(b);
    };
    for (const [id, cols] of Object.entries(PALS[mode])) add(id, t("pal." + id), cols);
    add("own", t("pal.own"), okCols(state.s[ck]));
  }

  async function fillSettings() {
    const s = state.s;
    el("set-mode").value = s.mode;
    palButtons("light");
    palButtons("dark");
    el("set-fs").value = String(s.fs);
    el("set-fs-val").textContent = s.fs + " %";
    el("set-cs").value = String(s.cs);
    el("set-cs-val").textContent = s.cs + " %";
    el("set-compact").checked = s.compact;
    el("set-autoicons").checked = s.autoIcons;
    el("set-next").checked = s.showNext;
    el("set-hidecodes").checked = s.hideCodes;
    el("set-autolock").value = String(s.autoLock);
    el("set-leavelock").value = String(s.leaveLock);
    el("set-clipboard").value = String(s.clip);
    el("set-remind").value = String(s.remind);
    const last = LS.get("lastBackup", 0);
    el("set-lastbackup").textContent = last ? t("settings.lastBackup", { date: fmtDate(last) }) : t("settings.noBackup");
    el("set-version").textContent = t("settings.version", { v: state.version });
    el("pw-old").value = el("pw-new").value = el("pw-new2").value = "";
    el("pw-error").textContent = "";
    renderBio();
    // Speicher: dauerhaft? wie viel belegt?
    let storage = t("settings.storageUnknown");
    try {
      const nav = root.navigator.storage;
      if (nav && nav.persisted) {
        const p = await nav.persisted();
        storage = t(p ? "settings.storagePersist" : "settings.storageBest");
      }
      if (nav && nav.estimate) {
        const e = await nav.estimate();
        if (e && e.usage) storage += " " + t("settings.storageUsed", { size: fmtSize(e.usage) });
      }
    } catch (e) { /* bleibt bei „unbekannt“ */ }
    el("set-storage").textContent = storage;
    el("set-server").textContent = "";
    serverInfo().then((info) => {
      if (!info || el("dlg-settings").hidden) return;
      let txt = t("settings.serverVersion", { v: info.version });
      if (info.latest && info.newer) txt += " " + t("settings.serverNewer", { v: info.latest });
      if (info.error) txt += " " + t("settings.serverError", { msg: info.error });
      el("set-server").textContent = txt;
    });
  }

  function openSettings() {
    fillSettings();
    openDialog("dlg-settings");
  }

  async function changePassword(ev) {
    ev.preventDefault();
    const oldPw = el("pw-old").value, nw = el("pw-new").value;
    el("pw-error").textContent = "";
    if ([...nw].length < C.MIN_PASSWORD) { el("pw-error").textContent = t("lock.short"); return; }
    if (nw !== el("pw-new2").value) { el("pw-error").textContent = t("lock.mismatch"); return; }
    const btn = el("pw-submit");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t("lock.working");
    try {
      const check = await C.deriveKey(oldPw, state.vault.kdf);
      const same = C.sameBytes(check.key, state.vault.key);
      C.wipe(check.key);
      if (!same) throw new C.UserError("e.oldPwWrong", "h.oldPwWrong");
      const k = await C.newSealKey(nw);
      const raw = C.seal(k, Object.assign({}, state.vault.data, { saved: nowSecs() }));
      // Der vorige Stand ist noch mit dem alten Passwort verschlüsselt: er wird gleich mit ersetzt, Face ID passt auch nicht mehr
      await DB.put({ vault: raw, vault_bak: raw, bio: null });
      C.wipe(state.vault.key);
      state.vault.key = k.key;
      state.vault.kdf = k.kdf;
      const hadBio = !!state.bio;
      state.bio = null;
      el("pw-old").value = el("pw-new").value = el("pw-new2").value = "";
      toast(t(hadBio ? "toast.pwChangedBio" : "toast.pwChanged", { name: bioName() }));
      renderBio();
    } catch (err) {
      setInlineError("pw-error", err);
    } finally {
      btn.disabled = false;
      btn.textContent = t("settings.changePw");
    }
  }

  /* ---------- Farbmischer ---------- */



  function openMixer(mode) {
    const ck = mode === "dark" ? "custD" : "custL";
    mixer.mode = mode;
    mixer.col = Object.assign({}, okCols(state.s[ck]) || colorsFor(mode));
    mixer.start = Object.assign({}, mixer.col);
    mixer.part = "acc";
    for (const k of PARTS) mixer.hsl[k] = hex2hsl(mixer.col[k]);
    el("mixer-title").textContent = t(mode === "dark" ? "mixer.titleDark" : "mixer.titleLight");
    const parts = el("mixer-parts");
    parts.textContent = "";
    for (const k of PARTS) {
      const b = make("button", "seg");
      b.type = "button";
      b.dataset.part = k;
      b.appendChild(make("i"));
      b.appendChild(doc.createTextNode(t("mixer." + k)));
      b.onclick = () => { mixer.part = k; showMixer(); };
      parts.appendChild(b);
    }
    const base = el("mix-base");
    base.textContent = "";
    base.appendChild(make("option", "", t("mixer.base")));
    base.firstChild.value = "";
    for (const m of ["light", "dark"]) {
      const g = doc.createElement("optgroup");
      g.label = t(m === "dark" ? "settings.modeDark" : "settings.modeLight");
      for (const id of Object.keys(PALS[m])) {
        const o = make("option", "", t("pal." + id));
        o.value = m + ":" + id;
        g.appendChild(o);
      }
      base.appendChild(g);
    }
    mixer.open = true;
    openDialog("dlg-mixer", true);
    showMixer();
  }

  function showMixer() {
    const col = mixer.col;
    setVars(el("mix-preview"), derive(col));
    const p = el("mix-preview");
    const v = derive(col);
    p.querySelector(".mp-bar").style.background = v["--bar"];
    p.querySelector(".mp-bar").style.color = v["--bar-text"];
    p.querySelector(".mp-dot").style.background = v["--hi"];
    p.querySelector(".mp-tool").style.background = v["--hi"];
    p.querySelector(".mp-tool").style.color = v["--hi-text"];
    p.querySelector(".mp-body").style.background = v["--bg"];
    p.querySelector(".mp-card").style.background = v["--card"];
    p.querySelector(".mp-card").style.borderColor = v["--line"];
    p.querySelector(".mp-card").style.color = v["--text"];
    p.querySelector(".mp-head small").style.color = v["--mut"];
    p.querySelector(".mp-ava").style.background = v["--acc"];
    p.querySelector(".mp-code").style.color = v["--code"];
    p.querySelector(".mp-ring").style.borderColor = v["--acc"];
    p.querySelector(".mp-foot").style.color = v["--mut"];
    const btns = p.querySelectorAll(".mp-btn");
    btns[0].style.background = v["--card"]; btns[0].style.color = v["--text"]; btns[0].style.borderColor = v["--line"];
    btns[1].style.background = v["--acc"]; btns[1].style.color = v["--acc-text"];
    el("mixer-parts").querySelectorAll(".seg").forEach((b) => {
      b.firstChild.style.setProperty("--c", col[b.dataset.part]);
      b.setAttribute("aria-pressed", String(b.dataset.part === mixer.part));
    });
    const [h, s, l] = mixer.hsl[mixer.part];
    el("mix-h").value = h; el("mix-s").value = s; el("mix-l").value = l;
    const sl = el("mixer-sliders");
    sl.style.setProperty("--h", h); sl.style.setProperty("--s", s + "%"); sl.style.setProperty("--l", l + "%");
    el("mix-picker").value = col[mixer.part];
    el("mix-hex").value = col[mixer.part];
    // Warnen, wenn Schrift auf ihrem Untergrund schlecht zu lesen ist
    const pairs = [["text", "bg"], ["text", "card"], ["code", "card"]];
    const bad = pairs.filter(([a, b]) => contrast(col[a], col[b]) < 3).map(([a]) => t("mixer." + a));
    el("mix-warn").textContent = bad.length ? t("mixer.hard", { list: [...new Set(bad)].join(", ") }) : "";
    const ck = mixer.mode === "dark" ? "custD" : "custL", pk = mixer.mode === "dark" ? "palD" : "palL";
    saveSettings({ [ck]: Object.assign({}, col), [pk]: "own" });
  }

  function mixerSet(hex) {
    mixer.col[mixer.part] = hex;
    showMixer();
  }

  /* ---------- automatisch sperren ---------- */

  function activity() {
    state.lastActive = Date.now();
  }

  function autoLockCheck() {
    if (!state.vault) return;
    const m = state.s.autoLock;
    if (m > 0 && Date.now() - state.lastActive > m * 60000) lock();
  }

  function visibilityChanged() {
    if (doc.hidden) {
      state.hiddenAt = Date.now();
      doc.body.classList.add("away");
      clearTimeout(state.tickTimer);
      if (state.vault && state.s.leaveLock === 0) lock(true);
      return;
    }
    doc.body.classList.remove("away");
    const away = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
    state.hiddenAt = 0;
    if (state.vault && state.s.leaveLock >= 0 && away >= state.s.leaveLock * 1000) lock(true);
    else if (state.vault) { autoLockCheck(); tick(); }
    checkUpdate(false);
  }

  /* ---------- Verdrahtung ---------- */

  function wire() {
    el("lock-form").addEventListener("submit", submitLock);
    el("lock-pw").addEventListener("input", updateMeter);
    el("lock-eye").onclick = () => {
      const show = el("lock-pw").type === "password";
      el("lock-pw").type = el("lock-pw2").type = show ? "text" : "password";
      el("lock-eye").textContent = show ? t("lock.hide") : t("lock.show");
    };
    for (const id of ["lock-pw", "lock-pw2"]) {
      el(id).addEventListener("keyup", (ev) => {
        if (ev.getModifierState && ev.getModifierState("CapsLock")) el("lock-hint").textContent = t("lock.caps");
        else updateMeter();
      });
    }
    el("lock-bio").onclick = () => bioUnlock(false);
    el("lock-restore").onclick = () => { el("restore-file").value = ""; el("restore-file").click(); };
    el("restore-file").addEventListener("change", restoreFileChosen);
    el("dlg-restore").addEventListener("submit", submitRestore);
    el("restore-cancel").onclick = () => { state.restoreRaw = ""; closeDialog(); };
    el("lock-reset").onclick = () => wipeAll(true);
    doc.querySelectorAll("[data-lang]").forEach((b) => { b.onclick = () => saveSettings({ lang: b.dataset.lang }); });

    el("search").addEventListener("input", () => { state.query = el("search").value.trim(); render(); tick(); });
    el("search").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const first = doc.querySelector(".card .code");
        if (first) first.click();
        el("search").blur();
      }
    });
    el("btn-add").onclick = () => openEntry(null);
    el("empty-add").onclick = () => openEntry(null);
    el("btn-import").onclick = () => openImport("");
    el("empty-import").onclick = () => openImport("");
    el("btn-export").onclick = () => openExport("backup");
    el("btn-settings").onclick = openSettings;
    el("btn-lock").onclick = () => lock();

    el("card-menu").querySelectorAll("button[data-act]").forEach((b) => { b.onclick = () => menuAction(b.dataset.act); });
    el("icon-file").addEventListener("change", iconFileChosen);
    doc.addEventListener("click", (ev) => {
      if (!el("card-menu").hidden && !el("card-menu").contains(ev.target)) closeMenu();
    });
    // Beim Wegscrollen schließen, aber nicht vom Scrollen, das gerade erst zum Antippen geführt hat
    root.addEventListener("scroll", () => { if (Date.now() - menuOpenedAt > 400) closeMenu(); }, { passive: true });

    el("dlg-entry").addEventListener("submit", saveEntry);
    el("entry-cancel").onclick = closeDialog;
    el("entry-secret").addEventListener("input", secretChanged);
    el("entry-kind").addEventListener("change", kindChanged);
    el("entry-qr").onclick = () => { el("import-file").dataset.target = "entry"; el("import-file").accept = "image/*"; el("import-file").value = ""; el("import-file").click(); };
    el("entry-scan").onclick = () => openScanner((text) => { el("entry-secret").value = text; parseSecret(); }, false);

    el("details-close").onclick = closeDialog;

    el("import-cancel").onclick = closeDialog;
    el("import-read").onclick = readImport;
    el("import-paste").onclick = pasteIntoImport;
    el("import-scan").onclick = () => openScanner((text) => { addImportLines([text]); }, true);
    el("import-choose").onclick = () => { el("import-file").dataset.target = "import"; el("import-file").accept = ""; el("import-file").value = ""; el("import-file").click(); };
    el("import-file").addEventListener("change", async () => {
      const files = [...el("import-file").files];
      if (el("import-file").dataset.target === "entry") {
        const f = files[0];
        if (!f) return;
        const data = await decodeImage(f).catch(() => null);
        if (data) { el("entry-secret").value = data; parseSecret(); }
        else el("entry-error").textContent = t("import.noQr", { file: f.name });
        return;
      }
      importFiles(files);
    });
    el("import-step-password").addEventListener("submit", (ev) => { ev.preventDefault(); runImport(state.importText, el("import-pw").value); });
    el("import-pw-back").onclick = () => showImportStep("input");
    el("import-back").onclick = () => { state.preview = null; showImportStep("input"); };
    el("import-commit").onclick = commitImport;
    el("import-all").onclick = () => { el("import-list").querySelectorAll("li").forEach((li) => { const c = li.querySelector("input[type=checkbox]"); if (!c.disabled) { c.checked = true; li.classList.remove("off"); } }); updateCommit(); };
    el("import-none").onclick = () => { el("import-list").querySelectorAll("li").forEach((li) => { li.querySelector("input[type=checkbox]").checked = false; li.classList.add("off"); }); updateCommit(); };
    const drop = el("import-drop");
    drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (ev) => { ev.preventDefault(); drop.classList.remove("over"); importFiles([...ev.dataTransfer.files]); });

    el("scan-done").onclick = () => {
      const multiImport = scan.multi;
      stopScanner();
      closeDialog();
      if (multiImport && el("import-text").value.trim()) readImport();
    };
    el("scan-image").onclick = () => {
      const multi = scan.multi;
      stopScanner();
      closeDialog();
      el("import-file").dataset.target = multi ? "import" : "entry";
      el("import-file").accept = "image/*";
      el("import-file").value = "";
      el("import-file").click();
    };

    el("export-step-choose").addEventListener("submit", runExport);
    el("export-cancel").onclick = closeDialog;
    doc.querySelectorAll("input[name=export-kind]").forEach((r) => r.addEventListener("change", exportKindChanged));
    el("export-all").onclick = () => { el("export-list").querySelectorAll("input").forEach((c) => { c.checked = true; }); updateExportCount(); };
    el("export-none").onclick = () => { el("export-list").querySelectorAll("input").forEach((c) => { c.checked = false; }); updateExportCount(); };
    el("export-back").onclick = () => { state.exportFile = null; el("export-step-ready").hidden = true; el("export-step-choose").hidden = false; };
    el("export-done").onclick = closeDialog;
    el("google-prev").onclick = () => { state.googleAt--; showGoogle(); };
    el("google-next").onclick = () => { state.googleAt++; showGoogle(); };
    el("google-close").onclick = closeDialog;

    el("settings-close").onclick = closeDialog;
    el("set-mode").onchange = () => { saveSettings({ mode: el("set-mode").value }); };
    el("set-fs").oninput = () => { el("set-fs-val").textContent = el("set-fs").value + " %"; saveSettings({ fs: Number(el("set-fs").value) }); };
    el("set-cs").oninput = () => { el("set-cs-val").textContent = el("set-cs").value + " %"; saveSettings({ cs: Number(el("set-cs").value) }); };
    el("set-compact").onchange = () => saveSettings({ compact: el("set-compact").checked });
    el("set-autoicons").onchange = () => saveSettings({ autoIcons: el("set-autoicons").checked });
    el("set-fetchicons").onclick = () => {
      const missing = entries().filter((e) => !e.icon).map((e) => e.id);
      if (!missing.length) { toast(t("toast.iconsAll")); return; }
      toast(t("toast.iconsRunning", { n: missing.length }));
      queueIcons(missing, true);
    };
    el("dlg-icon").addEventListener("submit", iconFromSite);
    el("icon-file-btn").onclick = () => { el("icon-file").value = ""; el("icon-file").click(); };
    el("icon-remove").onclick = () => setIcon(state.iconFor, "", null).catch((err) => setInlineError("icon-error", err));
    el("icon-done").onclick = closeDialog;
    el("set-next").onchange = () => saveSettings({ showNext: el("set-next").checked });
    el("set-hidecodes").onchange = () => saveSettings({ hideCodes: el("set-hidecodes").checked });
    el("set-autolock").onchange = () => saveSettings({ autoLock: Number(el("set-autolock").value) });
    el("set-leavelock").onchange = () => saveSettings({ leaveLock: Number(el("set-leavelock").value) });
    el("set-clipboard").onchange = () => saveSettings({ clip: Number(el("set-clipboard").value) });
    el("set-remind").onchange = () => saveSettings({ remind: Number(el("set-remind").value) });
    el("set-backup-now").onclick = () => openExport("backup");
    el("set-bio").onchange = bioToggle;
    el("set-bio-finish").onclick = bioFinish;
    el("pw-form").addEventListener("submit", changePassword);
    el("set-wipe").onclick = () => wipeAll(false);
    el("set-update").onclick = async () => {
      el("set-update").disabled = true;
      await checkUpdate(true);
      setTimeout(() => {
        el("set-update").disabled = false;
        if (state.swWaiting) { closeDialog(); renderBanners(); }
        else toast(t("update.none"));
      }, 1500);
    };

    el("mix-h").oninput = () => { mixer.hsl[mixer.part][0] = Number(el("mix-h").value); mixerSet(hsl2hex(mixer.hsl[mixer.part])); };
    el("mix-s").oninput = () => { mixer.hsl[mixer.part][1] = Number(el("mix-s").value); mixerSet(hsl2hex(mixer.hsl[mixer.part])); };
    el("mix-l").oninput = () => { mixer.hsl[mixer.part][2] = Number(el("mix-l").value); mixerSet(hsl2hex(mixer.hsl[mixer.part])); };
    el("mix-picker").oninput = () => { const v = el("mix-picker").value.toLowerCase(); mixer.hsl[mixer.part] = hex2hsl(v); mixerSet(v); };
    el("mix-hex").onchange = () => {
      let v = el("mix-hex").value.trim().toLowerCase().replace(/^#/, "");
      if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/./g, "$&$&");
      if (/^[0-9a-f]{6}$/.test(v)) { mixer.hsl[mixer.part] = hex2hsl("#" + v); mixerSet("#" + v); } else showMixer();
    };
    el("mix-base").onchange = () => {
      const [m, id] = el("mix-base").value.split(":");
      el("mix-base").value = "";
      if (!PALS[m] || !PALS[m][id]) return;
      mixer.col = Object.assign({}, PALS[m][id]);
      for (const k of PARTS) mixer.hsl[k] = hex2hsl(mixer.col[k]);
      showMixer();
    };
    el("mix-reset").onclick = () => {
      mixer.col = Object.assign({}, mixer.start);
      for (const k of PARTS) mixer.hsl[k] = hex2hsl(mixer.col[k]);
      showMixer();
    };
    el("mix-done").onclick = closeDialog;

    el("confirm-yes").onclick = () => { closeDialog(); if (confirmResolve) confirmResolve(true); confirmResolve = null; };
    el("confirm-no").onclick = () => { closeDialog(); if (confirmResolve) confirmResolve(false); confirmResolve = null; };
    el("error-ok").onclick = closeDialog;
    el("overlay").addEventListener("pointerdown", (ev) => {
      if (ev.target !== el("overlay")) return;
      if (!el("dlg-confirm").hidden && confirmResolve) { confirmResolve(false); confirmResolve = null; }
      closeDialog();
    });

    doc.addEventListener("keydown", (ev) => {
      activity();
      if (ev.key === "Escape") {
        if (!el("card-menu").hidden) closeMenu();
        else if (!el("overlay").hidden) {
          if (!el("dlg-confirm").hidden && confirmResolve) { confirmResolve(false); confirmResolve = null; }
          closeDialog();
        } else if (state.query) { el("search").value = ""; state.query = ""; render(); tick(); }
        return;
      }
      if (!state.vault || !el("overlay").hidden) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === "f") { ev.preventDefault(); el("search").focus(); }
      if (mod && ev.key.toLowerCase() === "l") { ev.preventDefault(); lock(); }
    });
    for (const evName of ["pointerdown", "touchstart", "scroll", "input"]) doc.addEventListener(evName, activity, { passive: true, capture: true });
    setInterval(autoLockCheck, 15000);
    doc.addEventListener("visibilitychange", visibilityChanged);
    darkMq.addEventListener("change", () => { applyTheme(); });

    // Screenshot eines QR-Codes einfügen (am Rechner): geht in den Import
    doc.addEventListener("paste", (ev) => {
      if (!state.vault) return;
      const files = [...(ev.clipboardData ? ev.clipboardData.files : [])].filter(isImage);
      if (!files.length) return;
      ev.preventDefault();
      if (el("dlg-import").hidden) openImport("");
      importFiles(files);
    });
    doc.addEventListener("dragover", (ev) => { if (state.vault) ev.preventDefault(); });
    doc.addEventListener("drop", (ev) => {
      if (!state.vault || ev.defaultPrevented) return;
      ev.preventDefault();
      const files = [...ev.dataTransfer.files];
      if (!files.length) return;
      if (el("dlg-import").hidden) openImport("");
      importFiles(files);
    });

    root.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      state.installEvent = ev;
      if (!el("install-view").hidden) showInstall();
    });
    root.addEventListener("appinstalled", () => {
      state.installEvent = null;
      el("inst-done").hidden = false;
      if (!el("install-view").hidden) showInstall();
    });
    el("inst-button").onclick = promptInstall;
  }

  async function start() {
    state.s = Object.assign({}, DEFAULTS, LS.get("settings", {}));
    state.lang = state.s.lang || (/^de\b/i.test((root.navigator.languages && root.navigator.languages[0]) || root.navigator.language || "") ? "de" : "en");
    applyTheme();
    wire();
    applyTexts();
    registerSW();
    // Im Browser nur die Anleitung, das Programm gibt es erst als installierte App
    if (!isStandalone()) {
      showInstall();
      return;
    }
    try {
      state.hasVault = !!(await DB.get("vault"));
      state.bio = await DB.get("bio");
    } catch (err) {
      showLock();
      el("lock-error").textContent = t("e.noStorage") + "\n" + t("h.noStorage");
      return;
    }
    showLock();
    if (state.hasVault && state.bio && state.s.bioAuto && !doc.hidden) bioUnlock(true);
    else if (!isIOS()) setTimeout(() => el("lock-pw").focus(), 60);
  }

  root.OPApp = { t, errText, groupCode, ringOffset, strength, matches, hue, derive, contrast, hex2hsl, hsl2hex, PALS, PARTS, TEXTS, state };
  if (doc && doc.addEventListener && doc.getElementById("lock-view")) doc.addEventListener("DOMContentLoaded", start);
})(typeof window !== "undefined" ? window : globalThis);
