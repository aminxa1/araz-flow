const CACHE_NAME='araz-flow-shell-210004';
const APP_SHELL=[
  './index.html',
  './styles.css?v=210004',
  './app.js?v=210004',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async url=>{
      try{
        const response=await fetch(url,{cache:'reload'});
        if(response.ok)await cache.put(url,response.clone());
      }catch{}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('araz-flow-shell-')&&k!==CACHE_NAME).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(request,cacheKey=request){
  const cache=await caches.open(CACHE_NAME);
  try{
    const response=await fetch(request,{cache:'no-store'});
    if(response&&response.ok)await cache.put(cacheKey,response.clone());
    return response;
  }catch(err){
    const cached=await cache.match(cacheKey);
    if(cached)return cached;
    throw err;
  }
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;

  if(url.pathname.endsWith('/version.json')){
    event.respondWith(fetch(event.request,{cache:'no-store'}));
    return;
  }

  if(event.request.mode==='navigate'){
    event.respondWith(networkFirst(event.request,'./index.html'));
    return;
  }

  const critical=/\/(app\.js|styles\.css)$/.test(url.pathname);
  if(critical){
    event.respondWith(networkFirst(event.request,event.request));
    return;
  }

  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(event.request);
    if(cached)return cached;
    try{
      const response=await fetch(event.request);
      if(response&&response.ok)await cache.put(event.request,response.clone());
      return response;
    }catch(err){
      throw err;
    }
  })());
});
