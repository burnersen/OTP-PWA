<?php
/* OTP-PWA – gemeinsame Hilfen: Sprache, Kopfzeilen, Einstellungen der Server-Verwaltung in data/config.php */
defined('OP_VERSION') || exit;

/** Was die App vom Server holen darf, mit Dateityp. Alles andere in app/ ist von außen nicht erreichbar. */
const OP_ASSETS = [
    'app.css' => 'text/css; charset=utf-8',
    'boot.js' => 'text/javascript; charset=utf-8',
    'argon2.js' => 'text/javascript; charset=utf-8',
    'noble.js' => 'text/javascript; charset=utf-8',
    'qrcode.js' => 'text/javascript; charset=utf-8',
    'jsqr.js' => 'text/javascript; charset=utf-8',
    'core.js' => 'text/javascript; charset=utf-8',
    'i18n.js' => 'text/javascript; charset=utf-8',
    'app.js' => 'text/javascript; charset=utf-8',
    'logo.png' => 'image/png',
    'favicon.png' => 'image/png',
    'icon-180.png' => 'image/png',
    'icon-192.png' => 'image/png',
    'icon-512.png' => 'image/png',
];

function opH($s): string {
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

/** Sprache aus dem Browser: Deutsch, wenn er Deutsch zuerst nennt, sonst Englisch */
function opLang(): string {
    static $lang = null;
    if ($lang === null) {
        $al = strtolower(trim((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')));
        $lang = ($al === '' || strncmp($al, 'de', 2) === 0) ? 'de' : 'en';
    }
    return $lang;
}

function opT(string $de, string $en): string {
    return opLang() === 'de' ? $de : $en;
}

/** Sicherheits-Kopfzeilen. $page: die App-Seite mit ihrer Content-Security-Policy. */
function opHeaders(bool $page = false): void {
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header('X-Robots-Tag: noindex, nofollow');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    if ($page) {
        // wasm-unsafe-eval: Argon2 läuft als WebAssembly (ohne geht es auch, nur langsamer)
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; "
            . "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
            . "form-action 'self'; frame-ancestors 'none'");
    }
}

/* ---------- data/: nur Einstellungen der Server-Verwaltung, nie etwas von den Handys ---------- */

/** Legt data/ an und sperrt es von außen. false = PHP darf hier nicht schreiben. */
function opDataReady(): bool {
    if (!is_dir(OP_DATA_DIR) && !@mkdir(OP_DATA_DIR, 0700, true) && !is_dir(OP_DATA_DIR)) return false;
    if (!is_writable(OP_DATA_DIR)) return false;
    $ht = OP_DATA_DIR . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "# OTP-PWA: interne Daten, nie von außen abrufbar\n<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\nOptions -Indexes\n");
    }
    if (!is_file(OP_DATA_DIR . '/index.html')) @file_put_contents(OP_DATA_DIR . '/index.html', '');
    return true;
}

function opConfig(bool $fresh = false): array {
    static $cfg = null;
    if ($cfg === null || $fresh) {
        $file = OP_DATA_DIR . '/config.php';
        $cfg = is_file($file) ? (include $file) : [];
        if (!is_array($cfg)) $cfg = [];
    }
    return $cfg;
}

/** data/config.php neu schreiben (erst unter anderem Namen, dann umbenennen, damit nie eine halbe Datei dasteht) */
function opConfigWrite(array $cfg): void {
    if (!opDataReady()) throw new RuntimeException(opT('In den Ordner data/ kann nicht geschrieben werden. Bitte die Schreibrechte prüfen.', 'The folder data/ is not writable. Please check the permissions.'));
    $file = OP_DATA_DIR . '/config.php';
    $php = "<?php\n// OTP-PWA: automatisch angelegt. Nicht weitergeben.\nreturn " . var_export($cfg, true) . ";\n";
    if (@file_put_contents($file . '.tmp', $php, LOCK_EX) === false || !@rename($file . '.tmp', $file)) {
        @unlink($file . '.tmp');
        throw new RuntimeException(opT('In den Ordner data/ kann nicht geschrieben werden. Bitte die Schreibrechte prüfen.', 'The folder data/ is not writable. Please check the permissions.'));
    }
    @chmod($file, 0600);
    if (function_exists('opcache_invalidate')) @opcache_invalidate($file, true);
    opConfig(true);
}

function opSet(array $patch): void {
    opConfigWrite(array_merge(opConfig(true), $patch));
}
