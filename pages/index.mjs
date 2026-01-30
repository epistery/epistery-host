import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Pages {
  constructor(options) {
    this.rootPath = join(__dirname, 'public/pages');
    this.options = options || {};
    this.templates = {};
  }

  render(page,args) {
    try {
      let html = this.templates[page];
      if (!html) {
        this.templates[page] = new TemplateFile(join(__dirname, `${page}.html`));
      }
      return this.templates[page].parse(args);
    } catch(e) {
      console.error(e);
      return "Page not found";
    }
  }

  attach(app) {
    // Serve template pages (for iframing into agent admin pages)
    app.get('/page/:page', (req, res) => {
      res.set('Content-Type', 'text/html');
      res.send(this.render(req.params.page, {}));
    });
  }
}
class TemplateText {
  constructor(template) {
    this.template = template;
  }
  parse(data) {
    return this.template.replace(/\{\{([a-zA-Z0-9.]*)\}\}/g,(match, reference) => {
      return reference.split('.').reduce((acc, key) => {
        return acc && acc[key] !== undefined ? acc[key] : undefined;
      }, data);
    })
  }
}
class TemplateFile {
  constructor(filePath) {
    let fileData = readFileSync(filePath, 'utf8');
    if (!fileData) throw new Error(`Page not found`);
    return new TemplateText(fileData.toString());
  }
}
