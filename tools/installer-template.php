<?php
/**
 * OTP-PWA – Installer (Version @@VERSION@@)
 *
 * Diese eine Datei enthält das ganze Programm. Hochladen, im Browser aufrufen, fertig:
 * Sie legt index.php und den Ordner app/ neben sich an und löscht sich danach selbst,
 * ebenso ein OTP-PWA-ZIP aus dem Release, falls eines daneben liegt.
 * Bei einem Update werden nur die Programmdateien ersetzt, der Ordner data/ wird nie angefasst.
 * Die Tresore auf den Handys berührt das ohnehin nicht: die liegen nur auf den Geräten.
 *
 * Erzeugt von tools/build-release.php, nicht von Hand bearbeiten.
 * Lizenz: GNU General Public License v3.0, siehe Datei LICENSE.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

define('OPI_VERSION', '@@VERSION@@');
define('OPI_MIN_PHP', '7.4.0');

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, private');
header('X-Robots-Tag: noindex, nofollow');
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

$opiAl = strtolower(trim(isset($_SERVER['HTTP_ACCEPT_LANGUAGE']) ? (string)$_SERVER['HTTP_ACCEPT_LANGUAGE'] : ''));
$opiEn = $opiAl !== '' && strncmp($opiAl, 'de', 2) !== 0;

/** Deutsch oder Englisch, je nach Browser */
function opiT($de, $en) {
    global $opiEn;
    return $opiEn ? $en : $de;
}

function opiH($s) {
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

/** Die eingepackten Dateien: hinter dem Programmende steht pro Zeile „Pfad, Prüfsumme, Inhalt (Base64)“ */
function opiPayload() {
    $fp = @fopen(__FILE__, 'rb');
    if (!$fp) return null;
    fseek($fp, __COMPILER_HALT_OFFSET__);
    $raw = stream_get_contents($fp);
    fclose($fp);
    $files = array();
    foreach (explode("\n", (string)$raw) as $line) {
        $line = trim($line);
        if ($line === '') continue;
        $p = explode("\t", $line);
        if (count($p) !== 3) return null;
        $path = $p[0];
        if (!preg_match('~^[A-Za-z0-9._\-]+(/[A-Za-z0-9._\-]+)*$~', $path) || strpos($path, '..') !== false) return null;
        $bin = base64_decode($p[2], true);
        if ($bin === false || !hash_equals($p[1], hash('sha256', $bin))) return null;
        $files[$path] = $bin;
    }
    return isset($files['index.php']) ? $files : null;
}

/** Version eines schon vorhandenen OTP-PWA, '' = index.php gehört zu etwas anderem, null = keine da */
function opiInstalledVersion($index) {
    if (!is_file($index)) return null;
    $head = (string)@file_get_contents($index, false, null, 0, 8192);
    if (strpos($head, 'OTP-PWA') !== false && preg_match("~define\\('OP_VERSION',\\s*'([0-9][0-9A-Za-z.\\-]*)'\\)~", $head, $m)) return $m[1];
    return '';
}

/** Schreibt alles erst unter einem Zwischennamen und tauscht dann um. Liefert Fehlertext oder ''. */
function opiInstall($dir, array $files) {
    $tmp = array();
    $fail = '';
    foreach ($files as $path => $bin) {
        $target = $dir . '/' . $path;
        $parent = dirname($target);
        if (!is_dir($parent) && !@mkdir($parent, 0755, true) && !is_dir($parent)) { $fail = $path; break; }
        $t = $target . '.tmp';
        if (@file_put_contents($t, $bin) !== strlen($bin) || hash('sha256', (string)@file_get_contents($t)) !== hash('sha256', $bin)) {
            @unlink($t);
            $fail = $path;
            break;
        }
        $tmp[$t] = $target;
    }
    if ($fail === '') {
        foreach ($tmp as $t => $target) {
            if (!@rename($t, $target)) { $fail = substr($target, strlen($dir) + 1); break; }
            @chmod($target, 0644);
            if (function_exists('opcache_invalidate')) @opcache_invalidate($target, true);
        }
    }
    if ($fail !== '') {
        foreach ($tmp as $t => $target) if (is_file($t)) @unlink($t);
        return $fail;
    }
    // Programmteile, die es in dieser Version nicht mehr gibt, wegräumen (nur .php in app/, sonst nichts)
    foreach (array('lib', 'views', 'assets') as $sub) {
        foreach ((array)@glob($dir . '/app/' . $sub . '/*') as $old) {
            if (!isset($files['app/' . $sub . '/' . basename($old)])) @unlink($old);
        }
    }
    return '';
}

/** OTP-PWA-ZIPs aus dem Release, die neben dem Installer liegen (werden nach der Installation nicht mehr gebraucht) */
function opiZips($dir) {
    $out = array();
    foreach ((array)@glob($dir . '/otp-pwa-*.zip') as $z) {
        if (is_file($z) && preg_match('~^otp-pwa-[0-9][0-9A-Za-z.\-]*\.zip$~', basename($z))) $out[] = $z;
    }
    return $out;
}

$opiDir = __DIR__;
$opiSelf = __FILE__;
$opiIndex = $opiDir . '/index.php';
$opiSelfIsIndex = realpath($opiSelf) === realpath($opiIndex);
$opiFiles = opiPayload();
$opiOld = $opiSelfIsIndex ? null : opiInstalledVersion($opiIndex);
$opiHasData = is_dir($opiDir . '/data');

$opiProblems = array();
if (version_compare(PHP_VERSION, OPI_MIN_PHP, '<')) {
    $opiProblems[] = opiT('OTP-PWA braucht PHP 7.4 oder neuer, hier läuft PHP ', 'OTP-PWA needs PHP 7.4 or newer, this server runs PHP ') . PHP_VERSION . '.';
}
if (!is_writable($opiDir)) {
    $opiProblems[] = opiT('PHP darf in diesen Ordner nicht schreiben. Bitte die Schreibrechte anpassen.', 'PHP is not allowed to write to this folder. Please fix the permissions.');
}
if ($opiFiles === null) {
    $opiProblems[] = opiT('Diese Installer-Datei ist beschädigt (unvollständig hochgeladen?). Bitte noch einmal herunterladen und im Binärmodus hochladen.', 'This installer file is damaged (incomplete upload?). Please download it again and upload it in binary mode.');
}

$opiError = '';
$opiDone = false;
$opiSelfGone = true;
if (!$opiProblems && (isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : '') === 'POST' && isset($_POST['opi_go'])) {
    if ($opiOld === '' && empty($_POST['opi_overwrite'])) {
        $opiError = opiT('Bitte erst bestätigen, dass die vorhandene index.php ersetzt werden darf.', 'Please confirm first that the existing index.php may be replaced.');
    } else {
        $fail = opiInstall($opiDir, $opiFiles);
        if ($fail !== '') {
            $opiError = opiT('Diese Datei ließ sich nicht schreiben: ', 'This file could not be written: ') . $fail
                      . opiT('. Es wurde nichts verändert.', '. Nothing has been changed.');
        } else {
            $opiDone = true;
            foreach (opiZips($opiDir) as $z) @unlink($z);
            if (!$opiSelfIsIndex) {
                @unlink($opiSelf);
                clearstatcache();
                $opiSelfGone = !is_file($opiSelf);
            }
            if ($opiSelfGone) {
                header('Location: index.php');
                exit;
            }
        }
    }
}

$opiTitle = $opiOld ? opiT('OTP-PWA aktualisieren', 'Update OTP-PWA') : opiT('OTP-PWA installieren', 'Install OTP-PWA');
?><!DOCTYPE html>
<html lang="<?php echo $opiEn ? 'en' : 'de'; ?>">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title><?php echo opiH($opiTitle); ?></title>
<style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.25rem;
           background: #0b1120; color: #e2e8f0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card { width: 100%; max-width: 34rem; background: #111a2e; border: 1px solid #26324d; border-radius: 1rem; padding: 1.75rem; }
    h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
    .sub { margin: 0 0 1.25rem; color: #94a3b8; font-size: 0.9rem; }
    ul { margin: 0 0 1.25rem; padding-left: 1.2rem; }
    li { margin-bottom: 0.35rem; }
    code { background: #0b1120; border: 1px solid #26324d; border-radius: 0.35rem; padding: 0.05rem 0.35rem; font-size: 0.85em; }
    .box { border-radius: 0.6rem; padding: 0.7rem 0.85rem; margin-bottom: 1rem; font-size: 0.92rem; }
    .bad { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; }
    .warn { background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4); color: #fcd34d; }
    .good { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; }
    label { display: flex; gap: 0.6rem; align-items: flex-start; margin-bottom: 1rem; font-size: 0.92rem; }
    button, .btn { display: inline-block; width: 100%; border: 0; border-radius: 0.6rem; padding: 0.8rem 1rem; font: inherit; font-weight: 600;
                   color: #fff; background: #1c3f78; cursor: pointer; text-align: center; text-decoration: none; }
    button:hover, .btn:hover { background: #26508f; }
</style>
</head>
<body>
<div class="card">
    <h1><?php echo opiH($opiTitle); ?></h1>
    <p class="sub">Version <?php echo opiH(OPI_VERSION); ?></p>
<?php if ($opiDone): ?>
    <div class="box good"><?php echo opiH(opiT('OTP-PWA ist eingerichtet.', 'OTP-PWA is installed.')); ?></div>
    <div class="box bad"><?php echo opiH(opiT('Diese Installer-Datei ließ sich nicht löschen. Bitte lösche sie jetzt von Hand: ', 'This installer file could not be deleted. Please delete it by hand now: ')); ?><code><?php echo opiH(basename($opiSelf)); ?></code></div>
    <a class="btn" href="index.php"><?php echo opiH(opiT('Weiter zu OTP-PWA', 'Continue to OTP-PWA')); ?></a>
<?php elseif ($opiProblems): ?>
<?php foreach ($opiProblems as $p): ?>
    <div class="box bad"><?php echo opiH($p); ?></div>
<?php endforeach; ?>
    <p class="sub"><?php echo opiH(opiT('Es wurde nichts verändert. Behebe das Problem und lade diese Seite neu.', 'Nothing has been changed. Fix the problem and reload this page.')); ?></p>
<?php else: ?>
<?php if ($opiError !== ''): ?>
    <div class="box bad"><?php echo opiH($opiError); ?></div>
<?php endif; ?>
    <ul>
<?php if ($opiOld): ?>
        <li><?php echo opiH(opiT('Gefunden: OTP-PWA ', 'Found: OTP-PWA ') . $opiOld . opiT('. Es wird auf ', '. It will be updated to ') . OPI_VERSION . opiT(' aktualisiert.', '.')); ?></li>
<?php else: ?>
        <li><?php echo opiT('Legt <code>index.php</code> und den Ordner <code>app/</code> in diesem Verzeichnis an.', 'Creates <code>index.php</code> and the folder <code>app/</code> in this directory.'); ?></li>
<?php endif; ?>
<?php if ($opiHasData): ?>
        <li><?php echo opiT('Der Ordner <code>data/</code> mit den Einstellungen der Server-Verwaltung bleibt unangetastet.', 'The folder <code>data/</code> with the settings of the server administration is left untouched.'); ?></li>
<?php endif; ?>
        <li><?php echo opiH(opiT('Danach löscht sich diese Installer-Datei selbst.', 'Afterwards this installer file deletes itself.')); ?></li>
<?php foreach (opiZips($opiDir) as $z): ?>
        <li><?php echo opiT('Auch <code>', 'Also <code>') . opiH(basename($z)) . opiT('</code> wird gelöscht, die Datei wird dann nicht mehr gebraucht.', '</code> is deleted, the file is no longer needed then.'); ?></li>
<?php endforeach; ?>
<?php if (!$opiOld): ?>
        <li><?php echo opiH(opiT('Danach öffnest du die Seite auf dem Handy und legst sie zum Home-Bildschirm. Der Tresor entsteht erst dort und bleibt auf dem Gerät.', 'Afterwards open the page on your phone and add it to the Home Screen. The vault is created there and stays on the device.')); ?></li>
<?php endif; ?>
    </ul>
    <form method="post">
        <input type="hidden" name="opi_go" value="1">
<?php if ($opiOld === ''): ?>
        <div class="box warn"><?php echo opiT('In diesem Verzeichnis liegt schon eine <code>index.php</code>, die nicht zu OTP-PWA gehört. Sie würde überschrieben.', 'This directory already contains an <code>index.php</code> that does not belong to OTP-PWA. It would be overwritten.'); ?></div>
        <label><input type="checkbox" name="opi_overwrite" value="1"> <span><?php echo opiH(opiT('Ja, die vorhandene index.php darf ersetzt werden.', 'Yes, the existing index.php may be replaced.')); ?></span></label>
<?php endif; ?>
        <button type="submit"><?php echo opiH($opiOld ? opiT('Jetzt aktualisieren', 'Update now') : opiT('Jetzt installieren', 'Install now')); ?></button>
    </form>
<?php endif; ?>
</div>
</body>
</html>
<?php
__halt_compiler();
