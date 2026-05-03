/**
 * Generic Widget Loader for Epistery Agents
 *
 * Scans the page for elements with data-widget attribute and loads
 * widget content from the specified agent.
 *
 * Usage in any page:
 * <div data-widget="requestAccess" data-agent="epistery/wiki" data-list="epistery::read"></div>
 *
 * The widget loader will fetch content from /pages/widgets/[widgetName].html
 * and populate the element.
 */

export class WidgetLoader {
  constructor() {
    this.widgets = new Map();
  }

  /**
   * Execute scripts within a container element
   */
  executeScripts(container) {
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(attr => {
        newScript.setAttribute(attr.name, attr.value);
      });
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  }

  /**
   * Load a single widget into an element
   */
  async loadWidget(element) {
    const widgetName = element.dataset.widget;
    if (!widgetName) return;

    // Collect all data-* attributes as params
    const params = {};
    for (const key in element.dataset) {
      if (key !== 'widget') {
        params[key] = element.dataset[key];
      }
    }

    try {
      // Fetch widget HTML from epistery-host
      const queryString = new URLSearchParams(params).toString();
      const url = `/widgets/${widgetName}.html${queryString ? '?' + queryString : ''}`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[WidgetLoader] Failed to load widget ${widgetName}: ${response.status}`);
        return;
      }

      const html = await response.text();
      element.innerHTML = html;

      // Execute any scripts in the widget
      this.executeScripts(element);

      this.widgets.set(element, widgetName);
      console.log(`[WidgetLoader] Loaded widget: ${widgetName}`);
    } catch (error) {
      console.error(`[WidgetLoader] Error loading widget ${widgetName}:`, error);
    }
  }

  /**
   * Scan page and load all widgets
   */
  async loadAll() {
    const elements = document.querySelectorAll('[data-widget]');
    console.log(`[WidgetLoader] Found ${elements.length} widget(s)`);

    for (const element of elements) {
      await this.loadWidget(element);
    }
  }
}

/**
 * Auto-initialize on page load
 */
if (typeof window !== 'undefined') {
  window.WidgetLoader = WidgetLoader;

  // Auto-load widgets when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      const loader = new WidgetLoader();
      await loader.loadAll();
    });
  } else {
    // DOM already loaded
    const loader = new WidgetLoader();
    loader.loadAll();
  }
}

export default WidgetLoader;
