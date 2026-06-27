const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = process.env.PREVIEW_BASE_URL || 'http://localhost:8080';
const OUT_DIR = process.env.PREVIEW_OUT_DIR || path.join(process.cwd(), 'pr-previews-out');
const EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;

// Same curated set used for the OG images. The vault page is deliberately
// excluded: the repo is public, and publishing rendered screenshots of it
// anywhere public would defeat its password gate.
const PAGES = [
  { slug: 'index', path: '/index.html' },
  { slug: 'chronicles', path: '/chronicles.html' },
  { slug: 'changelog', path: '/changelog.html' },
  { slug: 'directory', path: '/directory.html' },
  { slug: 'architecture', path: '/architecture.html' },
  { slug: 'synth', path: '/synth.html' },
  { slug: 'theory', path: '/theory.html' },
  { slug: 'about', path: '/about.html' },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  for (const { slug, path: route } of PAGES) {
    const url = BASE_URL + route;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT_DIR, `${slug}.png`) });
      console.log(`OK: ${slug} -> ${slug}.png`);
    } catch (e) {
      console.error(`FAILED: ${slug} (${url}): ${e.message}`);
      process.exitCode = 1;
    }
  }

  await browser.close();
}

main();
