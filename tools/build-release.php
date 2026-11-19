<?php
/**
 * OTP-PWA – Release bauen (nur für die Kommandozeile, Nutzer brauchen das nie)
 *
 *   php tools/build-release.php
 *
 * Legt im Ordner dist/ drei Dateien an:
 *   otp-pwa-install.php      eine einzige Datei zum Hochladen, entpackt sich im Browser selbst
 *   otp-pwa-<Version>.zip    alle Dateien zum Entpacken von Hand
 *   SHA256SUMS.txt           Prüfsummen der beiden
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$root = dirname(__DIR__);
$dist = $root . '/dist';

$index = (string)file_get_contents($root . '/index.php');
if (!preg_match("~define\\('OP_VERSION',\\s*'([0-9][0-9A-Za-z.\\-]*)'\\)~", $index, $m)) {
    fwrite(STDERR, "OP_VERSION nicht in index.php gefunden.\n");
    exit(1);
}
$version = $m[1];

// Was zum Programm gehört: index.php, LICENSE und alles unter app/
$files = ['index.php', 'LICENSE'];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/app', FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if ($f->isFile()) $files[] = str_replace('\\', '/', substr($f->getPathname(), strlen($root) + 1));
}
sort($files, SORT_STRING);
foreach ($files as $path) {
    if (!preg_match('~^(?:index\.php|LICENSE|app(?:/[A-Za-z0-9._\-]+)+)$~', $path)) {
        fwrite(STDERR, "Ungültiger Dateiname (nur A-Z, 0-9, Punkt, Strich, Unterstrich): $path\n");
        exit(1);
    }
}

if (!is_dir($dist) && !mkdir($dist, 0755, true)) {
    fwrite(STDERR, "dist/ konnte nicht angelegt werden.\n");
    exit(1);
}

// 1) Installer: Vorlage + eingepackte Dateien (Pfad, SHA-256, Base64 pro Zeile)
$tpl = (string)file_get_contents(__DIR__ . '/installer-template.php');
if (substr_count($tpl, '__halt_compiler();') !== 1) {
    fwrite(STDERR, "Die Installer-Vorlage muss genau einmal mit __halt_compiler(); enden.\n");
    exit(1);
}
$out = str_replace('@@VERSION@@', $version, rtrim($tpl)) . "\n";
foreach ($files as $path) {
    $bin = (string)file_get_contents($root . '/' . $path);
    $out .= $path . "\t" . hash('sha256', $bin) . "\t" . base64_encode($bin) . "\n";
}
$installer = $dist . '/otp-pwa-install.php';
file_put_contents($installer, $out);
printf("%s  (%d Dateien, %d KB)\n", 'dist/otp-pwa-install.php', count($files), (int)round(strlen($out) / 1024));
$sums = hash_file('sha256', $installer) . "  otp-pwa-install.php\n";

// 2) ZIP zum Entpacken von Hand, alles in einem Ordner otp-pwa/
if (class_exists('ZipArchive')) {
    $name = 'otp-pwa-' . $version . '.zip';
    $zipPath = $dist . '/' . $name;
    if (is_file($zipPath)) unlink($zipPath);
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE) !== true) {
        fwrite(STDERR, "ZIP konnte nicht angelegt werden.\n");
        exit(1);
    }
    foreach (array_merge($files, ['README.md', 'README.en.md']) as $path) {
        if (is_file($root . '/' . $path)) $zip->addFile($root . '/' . $path, 'otp-pwa/' . $path);
    }
    $zip->close();
    printf("%s  (%d KB)\n", 'dist/' . $name, (int)round(filesize($zipPath) / 1024));
    $sums .= hash_file('sha256', $zipPath) . '  ' . $name . "\n";
} else {
    echo "Hinweis: PHP-Erweiterung zip fehlt, das ZIP wurde ausgelassen.\n";
}
file_put_contents($dist . '/SHA256SUMS.txt', $sums);
echo "dist/SHA256SUMS.txt\n";
