// Local stand-in for the deployed bridge: runs the real bridge/Code.gs over HTTP with an in-memory sheet.
//   node smoke/fake-bridge.js [port]   GET /_sheet dumps all tabs, POST /_fail {"on":true} makes every call 500.
const http = require('node:http');
const { load } = require('../test/fake-apps-script');

const b = load({ props: { TOKEN: 'smoke-token' } });
let failing = false;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/_sheet') return res.end(JSON.stringify(Object.fromEntries(b.spreadsheet.sheets.map((s) => [s.name, s.rows]))));
    if (url.pathname === '/_fail') { failing = JSON.parse(body).on; return res.end('ok'); }
    if (failing) { res.statusCode = 500; return res.end('down'); }
    const out = req.method === 'POST'
      ? b.context.doPost({ postData: { contents: body } })
      : b.context.doGet({ parameter: Object.fromEntries(url.searchParams) });
    res.end(out.text);
  });
}).listen(Number(process.argv[2]) || 8787, '127.0.0.1');
