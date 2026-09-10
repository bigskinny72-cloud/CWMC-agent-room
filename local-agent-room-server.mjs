import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, 'apps', 'web', 'dist');
const INDEX = path.join(WEB_ROOT, 'index.html');
const PORT = Number(process.env.PORT || 3000);

if (!process.env.AGENT_ROOM_SQLITE_PATH) {
  console.error('FATAL: Missing AGENT_ROOM_SQLITE_PATH');
  process.exit(1);
}

const { default: roomHandler } = await import('./api/room.ts');
const { default: reportPageHandler } = await import('./api/report-page.ts');
const { default: reportOgHandler } = await import('./api/report-og.ts');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendFile(res, filename) {
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    return false;
  }

  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    contentTypes[path.extname(filename).toLowerCase()] ||
      'application/octet-stream'
  );
  fs.createReadStream(filename).pipe(res);
  return true;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  if (chunks.length === 0) return {};

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeVercelResponse(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };

  res.json = function (value) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(value));
    return res;
  };

  res.send = function (value) { res.end(value); return res; };

  return res;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/report-page' || url.pathname === '/api/report-og') {
      req.query = Object.fromEntries(url.searchParams);
      const handler = url.pathname === '/api/report-page' ? reportPageHandler : reportOgHandler;
      await handler(req, makeVercelResponse(res));
      return;
    }

    if (url.pathname === '/api/room') {
      let body = {};

      if (req.method === 'POST') {
        try {
          body = await readJson(req);
        } catch {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            error: 'InvalidJSON',
            message: 'Request body is not valid JSON'
          }));
          return;
        }
      }

      req.body = body;
      await roomHandler(req, makeVercelResponse(res));
      return;
    }

    const requested = decodeURIComponent(url.pathname);
    const relative = requested.replace(/^\/+/, '');
    const candidate = path.resolve(WEB_ROOT, relative);
    const webRootResolved = path.resolve(WEB_ROOT);

    if (
      candidate.startsWith(webRootResolved + path.sep) &&
      sendFile(res, candidate)
    ) {
      return;
    }

    if (sendFile(res, INDEX)) {
      return;
    }

    res.statusCode = 404;
    res.end('Agent Room web build not found.');
  } catch (error) {
    console.error('REQUEST ERROR:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: 'InternalServerError',
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('==============================================');
  console.log(' Agent Room persistent local server READY');
  console.log(` http://localhost:${PORT}`);
  console.log(` SQLite: ${process.env.AGENT_ROOM_SQLITE_PATH}`);
  console.log('==============================================');
  console.log('');
});
