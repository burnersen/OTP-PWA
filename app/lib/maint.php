<?php
/* OTP-PWA – automatische Updates aus dem GitHub-Release: einmal am Tag nachsehen, Installer laden,
   Prüfsumme prüfen, neue Version einspielen. Ohne Passwort und ohne Knopf, der Server macht das selbst.
   Persönliches geht dabei nie raus. Abschalten: in data/config.php 'update_url' => '' eintragen.
   Zurück zu einer älteren Version: deren otp-pwa-install.php aus dem Release hochladen und aufrufen
   (vorher 'update_url' => '' setzen, sonst kommt am nächsten Tag wieder die neueste). */
defined('OP_VERSION') || exit;

/** Woher die Updates kommen. In data/config.php lässt sich mit 'update_url' eine andere Adresse eintragen, '' schaltet sie ab. */
function opUpdUrl(): string {
    $cfg = opConfig();
    return array_key_exists('update_url', $cfg) ? (string)$cfg['update_url'] : 'https://api.github.com/repos/burnersen/OTP-PWA/releases/latest';
}

/** Datei aus dem Netz holen (folgt Weiterleitungen, höchstens $max Bytes). Wirft bei jedem Fehler. */
function opHttpGet(string $url, int $max): string {
    if (!preg_match('~^https://~i', $url)) throw new RuntimeException(opT('Ungültige Adresse für Updates.', 'Invalid update address.'));
    $ua = 'OTP-PWA/' . OP_VERSION . ' (self-hosted)';
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $buf = '';
        curl_setopt_array($ch, [CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 60,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_USERAGENT => $ua, CURLOPT_HTTPHEADER => ['Accept: application/vnd.github+json, application/octet-stream;q=0.9, */*;q=0.5'],
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$buf, $max) { $buf .= $chunk; return strlen($buf) > $max ? 0 : strlen($chunk); }]);
        $ok = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if (strlen($buf) > $max) throw new RuntimeException(opT('Die Datei ist zu groß.', 'The file is too large.'));
        if ($ok === false || $code !== 200) throw new RuntimeException(opT('Der Update-Server antwortet nicht', 'The update server does not answer') . ' (' . ($code ?: $err) . ').');
        return $buf;
    }
    if (!filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
        throw new RuntimeException(opT('Dieser Server kann keine Dateien aus dem Netz laden (curl oder allow_url_fopen fehlt).', 'This server cannot download files (curl or allow_url_fopen is missing).'));
    }
    $ctx = stream_context_create(['http' => ['method' => 'GET', 'header' => "User-Agent: $ua\r\nAccept: application/vnd.github+json, */*;q=0.5", 'timeout' => 60,
        'follow_location' => 1, 'max_redirects' => 5, 'ignore_errors' => true]]);
    $buf = @file_get_contents($url, false, $ctx, 0, $max + 1);
    $code = isset($http_response_header) && preg_match_all('~^HTTP/\S+\s+(\d+)~m', implode("\n", $http_response_header), $m) ? (int)end($m[1]) : 0;
    if ($buf === false || $code !== 200) throw new RuntimeException(opT('Der Update-Server antwortet nicht', 'The update server does not answer') . ' (' . $code . ').');
    if (strlen($buf) > $max) throw new RuntimeException(opT('Die Datei ist zu groß.', 'The file is too large.'));
    return $buf;
}

/** Beim Release nachsehen: neueste Version, Hinweise, Adresse und Prüfsumme des Installers. Wird gemerkt (upd_info, upd_at). */
function opUpdCheck(): array {
    $url = opUpdUrl();
    if ($url === '') throw new RuntimeException(opT('Updates sind auf diesem Server abgeschaltet.', 'Updates are switched off on this server.'));
    if (opDataReady()) opSet(['upd_at' => time()]);
    $j = json_decode(opHttpGet($url, 1 << 20), true);
    if (!is_array($j) || empty($j['tag_name'])) throw new RuntimeException(opT('Die Antwort des Update-Servers ist unbrauchbar.', 'The answer of the update server is unusable.'));
    $notes = (string)($j['body'] ?? '');
    $info = ['v' => preg_replace('~^(?:otp-pwa-|v)~i', '', (string)$j['tag_name']), 'page' => (string)($j['html_url'] ?? ''),
             'notes' => function_exists('mb_substr') ? mb_substr($notes, 0, 4000) : substr($notes, 0, 4000), 'url' => '', 'sha' => ''];
    foreach ((array)($j['assets'] ?? []) as $a) {
        if (is_array($a) && ($a['name'] ?? '') === 'otp-pwa-install.php') {
            $info['url'] = (string)($a['browser_download_url'] ?? '');
            if (preg_match('~^sha256:([0-9a-f]{64})$~', (string)($a['digest'] ?? ''), $m)) $info['sha'] = $m[1];
        }
    }
    if (!preg_match('~^[0-9][0-9A-Za-z.\-]*$~', $info['v'])) throw new RuntimeException(opT('Die Antwort des Update-Servers ist unbrauchbar.', 'The answer of the update server is unusable.'));
    if (opDataReady()) opSet(['upd_info' => $info, 'upd_error' => '']);
    return $info;
}

/** Zuletzt gesehene Release-Angaben, null = noch nie nachgesehen */
function opUpdInfo(): ?array {
    $i = opConfig()['upd_info'] ?? null;
    return is_array($i) && isset($i['v']) ? $i : null;
}

function opUpdNewer(?array $i): bool {
    return $i !== null && version_compare($i['v'], OP_VERSION, '>');
}

/** Dateien im Format des Installers: hinter „__halt_compiler();“ pro Zeile Pfad, SHA-256 und Inhalt (Base64). null = unbrauchbar. */
function opPayloadParse(string $raw): ?array {
    $pos = strpos($raw, '__halt_compiler();');
    $raw = $pos === false ? $raw : substr($raw, $pos + 18);
    $files = [];
    foreach (explode("\n", $raw) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        $p = explode("\t", $line);
        if (count($p) !== 3) return null;
        if (!preg_match('~^(?:index\.php|LICENSE|app(?:/[A-Za-z0-9._\-]+)+)$~', $p[0]) || strpos($p[0], '..') !== false) return null;
        $bin = base64_decode($p[2], true);
        if ($bin === false || !hash_equals($p[1], hash('sha256', $bin))) return null;
        $files[$p[0]] = $bin;
    }
    return isset($files['index.php'], $files['app/assets/app.js']) ? $files : null;
}

/** Dateien einspielen wie der Installer: alles erst unter Zwischennamen schreiben, dann umbenennen, Überbleibsel in app/ wegräumen */
function opPayloadInstall(array $files): void {
    $tmp = [];
    $fail = '';
    foreach ($files as $path => $bin) {
        $target = OP_ROOT . '/' . $path;
        $parent = dirname($target);
        if (!is_dir($parent) && !@mkdir($parent, 0755, true) && !is_dir($parent)) { $fail = $path; break; }
        $t = $target . '.tmp';
        if (@file_put_contents($t, $bin) !== strlen($bin)) { @unlink($t); $fail = $path; break; }
        $tmp[$t] = $target;
    }
    if ($fail === '') {
        foreach ($tmp as $t => $target) {
            if (!@rename($t, $target)) { $fail = substr($target, strlen(OP_ROOT) + 1); break; }
            @chmod($target, 0644);
            if (function_exists('opcache_invalidate')) @opcache_invalidate($target, true);
        }
    }
    foreach ($tmp as $t => $target) if (is_file($t)) @unlink($t);
    if ($fail !== '') throw new RuntimeException(opT('Die Datei ließ sich nicht schreiben: ', 'This file could not be written: ') . $fail . '. ' . opT('PHP braucht Schreibrechte im Ordner von OTP-PWA.', 'PHP needs write access to the OTP-PWA folder.'));
    foreach (['lib', 'views', 'assets'] as $sub) {
        foreach ((array)@glob(OP_APP . '/' . $sub . '/*') as $old) {
            if (is_file($old) && !isset($files['app/' . $sub . '/' . basename($old)])) @unlink($old);
        }
    }
}

/** Darf PHP die Programmdateien überschreiben? '' = ja, sonst der erste Pfad, bei dem es nicht geht */
function opUpdWritable(): string {
    foreach (['index.php', 'app', 'app/lib', 'app/views', 'app/assets', 'app/lib/maint.php', 'app/assets/app.js'] as $p) {
        if (file_exists(OP_ROOT . '/' . $p) && !is_writable(OP_ROOT . '/' . $p)) return $p;
    }
    return '';
}

/** Neueste Version holen, prüfen und einspielen */
function opUpdInstall(?array $info = null): string {
    $info = $info ?: opUpdCheck();
    if (!opUpdNewer($info)) throw new RuntimeException(opT('Du hast schon die neueste Version.', 'You already have the latest version.'));
    if ($info['url'] === '' || $info['sha'] === '') throw new RuntimeException(opT('Zu dieser Version gibt es keinen prüfbaren Installer. Bitte von Hand aktualisieren.', 'This version has no installer that can be checked. Please update by hand.'));
    if (($w = opUpdWritable()) !== '') throw new RuntimeException(opT('Die Datei ließ sich nicht schreiben: ', 'This file could not be written: ') . $w . '. ' . opT('PHP braucht Schreibrechte im Ordner von OTP-PWA.', 'PHP needs write access to the OTP-PWA folder.'));
    if (!opDataReady()) throw new RuntimeException(opT('In den Ordner data/ kann nicht geschrieben werden. Bitte die Schreibrechte prüfen.', 'The folder data/ is not writable. Please check the permissions.'));
    @set_time_limit(120);
    $bin = opHttpGet($info['url'], 16 << 20);
    if (!hash_equals($info['sha'], hash('sha256', $bin))) throw new RuntimeException(opT('Die Prüfsumme der heruntergeladenen Datei stimmt nicht. Es wurde nichts verändert.', 'The checksum of the downloaded file does not match. Nothing was changed.'));
    $files = opPayloadParse($bin);
    if (!$files || !preg_match("~define\\('OP_VERSION',\\s*'" . preg_quote($info['v'], '~') . "'\\)~", $files['index.php'])) {
        throw new RuntimeException(opT('Die heruntergeladene Datei ist unbrauchbar. Es wurde nichts verändert.', 'The downloaded file is unusable. Nothing was changed.'));
    }
    opPayloadInstall($files);
    return $info['v'];
}

/**
 * Einmal am Tag nachsehen und eine neue Version gleich einspielen. Hängt nur an Anfragen, die die App im Hintergrund
 * stellt (Service Worker, Versionsabfrage), nie an der Seite selbst, und läuft erst, nachdem die Antwort raus ist.
 * Fehler werden still geschluckt, beim nächsten Mal geht es weiter.
 */
function opUpdLater(): void {
    $cfg = opConfig();
    if (!($cfg['upd_daily'] ?? true) || opUpdUrl() === '' || time() - (int)($cfg['upd_at'] ?? 0) < 86400) return;
    if (!is_dir(OP_DATA_DIR) && !opDataReady()) return;
    register_shutdown_function(function () {
        if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
        $lock = @fopen(OP_DATA_DIR . '/.update.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) return;
        try {
            $info = opUpdCheck();
            if ((opConfig(true)['upd_auto'] ?? true) && opUpdNewer($info)) {
                $v = opUpdInstall($info);
                opSet(['upd_last' => ['v' => $v, 'at' => time()], 'upd_error' => '']);
            }
        } catch (Throwable $e) {
            if (opDataReady()) { try { opSet(['upd_error' => substr($e->getMessage(), 0, 300), 'upd_error_at' => time()]); } catch (Throwable $e2) {} }
        }
        flock($lock, LOCK_UN);
        fclose($lock);
    });
}
