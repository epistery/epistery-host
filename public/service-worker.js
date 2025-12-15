/**
 * Epistery Service Worker
 * Adds X-Epistery-Internal header to all requests for backstage DNS routing
 */

self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activating');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only intercept requests to our own origin (relative paths)
  // Skip external CDN URLs and other origins
  if (url.origin !== self.location.origin) {
    return;
  }

  // Don't modify API requests or auth-related requests
  // Only add header for static resources and page navigation
  const isApiRequest = url.pathname.startsWith('/api/') ||
                       url.pathname.includes('/agent/') && request.method !== 'GET';

  if (isApiRequest) {
    // Pass through without modification
    event.respondWith(fetch(request));
    return;
  }

  // Clone the request and add X-Epistery-Internal header for static resources
  const modifiedRequest = new Request(request, {
    headers: new Headers({
      ...Object.fromEntries(request.headers.entries()),
      'X-Epistery-Internal': 'true'
    })
  });

  event.respondWith(fetch(modifiedRequest));
});
