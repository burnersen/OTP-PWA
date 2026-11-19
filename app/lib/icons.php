<?php
/* OTP-PWA – Icons holen. Die App selbst darf keine fremden Seiten abrufen (Content-Security-Policy),
   deshalb holt der eigene Server das Icon von der Webseite des Dienstes und reicht es durch.
   Der Server erfährt dabei nur den Namen der Webseite, nie einen Schlüssel oder Nutzernamen.
   Wie bei otp-vault: nur von der Seite des Dienstes selbst, kein Icon-Dienst dazwischen.

   Schutz gegen Missbrauch: nur HTTPS auf Port 443, nur öffentliche IP-Adressen (nichts aus dem eigenen Netz,
   jede Weiterleitung wird neu geprüft und die Adresse festgenagelt), Größen- und Zeitgrenzen, eine Bremse
   pro Absender, und nur Anfragen aus der App (Kopfzeile X-OTP-PWA, die ein normaler Link nicht setzen kann). */
defined('OP_VERSION') || exit;

const OP_ICON_PAGE_MAX = 1048576;   // Startseite höchstens 1 MB
const OP_ICON_MAX = 524288;         // Icon höchstens 512 KB
const OP_ICON_PER_MINUTE = 60;      // Anfragen pro Minute und Absender

function opIconFail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Bremse: höchstens OP_ICON_PER_MINUTE Anfragen pro Minute und Absender (ohne data/ eben ohne Bremse) */
function opIconThrottle(): bool {
    if (!opDataReady()) return true;
    $file = OP_DATA_DIR . '/icon-rate.json';
    $fp = @fopen($file, 'c+');
    if (!$fp) return true;
    flock($fp, LOCK_EX);
    $d = json_decode((string)stream_get_contents($fp), true);
    $min = (int)floor(time() / 60);
    if (!is_array($d) || ($d['m'] ?? 0) !== $min) $d = ['m' => $min, 'c' => []];
    $who = substr(hash('sha256', (string)($_SERVER['REMOTE_ADDR'] ?? '')), 0, 16);
    $d['c'][$who] = ($d['c'][$who] ?? 0) + 1;
    $ok = $d['c'][$who] <= OP_ICON_PER_MINUTE;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($d));
    flock($fp, LOCK_UN);
    fclose($fp);
    return $ok;
}

/** Ist das eine öffentliche Adresse? (keine privaten, lokalen oder reservierten Bereiche) */
function opIconPublicIp(string $ip): bool {
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false
        && !preg_match('~^(?:0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|192\.0\.0\.|198\.1[89]\.|::ffff:|64:ff9b:|fc|fd|fe[89ab])~i', $ip);
}

/** Alle Adressen eines Namens. Nur wenn alle öffentlich sind, wird die erste zurückgegeben, sonst ''. */
function opIconResolve(string $host): string {
    $ips = [];
    if (function_exists('dns_get_record')) {
        foreach ((array)@dns_get_record($host, DNS_A | DNS_AAAA) as $r) {
            if (!empty($r['ip'])) $ips[] = $r['ip'];
            if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
    }
    if (!$ips) $ips = (array)@gethostbynamel($host);
    if (!$ips) return '';
    foreach ($ips as $ip) if (!opIconPublicIp($ip)) return '';
    foreach ($ips as $ip) if (strpos($ip, ':') === false) return $ip;   // IPv4 zuerst, das klappt auf jedem Webspace
    return $ips[0];
}

/** Nur https://name[:443]/..., keine Zugangsdaten in der Adresse, keine nackten IP-Adressen */
function opIconUrlOk(string $url): ?array {
    $u = parse_url($url);
    if (!is_array($u) || strtolower($u['scheme'] ?? '') !== 'https' || empty($u['host']) || isset($u['user']) || isset($u['pass'])) return null;
    if (isset($u['port']) && (int)$u['port'] !== 443) return null;
    $host = strtolower(rtrim($u['host'], '.'));
    if (!preg_match('~^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$~', $host)) return null;
    $u['host'] = $host;
    return $u;
}

/** Relative Adresse gegen eine Basis auflösen (für <link href> und Weiterleitungen) */
function opIconJoin(string $base, string $rel): string {
    $rel = trim(html_entity_decode($rel, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $rel)) return $rel;
    $b = parse_url($base);
    $origin = 'https://' . ($b['host'] ?? '');
    if (strncmp($rel, '//', 2) === 0) return 'https:' . $rel;
    $suffix = '';
    if (($cut = strcspn($rel, '?#')) < strlen($rel)) { $suffix = substr($rel, $cut); $rel = substr($rel, 0, $cut); }
    $dir = preg_replace('~/[^/]*$~', '/', $b['path'] ?? '/');
    $out = [];
    foreach (explode('/', ($rel !== '' && $rel[0] === '/') ? $rel : $dir . $rel) as $seg) {
        if ($seg === '..') { if (count($out) > 1) array_pop($out); }
        elseif ($seg !== '.') $out[] = $seg;
    }
    return $origin . implode('/', $out) . $suffix;
}

/**
 * Eine Adresse sicher abrufen: jede Weiterleitung selbst prüfen, Name vorher auflösen und genau diese
 * Adresse benutzen (sonst könnte ein Name zwischen Prüfen und Abrufen auf das eigene Netz zeigen).
 * Liefert [Inhalt, endgültige Adresse] oder null.
 */
function opIconGet(string $url, int $max): ?array {
    for ($hop = 0; $hop < 5; $hop++) {
        $u = opIconUrlOk($url);
        if (!$u) return null;
        $ip = opIconResolve($u['host']);
        if ($ip === '') return null;
        $buf = '';
        $location = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RESOLVE => [$u['host'] . ':443:' . (strpos($ip, ':') !== false ? '[' . $ip . ']' : $ip)],
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; OTP-PWA/' . OP_VERSION . '; favicon)',
            CURLOPT_HTTPHEADER => ['Accept: text/html,image/*;q=0.9,*/*;q=0.5'],
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$location) {
                if (stripos($line, 'Location:') === 0) $location = trim(substr($line, 9));
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$buf, $max) {
                $buf .= $chunk;
                return strlen($buf) > $max ? 0 : strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (strlen($buf) > $max) return null;
        if ($code >= 300 && $code < 400 && $location !== '') {
            $url = opIconJoin($url, $location);
            continue;
        }
        if ($ok === false || $code !== 200) return null;
        return [$buf, $url];
    }
    return null;
}

/** Was für ein Bild ist das? Nach den Bytes, nicht nach dem, was der Server behauptet. '' = kein Bild. */
function opIconMime(string $b): string {
    if (strlen($b) < 4) return '';
    if ($b[0] === "\0" && $b[1] === "\0" && ($b[2] === "\1" || $b[2] === "\2") && $b[3] === "\0") return 'image/x-icon';
    if (strncmp($b, "\x89PNG", 4) === 0) return 'image/png';
    if (strncmp($b, "\xFF\xD8\xFF", 3) === 0) return 'image/jpeg';
    if (strncmp($b, 'GIF8', 4) === 0) return 'image/gif';
    if (strncmp($b, 'RIFF', 4) === 0 && substr($b, 8, 4) === 'WEBP') return 'image/webp';
    $head = strtolower(substr($b, 0, 1024));
    if (strpos($head, '<svg') !== false && stripos($b, '<script') === false) return 'image/svg+xml';
    return '';
}

/** <link rel="icon"> der Seite, die größten und apple-touch-icons zuerst (sehen auf der Karte am besten aus) */
function opIconLinks(string $page): array {
    $out = [];
    if (!preg_match_all('~<link\b[^>]*>~is', $page, $tags)) return $out;
    foreach ($tags[0] as $tag) {
        $a = [];
        if (preg_match_all('~([a-z-]+)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))~is', $tag, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) $a[strtolower($x[1])] = ($x[3] ?? '') . ($x[4] ?? '') . ($x[5] ?? '');
        }
        $rel = strtolower($a['rel'] ?? '');
        if (strpos($rel, 'icon') === false || ($a['href'] ?? '') === '' || strpos($rel, 'mask') !== false) continue;
        $score = strpos($rel, 'apple-touch') !== false ? 180 : 16;
        foreach (preg_split('~\s+~', strtolower($a['sizes'] ?? '')) as $sz) {
            if ($sz === 'any') $score = 200;
            elseif (preg_match('~^(\d+)x~', $sz, $mm) && (int)$mm[1] > $score && (int)$mm[1] <= 512) $score = (int)$mm[1];
        }
        if (preg_match('~\.svg(?:$|\?)~i', $a['href']) || strtolower($a['type'] ?? '') === 'image/svg+xml') $score = 190;
        $out[] = [$a['href'], $score];
    }
    usort($out, function ($x, $y) { return $y[1] <=> $x[1]; });
    return array_map(function ($x) { return $x[0]; }, $out);
}

/** Icon einer Webseite: Startseite lesen, die angegebenen Icons probieren, dann /favicon.ico. Auch die übergeordnete Domain. */
function opIconForHost(string $host): ?array {
    $hosts = [$host];
    $parts = explode('.', $host);
    if (count($parts) > 2) $hosts[] = implode('.', array_slice($parts, 1));   // accounts.example.com > example.com
    elseif (strpos($host, 'www.') !== 0) $hosts[] = 'www.' . $host;
    $tried = [];
    foreach ($hosts as $h) {
        $base = 'https://' . $h . '/';
        $tries = [];
        $page = opIconGet($base, OP_ICON_PAGE_MAX);
        if ($page) {
            foreach (opIconLinks($page[0]) as $href) $tries[] = opIconJoin($page[1], $href);
            $tries[] = opIconJoin($page[1], '/favicon.ico');
        }
        $tries[] = $base . 'favicon.ico';
        foreach ($tries as $t) {
            if (isset($tried[$t]) || count($tried) >= 8) continue;
            $tried[$t] = true;
            $r = opIconGet($t, OP_ICON_MAX);
            if ($r && ($mime = opIconMime($r[0])) !== '') return [$mime, $r[0]];
        }
    }
    return null;
}

function opIcon(): void {
    opHeaders();
    header('Cache-Control: no-store');
    // Nur aus der App: ein Link oder ein fremdes Formular kann diese Kopfzeile nicht setzen
    if (($_SERVER['HTTP_X_OTP_PWA'] ?? '') !== '1') opIconFail(400, 'not from the app');
    if (!function_exists('curl_init')) opIconFail(501, opT('Auf dem Server fehlt curl, Icons lassen sich nicht holen.', 'The server has no curl, icons cannot be fetched.'));
    if (!opIconThrottle()) opIconFail(429, opT('Zu viele Anfragen. Bitte kurz warten.', 'Too many requests. Please wait a moment.'));
    @set_time_limit(40);
    $res = null;
    $url = isset($_GET['url']) && is_string($_GET['url']) ? trim($_GET['url']) : '';
    $host = isset($_GET['host']) && is_string($_GET['host']) ? strtolower(trim($_GET['host'])) : '';
    if ($url !== '') {
        // Direkt ein Bild: nehmen. Sonst ist es eine Seite, dann deren Icon.
        $r = opIconGet($url, OP_ICON_PAGE_MAX);
        if ($r && ($mime = opIconMime($r[0])) !== '' && strlen($r[0]) <= OP_ICON_MAX) $res = [$mime, $r[0]];
        elseif ($r) {
            foreach (array_merge(opIconLinks($r[0]), ['/favicon.ico']) as $href) {
                $i = opIconGet(opIconJoin($r[1], $href), OP_ICON_MAX);
                if ($i && ($mime = opIconMime($i[0])) !== '') { $res = [$mime, $i[0]]; break; }
            }
        }
        if (!$res && ($u = opIconUrlOk($url))) $res = opIconForHost($u['host']);
    } elseif ($host !== '' && opIconUrlOk('https://' . $host . '/')) {
        $res = opIconForHost($host);
    } else {
        opIconFail(400, opT('Ungültige Adresse.', 'Invalid address.'));
    }
    if (!$res) opIconFail(404, opT('Kein Icon gefunden.', 'No icon found.'));
    // Nie als Seite anzeigen (ein SVG könnte sonst Skripte enthalten), nur als Bild an die App
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox");
    header('Content-Disposition: attachment; filename="icon"');
    header('Content-Type: ' . $res[0]);
    header('Cache-Control: private, max-age=86400');
    echo $res[1];
    exit;
}
