# Hinweise für KI in diesem Projekt

Gilt für jede KI, die hier arbeitet (`AGENTS.md` verweist hierher). Die Datei ist öffentlich.

- **Sprache:** Code (Namen) Englisch, Kommentare Deutsch. README auf Deutsch (`README.md`) und Englisch (`README.en.md`). Oberfläche Deutsch und Englisch (`app/assets/i18n.js`, beide Sprachen mit denselben Schlüsseln).
- Mit dem Benutzer Deutsch, locker, ohne Gedankenstriche. Erst sagen, wie man die Aufgabe verstanden hat, bei Größerem auf ein Okay warten. Befehle als ganzen Block, mit Sicherung vorher und Befehl zum Zurückholen.
- **Vorbilder:** `burnersen/otp-vault` (Tresor-Format, Importe, Exporte, Aussehen) und `burnersen/kaufen` (Installer, Self-Update, Designs, Farbmischer).

## Aufbau

Der Server liefert nur aus (`index.php`), alles Wichtige läuft im Browser. `app/assets/core.js` ist die Übertragung von otp-vault nach JavaScript und muss **byte-kompatibel** zum Tresor-Format von otp-vault bleiben (`vault.go`: Argon2id, XChaCha20-Poly1305, Kopf als zusätzliche Daten). `app/assets/app.js` ist die Oberfläche, Werte aus Tresor und Importen nur mit `textContent`. Kein Framework, kein npm, kein Build-Schritt; Bibliotheken siehe `tools/vendor.md`.

## Befehle

```
node tools/check.js
(cd tools/gocompat && go build -o /tmp/gocompat .) && GOCOMPAT=/tmp/gocompat node tools/check.js
for f in index.php app/lib/*.php app/views/*.php tools/*.php; do php -l "$f"; done
php tools/build-release.php
```

Release: Version in `index.php` (`OP_VERSION`) erhöhen, `.github/release-notes/<Version>.md` schreiben, dann Tag `v<Version>` pushen oder „Release > Run workflow“. Neue Assets in `OP_ASSETS` (`app/lib/common.php`) eintragen, sonst liefert der Server sie nicht aus und der Service Worker hält sie nicht vor.
