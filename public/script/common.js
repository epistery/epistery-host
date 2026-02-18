(async function() {
  'use strict';

  // Load all widgets (header, requestAccess, etc.) — fire and forget, widgets.mjs handles DOM ready
  import('/script/widgets.mjs');

  // Establish epistery session - localStorage identity is permanent, session cookie is the handshake.
  // Always connect so the server knows who we are, regardless of cookie state.
  try {
    const WitnessModule = await import('/lib/witness.js');
    window.epistery = await WitnessModule.default.connect({rootPath:"/"});
    console.log('[Epistery] Connected:', window.epistery?.wallet?.address);
  } catch (error) {
    console.warn('[Epistery] Could not establish session:', error.message);
  }

  // Register service worker to add X-Epistery-Internal header to all requests
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/service-worker.js');
      console.log('[Epistery] Service worker registered:', registration.scope);

      // Wait for service worker to be active
      if (registration.installing) {
        await new Promise((resolve) => {
          registration.installing.addEventListener('statechange', (e) => {
            if (e.target.state === 'activated') {
              resolve();
            }
          });
        });
      }
    } catch (error) {
      console.error('[Epistery] Service worker registration failed:', error);
    }
  }

})();
