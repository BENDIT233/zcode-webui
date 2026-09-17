#!/usr/bin/env node
// Remote interactive browser for this box, served on a local port so it can be opened
// through code-server's reverse proxy at /proxy/<port>/ .
//
// Why: some flows (e.g. an OAuth login with a slider captcha + SMS code) must be driven
// by a human, but the CLI's OAuth callback only answers on THIS machine's localhost.
// Running the browser here and streaming its picture out keeps the callback local while
// the human operates it from anywhere.
//
// How: Chromium runs headless here; CDP screencast frames are pushed to the page over a
// WebSocket, and mouse/keyboard events from the page are dispatched back through CDP.
//
// Usage: node scripts/dev/remote-browser.mjs [startUrl]
// Env:   REMOTE_BROWSER_PORT (4000), REMOTE_BROWSER_PROXY (default http://glash:7890,
//        needed because headless Chromium ignores the shell's HTTPS_PROXY),
//        REMOTE_BROWSER_VIEW (1280x800), REMOTE_BROWSER_QUALITY (70)
import http from 'node:http';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.REMOTE_BROWSER_PORT || 4000);
const PROXY = process.env.REMOTE_BROWSER_PROXY === '' ? null : (process.env.REMOTE_BROWSER_PROXY || 'http://glash:7890');
const QUALITY = Number(process.env.REMOTE_BROWSER_QUALITY || 70);
const [vw, vh] = String(process.env.REMOTE_BROWSER_VIEW || '1280x800').split('x').map(Number);
const START_URL = process.argv[2] || 'http://127.0.0.1:3102/login';

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', `--window-size=${vw},${vh}`],
});
const ctx = await browser.newContext({
  viewport: { width: vw, height: vh },
  locale: 'zh-CN',
  ...(PROXY ? { proxy: { server: PROXY, bypass: 'localhost,127.0.0.1,::1' } } : {}),
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

// ---- client page -----------------------------------------------------------
const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>远程浏览器</title>
<style>
  html,body{margin:0;background:#0d1117;color:#c9d1d9;font:13px system-ui,sans-serif;height:100%;overflow:hidden}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  img{max-width:100vw;max-height:100vh;cursor:crosshair;image-rendering:auto}
  #bar{position:fixed;left:0;right:0;top:0;padding:4px 8px;background:#161b22cc;font-size:12px;display:flex;gap:10px;align-items:center}
  #bar input{flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 6px}
  #bar button{background:#238636;color:#fff;border:0;border-radius:4px;padding:4px 10px}
  #st{color:#8b949e}
</style></head>
<body>
<div id="bar"><span>远程浏览器</span><input id="u" placeholder="地址，回车打开"><button id="go">打开</button><span id="st">连接中…</span></div>
<div id="wrap"><img id="v" alt=""></div>
<script>
(function(){
  var VW=${vw}, VH=${vh};
  var v=document.getElementById('v'), st=document.getElementById('st'), u=document.getElementById('u');
  var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+location.pathname.replace(/\\/$/,'')+'/ws');
  var ready=false;
  ws.onopen=function(){ st.textContent='已连接'; };
  ws.onclose=function(){ st.textContent='连接断开，刷新重试'; };
  ws.onmessage=function(ev){
    var m=JSON.parse(ev.data);
    if(m.t==='f'){ v.src='data:image/jpeg;base64,'+m.d; ready=true; }
    else if(m.t==='meta'){ if(m.url){ u.value=m.url; st.textContent=m.title||m.url; } }
    else if(m.t==='view'){ VW=m.w; VH=m.h; }
  };
  function send(o){ if(ws.readyState===1) ws.send(JSON.stringify(o)); }
  function pos(e){ var r=v.getBoundingClientRect(); return { x:Math.round((e.clientX-r.left)*VW/r.width), y:Math.round((e.clientY-r.top)*VH/r.height) }; }
  var down=false;
  v.addEventListener('mousedown', function(e){ down=true; var p=pos(e); send({t:'m',a:'down',x:p.x,y:p.y,button:e.button}); e.preventDefault(); });
  v.addEventListener('mousemove', function(e){ var p=pos(e); send({t:'m',a:down?'drag':'move',x:p.x,y:p.y,button:down?0:-1}); });
  window.addEventListener('mouseup', function(e){ if(!down) return; down=false; var p=pos(e); send({t:'m',a:'up',x:p.x,y:p.y,button:e.button}); });
  v.addEventListener('wheel', function(e){ var p=pos(e); send({t:'w',x:p.x,y:p.y,dy:e.deltaY}); e.preventDefault(); }, {passive:false});
  v.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  window.addEventListener('keydown', function(e){
    if(e.target===u){ if(e.key==='Enter'){ send({t:'n',url:u.value}); u.blur(); } return; }
    var mods=(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
    send({t:'k',a:'down',key:e.key,code:e.code,text:e.key.length===1?e.key:'',mods:mods,windowsVirtualKeyCode:e.keyCode});
    if(e.key==='Tab'||e.key==='Enter'||e.key===' ') e.preventDefault();
  });
  window.addEventListener('keyup', function(e){
    if(e.target===u) return;
    send({t:'k',a:'up',key:e.key,code:e.code,mods:0,windowsVirtualKeyCode:e.keyCode});
  });
  document.getElementById('go').addEventListener('click', function(){ send({t:'n',url:u.value}); });
})();
</script></body></html>`;

// ---- frame fan-out ---------------------------------------------------------
const clients = new Set();
let lastFrameAt = 0;
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) { if (c.readyState === 1) { try { c.send(s); } catch (_e) { /* ignore */ } } }
}
let lastMeta = { url: '', title: '' };
async function pushMeta() {
  try {
    lastMeta = { url: page.url(), title: await page.title() };
    broadcast({ t: 'meta', ...lastMeta });
  } catch (_e) { /* ignore */ }
}

cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  lastFrameAt = Date.now();
  broadcast({ t: 'f', d: data });
  try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch (_e) { /* ignore */ }
});

// CDP only pushes frames when the page CHANGES, so a freshly connected viewer would
// stare at an empty <img> on a static page. Send a still right away, and keep one
// coming while the page is idle.
async function sendStill() {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
    lastFrameAt = Date.now();
    broadcast({ t: 'f', d: data });
    return true;
  } catch (_e) { return false; }
}

// ---- http + ws -------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, url: page.url(), clients: clients.size, viewport: [vw, vh] }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(HTML);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  log('client connected (' + clients.size + ' watching)');
  ws.send(JSON.stringify({ t: 'view', w: vw, h: vh }));
  ws.send(JSON.stringify({ t: 'meta', ...lastMeta }));
  sendStill(); // don't make a new viewer wait for the page to change
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch (_e) { return; }
    try {
      if (m.t === 'm') {
        const type = m.a === 'down' ? 'mousePressed' : m.a === 'up' ? 'mouseReleased' : m.a === 'drag' ? 'mouseMoved' : 'mouseMoved';
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: m.x, y: m.y, button: m.button === 2 ? 'right' : m.button === 1 ? 'middle' : 'left',
          buttons: m.a === 'drag' ? 1 : m.a === 'down' || m.a === 'up' ? 1 : 0,
          clickCount: m.a === 'down' || m.a === 'up' ? 1 : 0,
        });
        if (m.a === 'up') pushMeta();
      } else if (m.t === 'w') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: m.dy });
      } else if (m.t === 'k') {
        await cdp.send('Input.dispatchKeyEvent', {
          type: m.a === 'up' ? 'keyUp' : (m.text ? 'keyDown' : 'rawKeyDown'),
          key: m.key, code: m.code, text: m.text || undefined,
          windowsVirtualKeyCode: m.windowsVirtualKeyCode, nativeVirtualKeyCode: m.windowsVirtualKeyCode,
          modifiers: m.mods || 0,
        });
        if (m.a === 'down' && (m.key === 'Enter' || m.key === 'Tab')) setTimeout(pushMeta, 1500);
      } else if (m.t === 'n') {
        log('navigate -> ' + m.url);
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto failed: ' + e.message.slice(0, 80)));
        pushMeta();
      }
    } catch (e) {
      log('input error: ' + String(e.message || e).slice(0, 100));
    }
  });
  ws.on('close', () => { clients.delete(ws); log('client gone (' + clients.size + ' watching)'); });
});

server.listen(PORT, '0.0.0.0', async () => {
  log('remote browser on http://127.0.0.1:' + PORT + '/  (proxy path: /proxy/' + PORT + '/)');
  if (START_URL && START_URL !== 'about:blank') {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('initial goto failed: ' + e.message.slice(0, 100)));
  }
  await pushMeta();
  log('page: ' + page.url());
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: vw, maxHeight: vh, everyNthFrame: 1 });
  await sendStill();
  setInterval(pushMeta, 5000).unref();
  setInterval(() => { if (clients.size > 0 && Date.now() - lastFrameAt > 2500) sendStill(); }, 2500).unref();
});

process.on('SIGTERM', async () => { try { await browser.close(); } catch (_e) { /* ignore */ } process.exit(0); });
process.on('SIGINT', async () => { try { await browser.close(); } catch (_e) { /* ignore */ } process.exit(0); });
