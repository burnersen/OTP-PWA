/* OTP-PWA – läuft vor allem anderen: setzt sofort die gespeicherten Farben und Schriftgrößen,
   damit die Seite beim Start nicht kurz im Standard-Design aufblitzt. Alles andere macht app.js. */
(function () {
  try {
    var paint = JSON.parse(localStorage.getItem("op_paint") || "null");
    if (!paint) return;
    var dark = paint.mode === "dark" || (paint.mode !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var vars = dark ? paint.dark : paint.light;
    var root = document.documentElement;
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) root.style.setProperty(k, vars[k]);
    if (paint.fs) root.style.setProperty("--fs", paint.fs);
    if (paint.cs) root.style.setProperty("--cs", paint.cs);
    root.dataset.theme = dark ? "dark" : "light";
  } catch (e) { /* ohne gespeicherte Farben eben im Standard-Design */ }
})();
