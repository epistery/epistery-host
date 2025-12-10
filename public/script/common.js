(async function() {
  'use strict';

  // Load navigation menu dynamically
  try {
    const response = await fetch('/api/nav-menu');
    const html = await response.text();
    const menuContainer = document.getElementById('nav-menu');
    menuContainer.innerHTML = html;
  } catch (error) {
    console.error('Failed to load navigation menu:', error);
  }

})();
