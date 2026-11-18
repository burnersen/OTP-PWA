<?php
/* OTP-PWA – Seite der Server-Verwaltung. Schlicht und ohne JavaScript, alles über Formulare. */
defined('OP_VERSION') || exit;
$prev = $dataOk ? opUpdPrev() : '';
$writable = opUpdWritable();
$newer = opUpdNewer($info);
$last = $cfg['upd_last'] ?? null;
?><!DOCTYPE html>
<html lang="<?php echo opLang(); ?>">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title><?php echo opH(opT('OTP-PWA – Server-Verwaltung', 'OTP-PWA – server administration')); ?></title>
<style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: calc(1.25rem + env(safe-area-inset-top)) 1rem 2rem; background: #f3f5f9; color: #1b2333;
           font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    @media (prefers-color-scheme: dark) { body { background: #0f1522; color: #e7ecf5; } .card { background: #182133 !important; border-color: #2a3650 !important; }
        .sub, .muted { color: #9aa6bd !important; } input[type=password] { background: #0f1522 !important; color: #e7ecf5 !important; border-color: #2a3650 !important; }
        pre { background: #0f1522 !important; border-color: #2a3650 !important; } .btn.ghost { background: #182133 !important; color: #e7ecf5 !important; border-color: #2a3650 !important; } }
    .wrap { max-width: 40rem; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: .8rem; margin-bottom: 1rem; }
    .head img { border-radius: 12px; }
    h1 { margin: 0; font-size: 1.35rem; }
    h2 { margin: 0 0 .6rem; font-size: 1.05rem; }
    .sub, .muted { color: #5b6578; font-size: .9rem; margin: 0; }
    .card { background: #fff; border: 1px solid #dde3ee; border-radius: 1rem; padding: 1.1rem 1.2rem; margin-bottom: 1rem; }
    .box { border-radius: .7rem; padding: .7rem .9rem; margin-bottom: 1rem; font-size: .95rem; }
    .bad { background: rgba(179, 38, 30, .1); border: 1px solid rgba(179, 38, 30, .4); color: #b3261e; }
    .good { background: rgba(30, 142, 90, .1); border: 1px solid rgba(30, 142, 90, .4); color: #1e8e5a; }
    .warn { background: rgba(255, 196, 0, .15); border: 1px solid rgba(255, 196, 0, .6); }
    label.f { display: block; margin-bottom: .7rem; font-size: .9rem; font-weight: 600; }
    input[type=password] { display: block; width: 100%; margin-top: .25rem; padding: .7rem .8rem; border: 1px solid #dde3ee; border-radius: .7rem; font: inherit; font-size: 16px; }
    label.c { display: flex; gap: .6rem; align-items: flex-start; margin: .5rem 0; }
    label.c input { width: 1.2rem; height: 1.2rem; margin-top: .15rem; }
    .btn { display: inline-block; border: 0; border-radius: .7rem; padding: .7rem 1.1rem; font: inherit; font-weight: 650; color: #fff; background: #1c3f78; cursor: pointer; text-decoration: none; margin: .2rem .3rem .2rem 0; }
    .btn.ghost { background: #fff; color: #1b2333; border: 1px solid #dde3ee; }
    .btn.amber { background: #ffc400; color: #1c3f78; }
    .row { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
    table { border-collapse: collapse; width: 100%; font-size: .95rem; }
    td { padding: .3rem 0; vertical-align: top; } td:first-child { color: #5b6578; width: 45%; }
    pre { white-space: pre-wrap; background: #f3f5f9; border: 1px solid #dde3ee; border-radius: .6rem; padding: .7rem; font-size: .85rem; max-height: 16rem; overflow: auto; }
    code { font-size: .88em; }
</style>
</head>
<body>
<div class="wrap">
    <div class="head">
        <img src="?action=asset&amp;f=logo.png&amp;v=<?php echo opH(OP_VERSION); ?>" alt="" width="48" height="48">
        <div>
            <h1><?php echo opH(opT('Server-Verwaltung', 'Server administration')); ?></h1>
            <p class="sub">OTP-PWA <?php echo opH(OP_VERSION); ?> · <a href="./"><?php echo opH(opT('Zurück zur App', 'Back to the app')); ?></a></p>
        </div>
    </div>

<?php if (!$dataOk): ?>
    <div class="box bad"><?php echo opT('PHP darf den Ordner <code>data/</code> nicht anlegen oder beschreiben. Die App selbst läuft trotzdem, nur Updates per Knopfdruck gehen dann nicht. Bitte die Schreibrechte im Ordner von OTP-PWA prüfen.', 'PHP cannot create or write the folder <code>data/</code>. The app itself still works, only updates at the push of a button do not. Please check the permissions of the OTP-PWA folder.'); ?></div>
<?php elseif (!$hasAdmin): ?>
    <div class="card">
        <h2><?php echo opH(opT('Passwort für die Server-Verwaltung festlegen', 'Set a password for the server administration')); ?></h2>
        <p class="muted"><?php echo opH(opT('Damit spielst du später Updates ein. Es hat nichts mit dem Master-Passwort deines Tresors zu tun: der Server kennt deine Konten nicht. Wer diese Seite als Erster aufruft, legt das Passwort fest, also gleich erledigen.', 'With it you install updates later. It has nothing to do with the master password of your vault: the server does not know your accounts. Whoever opens this page first sets the password, so do it now.')); ?></p>
<?php if ($flash): ?>
        <div class="box <?php echo $flash['bad'] ? 'bad' : 'good'; ?>"><?php echo opH($flash['m']); ?></div>
<?php endif; ?>
        <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>">
            <input type="hidden" name="do" value="setup">
            <input type="text" name="username" value="OTP-PWA admin" autocomplete="username" hidden>
            <label class="f"><?php echo opH(opT('Passwort (mindestens 10 Zeichen)', 'Password (at least 10 characters)')); ?><input type="password" name="pw" autocomplete="new-password" required minlength="10"></label>
            <label class="f"><?php echo opH(opT('Passwort wiederholen', 'Repeat the password')); ?><input type="password" name="pw2" autocomplete="new-password" required minlength="10"></label>
            <button class="btn" type="submit"><?php echo opH(opT('Festlegen', 'Set password')); ?></button>
        </form>
    </div>
<?php elseif (!$logged): ?>
    <div class="card">
        <h2><?php echo opH(opT('Anmelden', 'Log in')); ?></h2>
<?php if ($flash): ?>
        <div class="box <?php echo $flash['bad'] ? 'bad' : 'good'; ?>"><?php echo opH($flash['m']); ?></div>
<?php endif; ?>
        <form method="post">
            <input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>">
            <input type="hidden" name="do" value="login">
            <input type="text" name="username" value="OTP-PWA admin" autocomplete="username" hidden>
            <label class="f"><?php echo opH(opT('Passwort der Server-Verwaltung', 'Password of the server administration')); ?><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
            <button class="btn" type="submit"><?php echo opH(opT('Anmelden', 'Log in')); ?></button>
        </form>
    </div>
<?php else: ?>
<?php if ($flash): ?>
    <div class="box <?php echo $flash['bad'] ? 'bad' : 'good'; ?>"><?php echo opH($flash['m']); ?></div>
<?php endif; ?>
<?php if ($writable !== ''): ?>
    <div class="box warn"><?php echo opH(opT('PHP darf diese Programmdatei nicht überschreiben: ', 'PHP cannot overwrite this program file: ')); ?><code><?php echo opH($writable); ?></code>. <?php echo opH(opT('Updates per Knopfdruck gehen erst, wenn das geht. Von Hand: neuen Installer hochladen und aufrufen.', 'Updates at the push of a button need that. By hand: upload the new installer and open it.')); ?></div>
<?php endif; ?>
    <div class="card">
        <h2><?php echo opH(opT('Updates', 'Updates')); ?></h2>
        <table>
            <tr><td><?php echo opH(opT('Auf dem Server', 'On the server')); ?></td><td><b><?php echo opH(OP_VERSION); ?></b></td></tr>
            <tr><td><?php echo opH(opT('Neueste auf GitHub', 'Latest on GitHub')); ?></td><td><?php echo $info ? '<b>' . opH($info['v']) . '</b>' . ($info['page'] !== '' ? ' · <a href="' . opH($info['page']) . '" rel="noopener noreferrer" target="_blank">' . opH(opT('Release ansehen', 'View release')) . '</a>' : '') : opH(opT('noch nicht nachgesehen', 'not checked yet')); ?></td></tr>
            <tr><td><?php echo opH(opT('Zuletzt nachgesehen', 'Last checked')); ?></td><td><?php echo !empty($cfg['upd_at']) ? opH(date('d.m.Y H:i', (int)$cfg['upd_at'])) : '–'; ?></td></tr>
<?php if (is_array($last)): ?>
            <tr><td><?php echo opH(opT('Letztes Update', 'Last update')); ?></td><td><?php echo opH($last['v'] . ' · ' . date('d.m.Y H:i', (int)$last['at']) . (!empty($last['auto']) ? opT(' (automatisch)', ' (automatic)') : '')); ?></td></tr>
<?php endif; ?>
<?php if (!empty($cfg['upd_error']) && (int)($cfg['upd_error_at'] ?? 0) > (int)($cfg['upd_at'] ?? 0) - 60): ?>
            <tr><td><?php echo opH(opT('Letzter Fehler', 'Last error')); ?></td><td><?php echo opH($cfg['upd_error']); ?></td></tr>
<?php endif; ?>
        </table>
<?php if ($newer && $info['notes'] !== ''): ?>
        <p class="muted"><?php echo opH(opT('Was neu ist:', 'What is new:')); ?></p>
        <pre><?php echo opH($info['notes']); ?></pre>
<?php endif; ?>
        <div class="row">
            <form method="post"><input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>"><input type="hidden" name="do" value="check"><button class="btn ghost" type="submit"><?php echo opH(opT('Jetzt nach Updates suchen', 'Check for updates now')); ?></button></form>
<?php if ($newer): ?>
            <form method="post"><input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>"><input type="hidden" name="do" value="install"><button class="btn amber" type="submit"><?php echo opH(opT('Jetzt auf ' . $info['v'] . ' aktualisieren', 'Update to ' . $info['v'] . ' now')); ?></button></form>
<?php endif; ?>
<?php if ($prev !== ''): ?>
            <form method="post"><input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>"><input type="hidden" name="do" value="rollback"><button class="btn ghost" type="submit"><?php echo opH(opT('Zurück zu Version ' . $prev, 'Back to version ' . $prev)); ?></button></form>
<?php endif; ?>
        </div>
        <p class="muted"><?php echo opH(opT('Das Update prüft die Datei per Prüfsumme und legt die laufende Version vorher zur Seite. Die Handys holen sich die neue Version beim nächsten Öffnen der App und fragen, bevor sie wechseln. Der Tresor auf den Handys bleibt dabei unangetastet.', 'The update checks the file by checksum and puts the running version aside first. The phones fetch the new version the next time the app is opened and ask before switching. The vault on the phones is not touched.')); ?></p>
    </div>

    <div class="card">
        <h2><?php echo opH(opT('Automatisch', 'Automatic')); ?></h2>
        <form method="post">
            <input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>">
            <input type="hidden" name="do" value="settings">
            <label class="c"><input type="checkbox" name="daily" value="1"<?php echo ($cfg['upd_daily'] ?? true) ? ' checked' : ''; ?>><span><?php echo opH(opT('Einmal am Tag bei GitHub nach einer neuen Version sehen', 'Check GitHub for a new version once a day')); ?></span></label>
            <label class="c"><input type="checkbox" name="auto" value="1"<?php echo !empty($cfg['upd_auto']) ? ' checked' : ''; ?>><span><?php echo opH(opT('Neue Versionen gleich selbst einspielen (zurück geht hier jederzeit)', 'Install new versions on its own (going back is always possible here)')); ?></span></label>
            <button class="btn ghost" type="submit"><?php echo opH(opT('Speichern', 'Save')); ?></button>
        </form>
    </div>

    <div class="card">
        <h2><?php echo opH(opT('Passwort der Server-Verwaltung ändern', 'Change the password of the server administration')); ?></h2>
        <form method="post" autocomplete="off">
            <input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>">
            <input type="hidden" name="do" value="pw">
            <input type="text" name="username" value="OTP-PWA admin" autocomplete="username" hidden>
            <label class="f"><?php echo opH(opT('Aktuelles Passwort', 'Current password')); ?><input type="password" name="old" autocomplete="current-password" required></label>
            <label class="f"><?php echo opH(opT('Neues Passwort (mindestens 10 Zeichen)', 'New password (at least 10 characters)')); ?><input type="password" name="pw" autocomplete="new-password" required minlength="10"></label>
            <label class="f"><?php echo opH(opT('Neues Passwort wiederholen', 'Repeat the new password')); ?><input type="password" name="pw2" autocomplete="new-password" required minlength="10"></label>
            <button class="btn ghost" type="submit"><?php echo opH(opT('Passwort ändern', 'Change password')); ?></button>
        </form>
    </div>

    <form method="post"><input type="hidden" name="csrf" value="<?php echo opH($csrf); ?>"><input type="hidden" name="do" value="logout"><button class="btn ghost" type="submit"><?php echo opH(opT('Abmelden', 'Log out')); ?></button></form>
<?php endif; ?>
</div>
</body>
</html>
