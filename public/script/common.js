(function() {
  'use strict';

  // Create hamburger button for mobile navigation
  function createHamburger() {
    const nav = document.querySelector('header > nav');
    if (!nav) return null;

    // Check if hamburger already exists
    if (nav.querySelector('.hamburger')) {
      return nav.querySelector('.hamburger');
    }

    const hamburger = document.createElement('button');
    hamburger.className = 'hamburger';
    hamburger.setAttribute('aria-label', 'Toggle navigation menu');
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.innerHTML = '<span></span><span></span><span></span>';

    // Insert hamburger after the logo
    const logo = nav.querySelector('.logo');
    if (logo && logo.nextSibling) {
      nav.insertBefore(hamburger, logo.nextSibling);
    } else {
      nav.appendChild(hamburger);
    }

    return hamburger;
  }

  // Toggle mobile menu
  function setupHamburgerToggle(hamburger, menuContainer) {
    if (!hamburger || !menuContainer) return;

    hamburger.addEventListener('click', function(event) {
      event.stopPropagation();
      const isActive = hamburger.classList.toggle('active');
      menuContainer.classList.toggle('active');
      hamburger.setAttribute('aria-expanded', isActive ? 'true' : 'false');
    });

    // Close menu when clicking outside
    document.addEventListener('click', function(event) {
      if (!hamburger.contains(event.target) && !menuContainer.contains(event.target)) {
        hamburger.classList.remove('active');
        menuContainer.classList.remove('active');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    // Close menu when a link is clicked
    menuContainer.addEventListener('click', function(event) {
      if (event.target.tagName === 'A') {
        hamburger.classList.remove('active');
        menuContainer.classList.remove('active');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Initialize when DOM is ready
  async function init() {
    // Create hamburger
    const hamburger = createHamburger();

    // Load navigation menu dynamically
    try {
      const response = await fetch('/api/nav-menu');
      const html = await response.text();
      const menuContainer = document.getElementById('nav-menu');
      if (menuContainer) {
        menuContainer.innerHTML = html;
        // Setup hamburger toggle after menu is loaded
        setupHamburgerToggle(hamburger, menuContainer);
      }
    } catch (error) {
      console.error('Failed to load navigation menu:', error);
    }
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
