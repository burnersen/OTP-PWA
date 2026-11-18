<?php
/**
 * OTP-PWA – Zwei-Faktor-Codes als App fürs Handy, der kleine Bruder von otp-vault
 *
 * Der Server liefert nur die App aus. Einmal auf dem Handy installiert (Zum Home-Bildschirm),
 * läuft sie ganz auf dem Gerät: Tresor, Schlüssel und Konten verlassen das Handy nie.
 * Hier auf dem Server liegen nur das Programm und in data/ die Einstellungen der Server-Verwaltung
 * (Updates). Es gibt keine Datenbank und keine Konten.
 *
 *   app/lib/     Hilfen, Updates, Server-Verwaltung (PHP)
 *   app/views/   die App-Seite und die Server-Verwaltung
 *   app/assets/  die App im Browser (JavaScript, CSS, Symbole), wird über diese Datei ausgeliefert
 *   data/        entsteht beim ersten Aufruf, nur für die Server-Verwaltung
 *
 * Lizenz: GNU General Public License v3.0, siehe Datei LICENSE.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

define('OP_VERSION', '1.0.0');
define('OP_ROOT', __DIR__);
define('OP_APP', OP_ROOT . '/app');
define('OP_DATA_DIR', OP_ROOT . '/data');

require OP_APP . '/lib/common.php';
require OP_APP . '/lib/maint.php';

$action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : '';

/* ---------- Dateien der App: CSS, JavaScript, Symbole ---------- */
if ($action === 'asset') {
    $f = isset($_GET['f']) && is_string($_GET['f']) ? $_GET['f'] : '';
    if (!isset(OP_ASSETS[$f]) || !is_file(OP_APP . '/assets/' . $f)) { http_response_code(404); exit; }
    opHeaders();
    header('Content-Type: ' . OP_ASSETS[$f]);
    header('Cache-Control: ' . (isset($_GET['v']) ? 'public, max-age=31536000, immutable' : 'no-cache'));
    readfile(OP_APP . '/assets/' . $f);
    exit;
}

/* ---------- Service Worker: hält die App auf dem Gerät vor ---------- */
if ($action === 'sw') {
    opHeaders();
    header("Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'");
    header('Content-Type: text/javascript; charset=utf-8');
    header('Cache-Control: no-cache');
    echo 'const OP_V = ' . json_encode(OP_VERSION) . ";\n";
    echo 'const OP_ASSETS = ' . json_encode(array_keys(OP_ASSETS)) . ";\n";
    readfile(OP_APP . '/assets/sw.js');
    opUpdLater();
    exit;
}

if ($action === 'manifest') {
    opHeaders();
    header('Content-Type: application/manifest+json; charset=utf-8');
    header('Cache-Control: no-cache');
    $icon = function (string $f, string $size, string $purpose): array {
        return ['src' => '?action=asset&f=' . $f . '&v=' . OP_VERSION, 'sizes' => $size, 'type' => 'image/png', 'purpose' => $purpose];
    };
    echo json_encode([
        'id' => './', 'name' => 'OTP-PWA', 'short_name' => 'OTP',
        'description' => opT('Zwei-Faktor-Codes, verschlüsselt auf dem Gerät', 'Two-factor codes, encrypted on the device'),
        'start_url' => './', 'scope' => './', 'display' => 'standalone', 'orientation' => 'any', 'lang' => opLang(),
        'background_color' => '#0f1522', 'theme_color' => '#1c3f78',
        'icons' => [
            $icon('icon-192.png', '192x192', 'any'), $icon('icon-512.png', '512x512', 'any'),
            $icon('icon-192.png', '192x192', 'maskable'), $icon('icon-512.png', '512x512', 'maskable'),
        ],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/* ---------- Version für die App (Einstellungen, „Über“) ---------- */
if ($action === 'version') {
    opHeaders();
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $info = opUpdInfo();
    echo json_encode(['version' => OP_VERSION, 'latest' => $info ? $info['v'] : null, 'newer' => opUpdNewer($info)], JSON_UNESCAPED_SLASHES);
    opUpdLater();
    exit;
}

/* ---------- Server-Verwaltung: Updates einspielen, zurück zur vorigen Version ---------- */
if ($action === 'admin') {
    require OP_APP . '/lib/admin.php';
    opAdmin();
    exit;
}

if ($action !== '') { http_response_code(404); exit; }

/* ---------- Die App ---------- */
opHeaders(true);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
require OP_APP . '/views/app.php';
