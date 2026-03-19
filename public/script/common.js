(async function() {
  'use strict';

  // Establish epistery session FIRST - all requests require proven identity.
  // localStorage identity is permanent, session cookie is the handshake.
  try {
    const WitnessModule = await import('/lib/witness.js');
    window.epistery = await WitnessModule.default.connect({rootPath:"/"});
    console.log('[Epistery] Connected:', window.epistery?.wallet?.address);
  } catch (error) {
    console.warn('[Epistery] Could not establish session:', error.message);
  }

  // Signal that session setup is complete (success or failure).
  // Agents like wiki wait for this before making authenticated API calls.
  document.dispatchEvent(new CustomEvent('epistery-ready'));

  // Load widgets AFTER identity is established - widgets make authenticated requests
  import('/script/widgets.mjs');

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
