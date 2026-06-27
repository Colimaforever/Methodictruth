const fs = require('fs');
const path = require('path');

const root = process.cwd();
const files = fs.readdirSync(root).filter(f => f.endsWith('.html'));

const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
const errors = [];
let count = 0;

for (const file of files) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  let m;
  while ((m = scriptRe.exec(content))) {
    count++;
    try {
      JSON.parse(m[1]);
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
}

if (errors.length) {
  console.error('Invalid JSON-LD found:');
  errors.forEach(e => console.error('  ' + e));
  process.exit(1);
}
console.log(`OK: validated ${count} JSON-LD block(s) across ${files.length} HTML files.`);
