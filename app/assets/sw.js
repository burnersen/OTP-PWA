/* OTP-PWA – Service Worker. Hält die App (Seite, CSS, JavaScript, Symbole) auf dem Gerät vor,
   damit sie ohne Netz startet und nach dem ersten Aufruf nur noch lokal läuft.
   Daten speichert er nie, den Tresor verwaltet app.js selbst in IndexedDB.
   OP_V (Version) und OP_ASSETS (Dateien) setzt index.php davor.

   Updates: Ändert sich die Version auf dem Server, lädt der Browser diesen Worker neu, er legt die neuen
   Dateien in einen eigenen Zwischenspeicher und wartet. Erst wenn man in der App „Aktualisieren“ tippt
   (oder die App ganz geschlossen war), übernimmt die neue Version. */
const CACHE = "otp-pwa-" + OP_V;
const PAGE = "./";

function assetUrl(f) {
  return "./?action=asset&f=" + encodeURIComponent(f) + "&v=" + encodeURIComponent(OP_V);
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(
    [PAGE, "./?action=manifest"].concat(OP_ASSETS.map(assetUrl)).map((u) => new Request(u, { cache: "reload", credentials: "same-origin" }))
  )));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("otp-pwa-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const action = url.searchParams.get("action");
  const isPage = req.mode === "navigate" && !action && url.pathname === new URL(PAGE, self.registration.scope).pathname;
  const isAsset = action === "asset" || action === "manifest";
  if (!isPage && !isAsset) return; // alles andere (Server-Verwaltung, Versionsabfrage) geht direkt ans Netz
  // Erst aus dem eigenen Zwischenspeicher, nur wenn dort nichts ist, aus dem Netz
  e.respondWith(caches.open(CACHE).then((c) => c.match(isPage ? PAGE : req, { ignoreSearch: false }).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res.ok && isAsset) c.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => (isPage ? c.match(PAGE) : undefined).then((r) => r || Response.error()));
  })));
});
