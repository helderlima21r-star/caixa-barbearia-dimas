// Guarda os arquivos do app para abrir rápido e mesmo com internet fraca.
// Os dados (Supabase) sempre vêm da rede.
const CACHE = "caixa-v3";
const FILES = ["./", "index.html", "style.css", "app.js", "config.js", "vendor/supabase-2.119.0.js", "manifest.webmanifest", "icons/favicon.png", "icons/icon-192.png", "icons/logo.png", "icons/logo-topo.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // rede primeiro, cache como reserva: atualizações aparecem logo
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
