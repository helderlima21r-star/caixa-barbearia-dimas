// Painel do robô: guarda os arquivos para abrir rápido e mostra os avisos (notificações) no celular.
const CACHE = "painel-v1";
const FILES = ["./", "index.html", "painel.css", "app.js", "manifest.webmanifest", "../style.css", "../config.js", "../vendor/supabase-2.119.0.js", "../icons/logo-topo.png", "../icons/logo.png", "icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("painel-") && k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // rede primeiro, cache como reserva
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { corpo: e.data && e.data.text() }; }
  const titulo = d.titulo || "Dimas Corts";
  e.waitUntil(self.registration.showNotification(titulo, {
    body: d.corpo || "Mensagem nova no WhatsApp",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.waId || "painel",
    renotify: true,
    data: { waId: d.waId || null }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const waId = e.notification.data && e.notification.data.waId;
  const alvo = new URL(waId ? "./?c=" + encodeURIComponent(waId) : "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const abertos = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abertos) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.postMessage({ abrir: waId });
        return;
      }
    }
    await self.clients.openWindow(alvo);
  })());
});
