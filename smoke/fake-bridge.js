// Local stand-in for the deployed bridge: runs the real bridge/Code.gs over HTTP with an in-memory sheet.
//   node smoke/fake-bridge.js [port]   GET /_sheet dumps all tabs, POST /_fail {"on":true} makes every call 500.
const http = require('node:http');
const fs = require('node:fs');
const { load } = require('../test/fake-apps-script');

const b = load({ props: { TOKEN: 'smoke-token' } });

// Capture-engine test pages (smoke/run.mjs). SMOKE_VIDEO is a tiny webm made by the runner.
const strips = '<div style="background:#d33;color:#fff;padding:30px">Header strip</div>';
const long = (n) => '<p>' + 'Meaningful article text that a reader should see. '.repeat(n) + '</p>';
const PAGES = {
  // Main text hidden by an opacity animation that never finishes.
  '/_hidden-stuck': '<!doctype html><title>Stuck reveal</title><style>body{margin:0}@keyframes r{from{opacity:0}to{opacity:1}}main{padding:30px;background:#246;color:#fff;opacity:0;animation:r 1000000s linear}</style>' + strips + '<main>' + long(20) + '</main>' + strips,
  // Hidden until a script reveals it after a short delay.
  '/_hidden-reveal': '<!doctype html><title>Late reveal</title><style>body{margin:0}main{padding:30px;background:#246;color:#fff;opacity:0}main.on{opacity:1}</style>' + strips + '<main>' + long(20) + '</main>' + strips + '<script>setTimeout(()=>document.querySelector("main").classList.add("on"),1500)</script>',
  // One-screen document whose main panel scrolls inside it.
  '/_appshell': '<!doctype html><title>App shell</title><style>html,body{margin:0;height:100%;overflow:hidden}.shell{display:flex;height:100vh}.side{width:200px;background:#ccd}.main{flex:1;overflow-y:auto}</style><div class="shell"><div class="side">Mail</div><div class="main">' + Array.from({ length: 60 }, (_, i) => `<p style="height:50px;margin:0;border-bottom:1px solid #ccc">Message ${i + 1} in the long inner panel</p>`).join('') + '</div></div>',
  '/_video': '<!doctype html><title>Video page</title><main><h1>Video page</h1>' + long(8) + '<img src="/_img.png" width="400" height="300"><video src="/_video.webm" controls preload="auto" width="320" height="240"><track kind="captions" src="/_cap.vtt" srclang="en"></video></main>',
};
let failing = false;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/_sheet') return res.end(JSON.stringify(Object.fromEntries(b.spreadsheet.sheets.map((s) => [s.name, s.rows]))));
    if (url.pathname === '/_article') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Smoke article</title><meta property="article:published_time" content="2026-03-04T10:00:00Z"><main><h1>Smoke article</h1><p>' + 'Deportation flights resumed on Tuesday, officials said. '.repeat(40) + '</p></main>'); }
    if (PAGES[url.pathname]) { res.setHeader('Content-Type', 'text/html'); return res.end(PAGES[url.pathname]); }
    if (url.pathname === '/_video.webm' && process.env.SMOKE_VIDEO) { const file = fs.readFileSync(process.env.SMOKE_VIDEO); res.setHeader('Content-Type', 'video/webm'); res.setHeader('Accept-Ranges', 'bytes'); return res.end(file); }
    if (url.pathname === '/_img.png' && process.env.SMOKE_IMAGE) { res.setHeader('Content-Type', 'image/png'); return res.end(fs.readFileSync(process.env.SMOKE_IMAGE)); }
    if (url.pathname === '/_cap.vtt') { res.setHeader('Content-Type', 'text/vtt'); return res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'); }
    // A bot wall until the cookie is set (the runner sets it, as a person solving the check would).
    if (url.pathname === '/_walled') { res.setHeader('Content-Type', 'text/html'); return res.end(/ok=1/.test(req.headers.cookie || '') ? '<!doctype html><title>Walled article</title><main><h1>Walled article</h1>' + long(10) + '</main>' : '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>'); }
    if (url.pathname === '/_fail') { failing = JSON.parse(body).on; return res.end('ok'); }
    if (failing) { res.statusCode = 500; return res.end('down'); }
    const out = req.method === 'POST'
      ? b.context.doPost({ postData: { contents: body } })
      : b.context.doGet({ parameter: Object.fromEntries(url.searchParams) });
    res.end(out.text);
  });
}).listen(Number(process.argv[2]) || 8787, '127.0.0.1');
