# Mitgelieferte Bibliotheken

Alles liegt fertig in `app/assets/`, es gibt keinen Build-Schritt. Nur zum Aktualisieren einer Bibliothek:

```sh
mkdir /tmp/vend && cd /tmp/vend && npm init -y
npm i hash-wasm@4.13.0 @noble/ciphers@2.4.0 @noble/hashes@2.4.0 qrcode-generator@2.0.4 esbuild
cp node_modules/hash-wasm/dist/argon2.umd.min.js <repo>/app/assets/argon2.js
cp node_modules/qrcode-generator/dist/qrcode.js <repo>/app/assets/qrcode.js
cat > entry.mjs <<'X'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
globalThis.OPNoble = { xchacha20poly1305, scryptAsync, argon2idAsync };
X
npx esbuild entry.mjs --bundle --minify --format=iife --target=es2020 --legal-comments=inline --outfile=noble.js
```

Davor in `noble.js` die Kopfzeile mit Versionen und Lizenz setzen, danach `node tools/check.js` laufen lassen
und `app/assets/THIRD-PARTY-LICENSES.txt` anpassen. `jsqr.js` ist jsQR 1.4.0 (wie in otp-vault).
