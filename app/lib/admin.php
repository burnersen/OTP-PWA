<?php
/* OTP-PWA – Server-Verwaltung: Updates suchen, einspielen, zurück zur vorigen Version, tägliches Nachsehen.
   Geschützt mit einem eigenen Passwort, das beim ersten Aufruf festgelegt wird. Mit dem Tresor auf den Handys
   hat das nichts zu tun: der Server kennt keine Konten und keine Schlüssel. */
defined('OP_VERSION') || exit;

const OP_ADMIN_MIN = 10;

function opAdminSession(): void {
    $path = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/'))), '/') . '/';
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('OPADMIN');
    session_set_cookie_params(['lifetime' => 0, 'path' => $path, 'secure' => $https, 'httponly' => true, 'samesite' => 'Strict']);
    // Sitzungen im eigenen Ordner, wenn möglich (manche Hoster räumen den gemeinsamen zu früh auf)
    if (opDataReady()) {
        $dir = OP_DATA_DIR . '/sessions';
        if (is_dir($dir) || @mkdir($dir, 0700)) session_save_path($dir);
    }
    @session_start();
}

/** Bremse gegen Durchprobieren: nach 5 Fehlversuchen warten, erst 30 Sekunden, dann immer länger, höchstens eine Stunde */
function opThrottleFile(): string {
    return OP_DATA_DIR . '/throttle.json';
}

function opThrottleWait(): int {
    $t = json_decode((string)@file_get_contents(opThrottleFile()), true);
    return is_array($t) ? max(0, (int)($t['until'] ?? 0) - time()) : 0;
}

function opThrottleFail(): void {
    $t = json_decode((string)@file_get_contents(opThrottleFile()), true);
    $fails = (is_array($t) ? (int)($t['fails'] ?? 0) : 0) + 1;
    $until = $fails >= 5 ? time() + min(3600, 30 * (2 ** ($fails - 5))) : 0;
    @file_put_contents(opThrottleFile(), json_encode(['fails' => $fails, 'until' => $until]), LOCK_EX);
}

function opThrottleReset(): void {
    @unlink(opThrottleFile());
}

function opFlash(string $msg, bool $bad = false): void {
    $_SESSION['flash'] = ['m' => $msg, 'bad' => $bad];
}

function opRedirect(): void {
    header('Location: ./?action=admin', true, 303);
    exit;
}

function opAdmin(): void {
    opHeaders();
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    header('Cache-Control: no-store');
    $dataOk = opDataReady();
    if ($dataOk) opAdminSession();
    $cfg = opConfig(true);
    $hasAdmin = !empty($cfg['admin_hash']);
    $logged = $dataOk && $hasAdmin && !empty($_SESSION['admin']) && hash_equals((string)($_SESSION['hash_tag'] ?? ''), substr(hash('sha256', (string)$cfg['admin_hash']), 0, 16));
    if ($dataOk && empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
    $csrf = (string)($_SESSION['csrf'] ?? '');

    if ($dataOk && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        if (!hash_equals($csrf, (string)($_POST['csrf'] ?? ''))) { opFlash(opT('Die Seite war zu lange offen. Bitte noch einmal.', 'The page was open too long. Please try again.'), true); opRedirect(); }
        $do = (string)($_POST['do'] ?? '');
        try {
            if (!$hasAdmin && $do === 'setup') {
                $pw = (string)($_POST['pw'] ?? '');
                if (opLen($pw) < OP_ADMIN_MIN) throw new RuntimeException(opT('Das Passwort braucht mindestens ' . OP_ADMIN_MIN . ' Zeichen.', 'The password needs at least ' . OP_ADMIN_MIN . ' characters.'));
                if ($pw !== (string)($_POST['pw2'] ?? '')) throw new RuntimeException(opT('Die beiden Passwörter sind nicht gleich.', 'The two passwords do not match.'));
                $hash = password_hash($pw, PASSWORD_DEFAULT);
                opSet(['admin_hash' => $hash]);
                session_regenerate_id(true);
                $_SESSION['admin'] = true;
                $_SESSION['hash_tag'] = substr(hash('sha256', $hash), 0, 16);
                opFlash(opT('Die Server-Verwaltung ist eingerichtet.', 'The server administration is set up.'));
            } elseif ($hasAdmin && $do === 'login') {
                if (($w = opThrottleWait()) > 0) throw new RuntimeException(opT('Zu viele Fehlversuche. Bitte warte ' . $w . ' Sekunden.', 'Too many failed attempts. Please wait ' . $w . ' seconds.'));
                if (!password_verify((string)($_POST['pw'] ?? ''), (string)$cfg['admin_hash'])) {
                    opThrottleFail();
                    throw new RuntimeException(opT('Falsches Passwort.', 'Wrong password.'));
                }
                opThrottleReset();
                session_regenerate_id(true);
                $_SESSION['admin'] = true;
                $_SESSION['hash_tag'] = substr(hash('sha256', (string)$cfg['admin_hash']), 0, 16);
            } elseif ($logged) {
                switch ($do) {
                    case 'check':
                        $i = opUpdCheck();
                        opFlash(opUpdNewer($i) ? opT('Version ' . $i['v'] . ' ist verfügbar.', 'Version ' . $i['v'] . ' is available.') : opT('Du hast die neueste Version.', 'You have the latest version.'));
                        break;
                    case 'install':
                        $v = opUpdInstall();
                        opSet(['upd_last' => ['v' => $v, 'at' => time(), 'auto' => false]]);
                        opFlash(opT('Version ' . $v . ' ist eingespielt. Die Handys holen sie sich beim nächsten Öffnen der App.', 'Version ' . $v . ' is installed. The phones pick it up the next time the app is opened.'));
                        break;
                    case 'rollback':
                        $v = opUpdRollback();
                        opFlash(opT('Zurück auf Version ' . $v . '.', 'Back to version ' . $v . '.'));
                        break;
                    case 'settings':
                        opSet(['upd_daily' => !empty($_POST['daily']), 'upd_auto' => !empty($_POST['auto'])]);
                        opFlash(opT('Gespeichert.', 'Saved.'));
                        break;
                    case 'pw':
                        if (!password_verify((string)($_POST['old'] ?? ''), (string)$cfg['admin_hash'])) throw new RuntimeException(opT('Das aktuelle Passwort ist falsch.', 'The current password is wrong.'));
                        $pw = (string)($_POST['pw'] ?? '');
                        if (opLen($pw) < OP_ADMIN_MIN) throw new RuntimeException(opT('Das Passwort braucht mindestens ' . OP_ADMIN_MIN . ' Zeichen.', 'The password needs at least ' . OP_ADMIN_MIN . ' characters.'));
                        if ($pw !== (string)($_POST['pw2'] ?? '')) throw new RuntimeException(opT('Die beiden Passwörter sind nicht gleich.', 'The two passwords do not match.'));
                        $hash = password_hash($pw, PASSWORD_DEFAULT);
                        opSet(['admin_hash' => $hash]);
                        $_SESSION['hash_tag'] = substr(hash('sha256', $hash), 0, 16);
                        opFlash(opT('Das Passwort wurde geändert.', 'The password was changed.'));
                        break;
                    case 'logout':
                        $_SESSION = [];
                        session_destroy();
                        opRedirect();
                }
            }
        } catch (Throwable $e) {
            opFlash($e->getMessage(), true);
        }
        opRedirect();
    }

    $flash = $_SESSION['flash'] ?? null;
    unset($_SESSION['flash']);
    header('Content-Type: text/html; charset=utf-8');
    $info = opUpdInfo();
    require OP_APP . '/views/admin.php';
}

/** Zeichen zählen, auch ohne mbstring */
function opLen(string $s): int {
    return (int)preg_match_all('/./us', $s);
}
