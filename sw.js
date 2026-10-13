// build.sh fills 677893380-2206052 (cksum of the built page sources) and index.html (the page's file name),
// so every rebuild that changes the page also changes sw.js and the browser installs it.
//
// - Cache-first for the page only (the pack is inlined into it). No other URL is stored.
// - A page is only ever cached when it carries this build's marker. A CDN edge can still serve the
//   previous page after a publish; caching that under the new build id would pin the old page until
//   the next publish. Install fails instead, and the browser retries it on a later navigation.
// - The cache name carries the build id; activate deletes this site's caches with any other id.
//   Cache names are keyed by scope, so a site only ever deletes its own caches on a shared origin.
// - Only same-origin requests inside this worker's scope are handled, plus one cross-origin exception: the Python
//   runtime of code answers (https://cdn.jsdelivr.net/pyodide/v0.26.4/, the pinned version). Those files are
//   cache-first in their own cache PREFIX + "pyodide-v0.26.4" (per scope, like every other cache here: two sites on
//   one origin each keep a copy, ~10-25 MB each, and neither can delete the other's). It does not carry the build id
//   and activate keeps it, so a new page build does not make the learner download it again; a new Pyodide version
//   gets a new name and activate drops the old one. The kill switch (sw.disable.js) deletes it with the rest of PREFIX.
//   Pyodide files are always fetched in cors mode (jsdelivr sends Access-Control-Allow-Origin: *), so even the
//   no-cors importScripts request gets a readable response; only res.ok responses are stored, never an opaque or
//   failed one. A missing entry (evicted, or never stored) is simply fetched again. Other cross-origin requests are
//   never intercepted.
// - Any cache failure falls back to the plain network, so the worker never breaks a load.
// - skipWaiting + claim: a new build takes over at once. The open page keeps running on what it
//   already loaded (the page is self-contained); the next load gets the new build.
// Kill switch / rollback: README "Offline use"; never delete a published sw.js.
"use strict";
const BUILD = "677893380-2206052";
const PAGE = "index.html";
const MARK = "<!--pe-build:" + BUILD + "-->";
const SCOPE = self.registration ? self.registration.scope : new URL("./", self.location.href).href;
const PREFIX = "pe:" + new URL(SCOPE).pathname + ":";
const CACHE = PREFIX + BUILD;
const PAGE_URL = new URL(PAGE, SCOPE).href;

const PYODIDE_PREFIX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/";
const PYODIDE_CACHE = PREFIX + "pyodide-v0.26.4";

function pyodideFetch(req){ return fetch(req.url, { mode: "cors", credentials: "omit" }); }
function pyodideResponse(req){
  return caches.open(PYODIDE_CACHE).then(c => c.match(req.url).then(hit => hit || pyodideFetch(req).then(res => {
    if(res.ok && res.type !== "opaque") c.put(req.url, res.clone()).catch(() => {});
    return res;
  }))).catch(() => pyodideFetch(req));
}

function isThisBuild(res){
  if(!res.ok || res.redirected) return Promise.resolve(false);
  return res.clone().text().then(t => t.indexOf(MARK) >= 0);
}

self.addEventListener("install", e => {
  // cache:"reload" bypasses the browser's HTTP cache (Pages sends max-age=600).
  e.waitUntil(caches.open(CACHE)
    .then(c => fetch(new Request(PAGE_URL, { cache: "reload" })).then(res => isThisBuild(res).then(ok => {
      if(!ok) throw new Error("sw: " + PAGE_URL + " is not build " + BUILD + " (status " + res.status + "); retry later");
      return c.put(PAGE_URL, res);
    })))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.indexOf(PREFIX) === 0 && k !== CACHE && k !== PYODIDE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function pageResponse(req){
  return caches.open(CACHE).then(c => c.match(PAGE_URL).then(hit => hit || fetch(req).then(res => {
    if(!res.ok || res.redirected) return res;
    const copy = res.clone();
    return isThisBuild(copy).then(ok => ok ? c.put(PAGE_URL, copy) : null).catch(() => null).then(() => res);
  }))).catch(() => fetch(req));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  if(url.href.indexOf(PYODIDE_PREFIX) === 0){ e.respondWith(pyodideResponse(req)); return; }
  if(url.href.indexOf(SCOPE) !== 0) return; // other origins: network only
  const rel = url.pathname.slice(new URL(SCOPE).pathname.length);
  if(rel === "" || rel === PAGE){ e.respondWith(pageResponse(req)); return; }
  if(req.mode === "navigate"){
    e.respondWith(fetch(req).catch(() => caches.open(CACHE).then(c => c.match(PAGE_URL)).then(hit => hit || Response.error(), () => Response.error())));
  }
});
