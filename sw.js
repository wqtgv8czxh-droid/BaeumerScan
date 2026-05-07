// Bäumer Docs — Service Worker
// Handles Web Share Target file reception

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only intercept POST requests to /?share-target
  if (event.request.method !== 'POST' || !url.searchParams.has('share-target')) {
    return;
  }

  event.respondWith((async () => {
    try {
      const formData = await event.request.formData();
      const file = formData.get('file');

      if (file) {
        // Store file in cache so the app can pick it up after redirect
        const cache = await caches.open('share-target-cache');
        await cache.put('/share-file', new Response(file, {
          headers: { 'Content-Type': file.type }
        }));
      }
    } catch (e) {
      console.error('Share target SW error:', e);
    }

    // Redirect to app with marker param
    return Response.redirect('/?share-target', 303);
  })());
});
