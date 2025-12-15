(async function() {
  'use strict';

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

  // Load navigation menu dynamically
  try {
    const response = await fetch('/api/nav-menu');
    const html = await response.text();

    // Declare both desktop and mobile layouts
    const headerControls = document.createElement('div');
    headerControls.id = "header-controls";
    headerControls.innerHTML = `
        <span class="nav-menu">${html}</span>
        <a title='Identity' class='identity-icon' href="/status">👤</a>`;
    const mobileControls = document.createElement('div');
    mobileControls.id = "mobile-controls";
    mobileControls.innerHTML = `
        <button class="hamburger">
            <span></span>
            <span></span>
            <span></span>
        </button>
        <div id="side-bar">
          <a title='Identity' class='identity-icon' href="/status">👤</a>
          <span class="nav-menu">${html}</span>
        </div>`;

    const nav = document.querySelector('header nav');
    nav.appendChild(headerControls);
    nav.appendChild(mobileControls);

    // Set up hamburger menu toggle
    const hamburger = mobileControls.querySelector('.hamburger');
    const sideBar = mobileControls.querySelector('#side-bar');

    if (hamburger && sideBar) {
      hamburger.addEventListener('click', (e) => {
        e.stopPropagation();
        hamburger.classList.toggle('active');
        sideBar.classList.toggle('active');
      });

      // Close menu when clicking outside
      document.addEventListener('click', (e) => {
        if (!sideBar.contains(e.target) && !hamburger.contains(e.target)) {
          hamburger.classList.remove('active');
          sideBar.classList.remove('active');
        }
      });

      // Prevent clicks inside menu from closing it
      sideBar.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
  } catch (error) {
    console.error('Failed to load navigation menu:', error);
  }

})();
