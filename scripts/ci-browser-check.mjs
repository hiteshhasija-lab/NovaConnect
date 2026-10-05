// CI browser check (run by .github/workflows/ci-cd.yml after the fresh install starts).
//
// The NOVAAPP01 lab runs in development mode, which sends no Content-Security-Policy, so a page
// that loads a new outside script, style, font, iframe or media source works there and only breaks
// on real (production-mode) installs — exactly what the first production install found (#24).
// This drives a real Chromium against the fresh compose install (production mode, full CSP) and
// fails on any blocked resource, CSP violation or JavaScript error:
//   sign in as the first admin -> every main view in the workspace -> a meeting, joined with
//   Chromium's fake camera and microphone (so the media client and devices code run too).
//
//   BASE_URL (default http://localhost:8080), ADMIN_USERNAME (default admin), ADMIN_PASSWORD
//   Needs the 'playwright' package and its Chromium (the workflow installs both).
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('ADMIN_PASSWORD is not set.'); process.exit(2); }

const problems = [];
const where = (page) => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };
const step = (name) => console.log(`- ${name}`);

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
// Report every CSP violation the page sees, including inline scripts and handlers.
await context.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`CSP blocked ${e.blockedURI || 'inline code'} (${e.effectiveDirective})`);
  });
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error on ${where(page)}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`JavaScript error on ${where(page)}: ${e.message}`));
page.on('requestfailed', (r) => {
  const err = r.failure()?.errorText || '';
  // Navigations away from a page abort its pending requests; that's not a problem.
  if (err.includes('ERR_ABORTED')) return;
  problems.push(`request failed on ${where(page)}: ${r.url()} (${err})`);
});

try {
  step('sign in');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#loginUsername', USER);
  await page.fill('#loginPassword', PASS);
  await Promise.all([page.waitForURL(/\/app/, { timeout: 15000 }), page.click('form[action="/login"] button[type="submit"]')]);

  for (const view of ['Teams', 'Chat', 'Activity', 'Meet', 'People', 'Calendar']) {
    step(`workspace: ${view}`);
    await page.click(`#rail${view}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
  }

  step('meeting: create a link and open it');
  const link = await page.evaluate(async () => {
    const r = await fetch('/api/meet/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'CI browser check' }) });
    if (!r.ok) throw new Error(`creating a meeting link: HTTP ${r.status}`);
    return r.json();
  });
  await page.goto(`${BASE}/app/meet/${link.code}`, { waitUntil: 'networkidle' });

  step('meeting: join with fake camera and microphone');
  await page.check('#meetMic');
  await page.check('#meetCamera');
  await page.click('#meetEnter');
  await page.waitForSelector('#meetLeave:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(3000);
  const status = (await page.textContent('#meetStatus')) || '';
  step(`meeting status: "${status.trim()}"`);
  await page.click('#meetLeave');
  await page.waitForTimeout(1000);
} catch (e) {
  problems.push(`check could not finish on ${where(page)}: ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nNo blocked resources, CSP violations or JavaScript errors.');
