const VERSION="0.3.4";
const CACHE="mercado-oliver-"+VERSION;
const SHELL=["./index.html","./manifest.webmanifest","./icon.svg","./version.json"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).catch(()=>{}));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("mercado-oliver-")&&k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("message",event=>{
  if(event.data&&event.data.type==="SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;

  if(url.pathname.endsWith("/version.json")){
    event.respondWith(fetch(req,{cache:"no-store"}).catch(()=>caches.match("./version.json")));
    return;
  }

  if(req.mode==="navigate"){
    event.respondWith(
      fetch(req,{cache:"no-store"}).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put("./index.html",copy)).catch(()=>{});
        return res;
      }).catch(()=>caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    fetch(req).then(res=>{
      if(res&&res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{})}
      return res;
    }).catch(()=>caches.match(req))
  );
});