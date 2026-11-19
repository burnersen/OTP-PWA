<?php
/* OTP-PWA – die App-Seite. Wird einmal vom Server geholt und dann vom Service Worker vorgehalten,
   danach läuft alles nur noch auf dem Gerät. Texte setzt app.js (i18n.js), hier stehen nur Schlüssel. */
defined('OP_VERSION') || exit;
$asset = function (string $f): string { return '?action=asset&amp;f=' . $f . '&amp;v=' . OP_VERSION; };
?><!DOCTYPE html>
<html lang="de" data-version="<?php echo opH(OP_VERSION); ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#1c3f78">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="OTP">
<title>OTP-PWA</title>
<link rel="manifest" href="?action=manifest">
<link rel="icon" type="image/png" href="<?php echo $asset('favicon.png'); ?>">
<link rel="apple-touch-icon" href="<?php echo $asset('icon-180.png'); ?>">
<link rel="stylesheet" href="<?php echo $asset('app.css'); ?>">
<script src="<?php echo $asset('boot.js'); ?>"></script>
</head>
<body>
  <!-- Sperrbildschirm: Tresor anlegen, entsperren oder aus einer Sicherung holen -->
  <section id="lock-view" class="lock-view" hidden>
    <div class="lock-lang lang" role="group" data-i18n-label="lang.label">
      <button type="button" data-lang="de">DE</button>
      <button type="button" data-lang="en">EN</button>
    </div>
    <div class="lock-wrap">
      <form id="lock-form" class="lock-card" autocomplete="off">
        <img src="<?php echo $asset('logo.png'); ?>" alt="" width="76" height="76" class="lock-logo">
        <h1 id="lock-title"></h1>
        <p id="lock-lead" class="muted"></p>
        <p id="lock-ios" class="warn-box" hidden></p>
        <input type="text" name="username" autocomplete="username" value="OTP-PWA" hidden>
        <label class="field">
          <span data-i18n="lock.password"></span>
          <span class="pw-wrap">
            <input id="lock-pw" type="password" autocomplete="current-password" spellcheck="false" autocapitalize="off" enterkeyhint="go">
            <button type="button" class="pw-eye" id="lock-eye"></button>
          </span>
        </label>
        <label class="field" id="lock-pw2-row" hidden>
          <span data-i18n="lock.password2"></span>
          <input id="lock-pw2" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off">
        </label>
        <div class="meter" id="lock-meter" hidden><div class="meter-bar" id="lock-meter-bar"></div></div>
        <p class="hint" id="lock-hint"></p>
        <p class="error-text" id="lock-error" role="alert"></p>
        <button type="submit" class="primary big wide" id="lock-submit"></button>
        <button type="button" class="ghost big wide bio-btn" id="lock-bio" hidden>
          <svg viewBox="0 0 24 24"><path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2M9 9v1M15 9v1M12 9v4h-1M9 16c1.7 1.3 4.3 1.3 6 0"/></svg>
          <span id="lock-bio-text"></span>
        </button>
        <div class="lock-links">
          <button type="button" class="link" id="lock-restore" data-i18n="lock.restore"></button>
          <button type="button" class="link danger-text" id="lock-reset" data-i18n="lock.reset"></button>
        </div>
      </form>
      <div id="lock-install" class="install-card" hidden></div>
    </div>
  </section>

  <!-- Hauptansicht: die Konten -->
  <section id="main-view" class="main-view" hidden>
    <header class="topbar">
      <div class="bar-row">
        <div class="brand">
          <img src="<?php echo $asset('logo.png'); ?>" alt="" width="34" height="34">
          <div>
            <div class="brand-name">OTP-PWA</div>
            <div class="brand-tag" id="count-label"></div>
          </div>
        </div>
        <nav class="actions">
          <button type="button" class="tool accent" id="btn-add" data-i18n-label="top.add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span data-i18n="top.add"></span></button>
          <button type="button" class="tool" id="btn-import" data-i18n-label="top.import"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3"/></svg><span data-i18n="top.import"></span></button>
          <button type="button" class="tool" id="btn-export" data-i18n-label="top.export"><svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L8 7m4-4 4 4M4 17v3h16v-3"/></svg><span data-i18n="top.export"></span></button>
          <button type="button" class="tool icon-only" id="btn-settings" data-i18n-label="top.settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg></button>
          <button type="button" class="tool icon-only" id="btn-lock" data-i18n-label="top.lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></button>
        </nav>
      </div>
      <div class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/></svg>
        <input id="search" type="search" data-i18n-ph="top.search" spellcheck="false" autocomplete="off" autocapitalize="off" enterkeyhint="search">
      </div>
    </header>
    <div id="banners" class="banners"></div>
    <main id="list-area" class="list-area">
      <div id="empty" class="empty" hidden>
        <img src="<?php echo $asset('logo.png'); ?>" alt="" width="88" height="88">
        <h2 data-i18n="list.empty"></h2>
        <p class="muted" data-i18n="list.emptyLead"></p>
        <div class="row center wrap">
          <button type="button" class="primary" id="empty-add" data-i18n="top.add"></button>
          <button type="button" class="ghost" id="empty-import" data-i18n="top.import"></button>
        </div>
      </div>
      <p id="no-match" class="muted center" hidden></p>
      <div id="cards" class="cards"></div>
    </main>
  </section>

  <!-- Menü einer Karte -->
  <div id="card-menu" class="menu" role="menu" hidden>
    <button type="button" data-act="edit" data-i18n="card.edit"></button>
    <button type="button" data-act="details" data-i18n="card.details"></button>
    <button type="button" data-act="iconFile" data-i18n="card.iconFile"></button>
    <button type="button" data-act="iconRemove" data-i18n="card.iconRemove"></button>
    <hr>
    <button type="button" data-act="delete" class="danger" data-i18n="card.delete"></button>
  </div>
  <input type="file" id="icon-file" accept="image/*,.ico" hidden>
  <input type="file" id="import-file" multiple hidden>
  <input type="file" id="restore-file" hidden>

  <!-- Dialoge -->
  <div id="overlay" class="overlay" hidden>

    <form id="dlg-entry" class="dialog" hidden autocomplete="off">
      <h2 id="entry-title"></h2>
      <label class="field">
        <span data-i18n="entry.secret"></span>
        <span class="pw-wrap two">
          <input id="entry-secret" type="text" spellcheck="false" autocapitalize="characters" autocorrect="off" class="mono">
          <button type="button" class="pw-eye" id="entry-scan" data-i18n-label="entry.scan"><svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/></svg></button>
          <button type="button" class="pw-eye" id="entry-qr" data-i18n-label="entry.qrImage"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg></button>
        </span>
        <small class="hint" id="entry-secret-hint"></small>
      </label>
      <p class="note" id="entry-parsed" hidden></p>
      <div class="grid2">
        <label class="field"><span data-i18n="entry.issuer"></span><input id="entry-issuer" type="text" data-i18n-ph="entry.issuerPh"></label>
        <label class="field"><span data-i18n="entry.account"></span><input id="entry-account" type="text" data-i18n-ph="entry.accountPh" autocapitalize="off"></label>
      </div>
      <label class="field"><span data-i18n="entry.note"></span><input id="entry-note" type="text"></label>
      <details id="entry-adv">
        <summary data-i18n="entry.advanced"></summary>
        <p class="hint" data-i18n="entry.advancedHint"></p>
        <div class="grid4">
          <label class="field"><span data-i18n="entry.kind"></span>
            <select id="entry-kind"><option value="totp">TOTP</option><option value="hotp">HOTP</option><option value="steam">Steam</option></select></label>
          <label class="field"><span data-i18n="entry.algorithm"></span>
            <select id="entry-alg"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
          <label class="field"><span data-i18n="entry.digits"></span>
            <select id="entry-digits"><option>6</option><option>7</option><option>8</option></select></label>
          <label class="field" id="entry-period-row"><span data-i18n="entry.period"></span><input id="entry-period" type="number" min="5" max="600" value="30" inputmode="numeric"></label>
          <label class="field" id="entry-counter-row" hidden><span data-i18n="entry.counter"></span><input id="entry-counter" type="number" min="0" value="0" inputmode="numeric"></label>
        </div>
        <label class="field"><span data-i18n="entry.website"></span><input id="entry-website" type="text" data-i18n-ph="entry.websitePh" spellcheck="false" autocapitalize="off"></label>
      </details>
      <p class="error-text" id="entry-error" role="alert"></p>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="entry-cancel" data-i18n="common.cancel"></button>
        <button type="submit" class="primary" id="entry-save"></button>
      </div>
    </form>

    <div id="dlg-details" class="dialog narrow center" hidden>
      <h2 id="details-name"></h2>
      <p class="muted" data-i18n="details.lead"></p>
      <img id="details-qr" class="qr" alt="QR">
      <label class="field left"><span data-i18n="details.secret"></span><code id="details-secret" class="selectable code-box"></code></label>
      <label class="field left"><span data-i18n="details.link"></span><code id="details-uri" class="selectable code-box small"></code></label>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="details-copy-secret" data-i18n="details.copySecret"></button>
        <button type="button" class="ghost" id="details-copy-uri" data-i18n="details.copyLink"></button>
        <button type="button" class="primary" id="details-close" data-i18n="common.close"></button>
      </div>
    </div>

    <div id="dlg-import" class="dialog wide" hidden>
      <h2 data-i18n="import.title"></h2>
      <div id="import-step-input">
        <p class="muted" data-i18n="import.lead"></p>
        <div class="row wrap import-tools">
          <button type="button" class="ghost" id="import-scan"><svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/></svg><span data-i18n="import.scan"></span></button>
          <button type="button" class="ghost" id="import-choose"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg><span data-i18n="import.files"></span></button>
          <button type="button" class="ghost" id="import-paste"><svg viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg><span data-i18n="import.paste"></span></button>
        </div>
        <textarea id="import-text" rows="5" spellcheck="false" autocapitalize="off" autocorrect="off" class="mono" data-i18n-ph="import.pastePh"></textarea>
        <div id="import-drop" class="drop"><span class="muted" data-i18n="import.drop"></span></div>
        <p class="hint" data-i18n="import.formats"></p>
        <p class="error-text" id="import-error" role="alert"></p>
        <div class="dialog-buttons">
          <button type="button" class="ghost" id="import-cancel" data-i18n="common.cancel"></button>
          <button type="button" class="primary" id="import-read" data-i18n="import.read"></button>
        </div>
      </div>
      <form id="import-step-password" hidden autocomplete="off">
        <h3 id="import-pw-title"></h3>
        <p class="muted" data-i18n="import.passwordLead"></p>
        <label class="field"><span data-i18n="import.password"></span><input id="import-pw" type="password" autocomplete="off" autocapitalize="off"></label>
        <p class="error-text" id="import-pw-error" role="alert"></p>
        <div class="dialog-buttons">
          <button type="button" class="ghost" id="import-pw-back" data-i18n="common.back"></button>
          <button type="submit" class="primary" id="import-pw-go" data-i18n="import.unlock"></button>
        </div>
      </form>
      <div id="import-step-preview" hidden>
        <div class="row between">
          <h3 id="import-found"></h3>
          <div class="row">
            <button type="button" class="link" id="import-all" data-i18n="common.all"></button>
            <button type="button" class="link" id="import-none" data-i18n="common.none"></button>
          </div>
        </div>
        <ul id="import-list" class="pick-list"></ul>
        <p class="error-text" id="import-commit-error" role="alert"></p>
        <div class="dialog-buttons">
          <button type="button" class="ghost" id="import-back" data-i18n="common.back"></button>
          <button type="button" class="primary" id="import-commit"></button>
        </div>
      </div>
    </div>

    <div id="dlg-export" class="dialog wide" hidden>
      <h2 data-i18n="export.title"></h2>
      <form id="export-step-choose" autocomplete="off">
        <p class="muted" data-i18n="export.lead"></p>
        <div class="choices" id="export-kinds">
          <label class="choice"><input type="radio" name="export-kind" value="backup" checked><span><strong data-i18n="export.backup"></strong><small data-i18n="export.backupText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="backup-pw"><span><strong data-i18n="export.backupPw"></strong><small data-i18n="export.backupPwText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="pdf"><span><strong data-i18n="export.pdf"></strong><small data-i18n="export.pdfText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="google"><span><strong data-i18n="export.google"></strong><small data-i18n="export.googleText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="aegis"><span><strong data-i18n="export.aegis"></strong><small data-i18n="export.aegisText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="uris"><span><strong data-i18n="export.uris"></strong><small data-i18n="export.urisText"></small></span></label>
          <label class="choice"><input type="radio" name="export-kind" value="csv"><span><strong data-i18n="export.csv"></strong><small data-i18n="export.csvText"></small></span></label>
        </div>
        <div id="export-pw-row" class="grid2" hidden>
          <label class="field"><span data-i18n="export.newPw"></span><input id="export-pw" type="password" autocomplete="new-password" autocapitalize="off"></label>
          <label class="field"><span data-i18n="export.newPw2"></span><input id="export-pw2" type="password" autocomplete="new-password" autocapitalize="off"></label>
        </div>
        <p class="warn-box" id="export-warn" data-i18n="export.warn" hidden></p>
        <details id="export-pick">
          <summary><span data-i18n="export.which"></span> <span id="export-count" class="muted"></span></summary>
          <div class="row"><button type="button" class="link" id="export-all" data-i18n="common.all"></button><button type="button" class="link" id="export-none" data-i18n="common.none"></button></div>
          <ul id="export-list" class="pick-list compact"></ul>
        </details>
        <p class="error-text" id="export-error" role="alert"></p>
        <div class="dialog-buttons">
          <button type="button" class="ghost" id="export-cancel" data-i18n="common.cancel"></button>
          <button type="submit" class="primary" id="export-go"></button>
        </div>
      </form>
      <div id="export-step-ready" hidden>
        <div class="ready">
          <svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 15l2 2 4-4"/></svg>
          <div><strong id="export-file"></strong><div class="muted small" id="export-size"></div></div>
        </div>
        <p class="muted" id="export-ready-lead"></p>
        <p class="warn-box" id="export-ready-warn" data-i18n="export.warn" hidden></p>
        <div class="stack">
          <button type="button" class="primary big wide" id="export-share"><span data-i18n="export.share"></span></button>
          <button type="button" class="ghost big wide" id="export-download"><span data-i18n="export.download"></span></button>
        </div>
        <div class="dialog-buttons">
          <button type="button" class="ghost" id="export-back" data-i18n="common.back"></button>
          <button type="button" class="primary" id="export-done" data-i18n="common.done"></button>
        </div>
      </div>
    </div>

    <div id="dlg-google" class="dialog narrow center" hidden>
      <h2 data-i18n="export.googleTitle"></h2>
      <p class="muted" id="google-lead"></p>
      <img id="google-qr" class="qr big" alt="QR">
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="google-prev" data-i18n="common.back"></button>
        <button type="button" class="ghost" id="google-next" data-i18n="common.next"></button>
        <button type="button" class="primary" id="google-close" data-i18n="common.close"></button>
      </div>
    </div>

    <div id="dlg-scan" class="dialog narrow center" hidden>
      <h2 data-i18n="scan.title"></h2>
      <p class="muted" id="scan-lead"></p>
      <div class="scan-box">
        <video id="scan-video" playsinline muted autoplay></video>
        <div class="scan-frame"></div>
      </div>
      <p class="hint" id="scan-status"></p>
      <p class="error-text" id="scan-error" role="alert"></p>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="scan-image" data-i18n="scan.image"></button>
        <button type="button" class="primary" id="scan-done" data-i18n="common.done"></button>
      </div>
    </div>

    <div id="dlg-settings" class="dialog wide" hidden>
      <div class="row between dialog-head">
        <h2 data-i18n="settings.title"></h2>
        <button type="button" class="primary" id="settings-close" data-i18n="common.close"></button>
      </div>
      <div class="settings">
        <section>
          <h3 data-i18n="settings.language"></h3>
          <div class="lang big" role="group">
            <button type="button" data-lang="de">Deutsch</button>
            <button type="button" data-lang="en">English</button>
          </div>
        </section>
        <section>
          <h3 data-i18n="settings.look"></h3>
          <label class="field"><span data-i18n="settings.mode"></span>
            <select id="set-mode">
              <option value="auto" data-i18n="settings.modeAuto"></option>
              <option value="light" data-i18n="settings.modeLight"></option>
              <option value="dark" data-i18n="settings.modeDark"></option>
            </select></label>
          <div class="qlabel" data-i18n="settings.palLight"></div>
          <div class="pals" id="pals-light" role="radiogroup"></div>
          <div class="qlabel" data-i18n="settings.palDark"></div>
          <div class="pals" id="pals-dark" role="radiogroup"></div>
          <p class="hint" data-i18n="settings.palHint"></p>
          <label class="field range"><span><span data-i18n="settings.fontSize"></span> <b id="set-fs-val"></b></span><input id="set-fs" type="range" min="85" max="130" step="5"></label>
          <label class="field range"><span><span data-i18n="settings.codeSize"></span> <b id="set-cs-val"></b></span><input id="set-cs" type="range" min="70" max="150" step="5"></label>
          <label class="check"><input type="checkbox" id="set-compact"><span data-i18n="settings.compact"></span></label>
          <label class="check"><input type="checkbox" id="set-next"><span data-i18n="settings.showNext"></span></label>
        </section>
        <section>
          <h3 data-i18n="settings.security"></h3>
          <div id="bio-box" class="bio-box">
            <label class="check"><input type="checkbox" id="set-bio"><span id="set-bio-label"></span></label>
            <p class="hint" id="set-bio-hint"></p>
            <button type="button" class="ghost" id="set-bio-finish" hidden></button>
          </div>
          <label class="field"><span data-i18n="settings.autoLock"></span><select id="set-autolock"></select></label>
          <label class="field"><span data-i18n="settings.leaveLock"></span><select id="set-leavelock"></select></label>
          <label class="field"><span data-i18n="settings.clipboard"></span><select id="set-clipboard"></select></label>
          <p class="hint" data-i18n="settings.clipboardHint"></p>
          <label class="check"><input type="checkbox" id="set-hidecodes"><span data-i18n="settings.hideCodes"></span></label>
        </section>
        <section>
          <h3 data-i18n="settings.backup"></h3>
          <p class="muted small" id="set-lastbackup"></p>
          <label class="field"><span data-i18n="settings.remind"></span><select id="set-remind"></select></label>
          <button type="button" class="ghost" id="set-backup-now" data-i18n="settings.backupNow"></button>
        </section>
        <form id="pw-form" autocomplete="off">
          <h3 data-i18n="settings.password"></h3>
          <input type="text" name="username" autocomplete="username" value="OTP-PWA" hidden>
          <label class="field"><span data-i18n="settings.oldPw"></span><input id="pw-old" type="password" autocomplete="current-password" autocapitalize="off"></label>
          <label class="field"><span data-i18n="settings.newPw"></span><input id="pw-new" type="password" autocomplete="new-password" autocapitalize="off"></label>
          <label class="field"><span data-i18n="settings.newPw2"></span><input id="pw-new2" type="password" autocomplete="new-password" autocapitalize="off"></label>
          <p class="error-text" id="pw-error" role="alert"></p>
          <button type="submit" class="ghost" id="pw-submit" data-i18n="settings.changePw"></button>
        </form>
        <section>
          <h3 data-i18n="settings.storage"></h3>
          <p class="muted small" id="set-storage"></p>
          <button type="button" class="ghost danger-text" id="set-wipe" data-i18n="settings.wipe"></button>
        </section>
        <section class="about">
          <h3 data-i18n="settings.about"></h3>
          <p id="set-version"></p>
          <p class="muted small" id="set-server"></p>
          <div class="row wrap">
            <button type="button" class="ghost" id="set-update" data-i18n="settings.checkUpdate"></button>
            <a class="ghost btnlink" id="set-admin" href="./?action=admin" data-i18n="settings.admin"></a>
          </div>
          <p class="muted small" data-i18n="settings.aboutText"></p>
        </section>
      </div>
    </div>

    <div id="dlg-mixer" class="dialog" hidden>
      <h2 id="mixer-title"></h2>
      <div class="mix-preview" id="mix-preview">
        <div class="mp-bar"><span class="mp-dot"></span><b>OTP-PWA</b><span class="mp-tool" data-i18n="top.add"></span></div>
        <div class="mp-body">
          <div class="mp-card">
            <div class="mp-head"><span class="mp-ava">G</span><span><b>GitHub</b><small>name@example.org</small></span></div>
            <div class="mp-code">123 456 <span class="mp-ring"></span></div>
            <div class="mp-foot"><span data-i18n="card.next"></span> 789 012</div>
          </div>
          <div class="mp-btns"><span class="mp-btn ghost" data-i18n="common.cancel"></span><span class="mp-btn primary" data-i18n="entry.save"></span></div>
        </div>
      </div>
      <div class="segs" id="mixer-parts"></div>
      <div class="sliders" id="mixer-sliders">
        <label class="sl hue"><span data-i18n="mixer.hue"></span><input type="range" id="mix-h" min="0" max="360" step="1"></label>
        <label class="sl sat"><span data-i18n="mixer.sat"></span><input type="range" id="mix-s" min="0" max="100" step="1"></label>
        <label class="sl lig"><span data-i18n="mixer.lig"></span><input type="range" id="mix-l" min="0" max="100" step="1"></label>
      </div>
      <div class="pick">
        <label class="ghost picklabel"><input type="color" id="mix-picker"><span data-i18n="mixer.picker"></span></label>
        <input type="text" id="mix-hex" class="hex mono" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" enterkeyhint="done">
      </div>
      <p class="error-text" id="mix-warn"></p>
      <label class="field"><select id="mix-base"></select></label>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="mix-reset" data-i18n="mixer.reset"></button>
        <button type="button" class="primary" id="mix-done" data-i18n="common.done"></button>
      </div>
    </div>

    <form id="dlg-restore" class="dialog narrow" hidden autocomplete="off">
      <h2 data-i18n="restore.title"></h2>
      <p class="muted" id="restore-lead"></p>
      <label class="field"><span data-i18n="restore.password"></span><input id="restore-pw" type="password" autocomplete="off" autocapitalize="off"></label>
      <p class="error-text" id="restore-error" role="alert"></p>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="restore-cancel" data-i18n="common.cancel"></button>
        <button type="submit" class="primary" id="restore-go" data-i18n="restore.go"></button>
      </div>
    </form>

    <div id="dlg-confirm" class="dialog narrow" hidden>
      <h2 id="confirm-title"></h2>
      <p class="muted" id="confirm-text"></p>
      <label class="field" id="confirm-type-row" hidden><span id="confirm-type-label"></span><input id="confirm-type" type="text" autocomplete="off" autocapitalize="off"></label>
      <div class="dialog-buttons">
        <button type="button" class="ghost" id="confirm-no" data-i18n="common.cancel"></button>
        <button type="button" class="primary danger-bg" id="confirm-yes"></button>
      </div>
    </div>

    <div id="dlg-error" class="dialog narrow" hidden>
      <h2 data-i18n="error.title"></h2>
      <p id="error-msg"></p>
      <p class="muted" id="error-hint"></p>
      <div class="dialog-buttons"><button type="button" class="primary" id="error-ok" data-i18n="common.ok"></button></div>
    </div>
  </div>

  <div id="toast" class="toast" role="status" hidden></div>

  <script src="<?php echo $asset('argon2.js'); ?>"></script>
  <script src="<?php echo $asset('noble.js'); ?>"></script>
  <script src="<?php echo $asset('qrcode.js'); ?>"></script>
  <script src="<?php echo $asset('jsqr.js'); ?>"></script>
  <script src="<?php echo $asset('core.js'); ?>"></script>
  <script src="<?php echo $asset('i18n.js'); ?>"></script>
  <script src="<?php echo $asset('app.js'); ?>"></script>
</body>
</html>
