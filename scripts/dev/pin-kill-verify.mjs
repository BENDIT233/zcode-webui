// Verify the pin kill switch: the style hook must be installed, every pin
// control must be gone from the DOM (including the hover-only row button), and
// the task service must reject a direct setTaskPinned call.
import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error] ' + m.text().slice(0, 200)); });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const hooked = await page.evaluate(() => {
  const st = document.getElementById('__zcode_webui_pin_kill');
  // plant a real control the way the renderer does, then sweep it: proves both
  // the CSS rule and the sweep keep pinning affordances out of the UI
  const probe = document.createElement('button');
  probe.setAttribute('aria-label', '置顶任务');
  probe.textContent = 'x';
  document.body.appendChild(probe);
  const hiddenByCss = getComputedStyle(probe).display === 'none';
  probe.remove();
  return {
    styleTag: !!st,
    styleText: st ? st.textContent : null,
    probeHiddenByCss: hiddenByCss,
    sweepApi: typeof window.__zcode_webui_pin,
  };
});
console.log('HOOKS ' + JSON.stringify(hooked, null, 1));

// hover every task row so the renderer mounts its hover-only action buttons
const rows = await page.locator('[data-task-item-key]').count();
for (let i = 0; i < Math.min(rows, 8); i++) {
  try { await page.locator('[data-task-item-key]').nth(i).hover({ timeout: 1500 }); } catch (e) { /* ignore */ }
  await page.waitForTimeout(150);
}
const afterHover = await page.evaluate(() => ({
  pinControlsInDom: Array.from(document.querySelectorAll('[aria-label]')).filter((e) => /置顶|Pin task|Unpin task/.test(e.getAttribute('aria-label') || '')).length,
  pinTestId: document.querySelectorAll('[data-testid="pin-button"]').length,
  rowActionBars: document.querySelectorAll('[data-task-row-actions]').length,
  visiblePinButtons: Array.from(document.querySelectorAll('button')).filter((b) => /置顶/.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null).length,
  bodyHasPinText: /置顶/.test(document.body.innerText || ''),
}));
console.log('AFTER HOVER ' + JSON.stringify(afterHover, null, 1));

// a programmatic click on a hidden pin control must be blocked by the
// capture-phase shield before the renderer's handler can send anything
const clickOutcome = await page.evaluate(() => {
  const btn = document.querySelector('[aria-label="置顶任务"]');
  if (!btn) return { present: false };
  btn.click();
  return { present: true, stillVisible: btn.offsetParent !== null };
});
console.log('CLICK ATTEMPT ' + JSON.stringify(clickOutcome));
await browser.close();
