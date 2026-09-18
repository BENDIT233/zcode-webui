// Repro/check for the "完全访问 (Full access) 选了不管用" report — verified
// findings (2026-09-18, renderer 3.12.3), all through the real webui:
//
//   1. The mode switch itself WORKS over this shim: switching while idle (arm1)
//      or while a turn is streaming (arm2) persists mode=yolo to localStorage
//      (zcode-v4-composer-drafts + zcode-model-selection-recent-v1), the next
//      write command runs WITHOUT a permission dialog, and it survives reload.
//   2. The traps that make it FEEL broken (official semantics, not shim bugs):
//      a. mode is per-CONVERSATION and stored in the BROWSER's localStorage —
//         other conversations, other devices, other browsers keep asking;
//      b. while a permission card is pending it REPLACES the composer, so the
//         mode picker is not even visible at the moment the user is annoyed;
//         a switch racing a pending permission request gets REVERTED;
//      c. "始终允许本项目" only allowlists the IDENTICAL command.
//   3. Practical recipe: switch the composer dropdown to 完全访问 while the
//      conversation is IDLE — that conversation stops asking, and NEW
//      conversations in the same workspace inherit yolo on that device.
//
// Runs two arms (idle-switch / running-switch) with storage dumps and reload
// checks. Costs a couple of tiny agent turns against the real account.
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;
const MODE_LABELS = ['完全访问', '变更前确认', '自动编辑', '计划模式', '默认模式'];
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error] ' + m.text().slice(0, 160)); });
const shot = (n) => page.screenshot({ path: OUT + 'mode-repro4-' + n + '.png' }).catch(() => {});

const pickerLabel = () => page.evaluate((labels) => {
  for (const b of document.querySelectorAll('button, [role="button"]')) {
    const t = (b.innerText || '').trim();
    if (t && labels.includes(t) && t.length < 12) return t;
  }
  return null;
}, MODE_LABELS);
const bodyText = () => page.evaluate(() => (document.body.innerText) || '');
const storageModes = () => page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('zcode-model-selection-recent-v1') || k.startsWith('zcode-v4-composer-drafts')) {
      out[k.replace(/^zcode-[a-z0-9-]+:v1:?/, '')] = [...(localStorage.getItem(k).matchAll(/"mode":"([a-z]+)"/g))].map((m) => m[1]);
    }
  }
  return out;
});

async function openAppAndNewConversation() {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  for (let i = 0; i < 45; i++) { if ((await bodyText()).length > 500) break; await page.waitForTimeout(2000); }
  await page.waitForTimeout(2500);
  const newBtn = page.locator('[data-testid="task-new-button"]').first();
  if (await newBtn.count()) { await newBtn.click(); await page.waitForTimeout(4000); }
}

async function switchToFullAccess() {
  const btn = page.locator('button[aria-label="切换模式"]').first();
  if ((await btn.count()) === 0) return 'no-button';
  await btn.click();
  await page.waitForTimeout(1000);
  const clicked = await page.evaluate(() => {
    for (const e of document.querySelectorAll('[role="option"], [role="menuitem"], [data-radix-collection-item], div, span')) {
      if ((e.innerText || '').trim() === '完全访问') { e.click(); return true; }
    }
    return false;
  });
  await page.waitForTimeout(800);
  return 'clicked=' + clicked + ' label=' + await pickerLabel();
}

async function sendPrompt(text) {
  const composer = page.locator('[data-testid="v4-composer-input"]').first();
  for (let i = 0; i < 15 && (await composer.isVisible()) === false; i++) await page.waitForTimeout(1500);
  await composer.click();
  await composer.fill(text);
  await page.keyboard.press('Enter');
}

// ---------------- arm 1: switch while IDLE ----------------
console.log('========== ARM1: switch while idle');
await openAppAndNewConversation();
console.log('initial picker: ' + await pickerLabel() + '  storage: ' + JSON.stringify(await storageModes()));
console.log('switch → ' + await switchToFullAccess());
console.log('storage right after switch: ' + JSON.stringify(await storageModes()));
await page.waitForTimeout(5000);
console.log('picker +5s: ' + await pickerLabel() + '  storage: ' + JSON.stringify(await storageModes()));

await sendPrompt('请用 Bash 执行 `echo arm1 > /tmp/zcode-mode-arm1.txt`，成功后单独回复一行：ARM1-FINISHED');
let asked = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2000);
  const t = await bodyText();
  if (/需要权限|仅允许这一次|始终允许本项目/.test(t)) { asked = true; await shot('arm1-ask'); break; }
  if ((t.match(/ARM1-FINISHED/g) || []).length >= 2) break;
}
console.log('ARM1 write command → asked=' + asked);
await shot('arm1-end');

// reload: does yolo survive for THIS conversation?
await page.reload({ waitUntil: 'domcontentloaded' });
for (let i = 0; i < 45; i++) { if ((await bodyText()).length > 500) break; await page.waitForTimeout(2000); }
await page.waitForTimeout(3500);
console.log('ARM1 after reload picker: ' + await pickerLabel() + '  storage: ' + JSON.stringify(await storageModes()));

// ---------------- arm 2: switch DURING a running turn ----------------
console.log('========== ARM2: switch while a turn is running');
await openAppAndNewConversation();
await sendPrompt('请连续运行三条 Bash 命令：`sleep 5`、`sleep 5`、`sleep 5`，全部结束后单独回复一行：ARM2-FINISHED');
await page.waitForTimeout(4000);   // turn now running
console.log('during turn, switch → ' + await switchToFullAccess());
await page.waitForTimeout(5000);
console.log('picker +5s during turn: ' + await pickerLabel() + '  storage: ' + JSON.stringify(await storageModes()));
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2000);
  const t = await bodyText();
  if ((t.match(/ARM2-FINISHED/g) || []).length >= 2) break;
}
console.log('ARM2 turn done; picker now: ' + await pickerLabel() + '  storage: ' + JSON.stringify(await storageModes()));
await shot('arm2-end');

await browser.close();
console.log('REPRO4 DONE');
