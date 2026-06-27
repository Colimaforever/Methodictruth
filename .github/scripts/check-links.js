const fs = require('fs');
const path = require('path');

const root = process.cwd();
const files = fs.readdirSync(root).filter(f => f.endsWith('.html'));

const linkRe = /\b(?:href|src)\s*=\s*["']([^"']+)["']/g;
const problems = [];

for (const file of files) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  let m;
  while ((m = linkRe.exec(content))) {
    const url = m[1];
    if (url.includes('${')) continue; // JS template literal inside <script>, not real markup
    if (/^(https?:|mailto:|tel:|javascript:|data:|#)/.test(url)) continue;
    if (url.startsWith('//')) continue;
    const clean = url.split('#')[0].split('?')[0];
    if (!clean) continue;
    const direct = path.join(root, clean);
    const withHtml = clean.endsWith('.html') ? direct : direct + '.html';
    if (!fs.existsSync(direct) && !fs.existsSync(withHtml)) {
      problems.push(`${file} -> ${url}`);
    }
  }
}

if (problems.length) {
  console.error('Broken local links/assets found:');
  problems.forEach(p => console.error('  ' + p));
  process.exit(1);
}
console.log(`OK: checked ${files.length} HTML files, no broken local links/assets.`);
