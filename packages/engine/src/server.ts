import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { FILM_PARAMS_RUNTIME_SOURCE, MOTION_PRIMITIVES_SOURCE } from '@open-director/protocol';
import { buildFilmClockPrelude, type ClockPreludeConfig } from './clock-prelude.js';
import { synthesizeBuiltinSfxWav } from './sfx-library.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export interface ProjectServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

export interface ProjectServerOptions {
  port?: number;
  clockConfig?: ClockPreludeConfig;
  stageHtmlProvider?: () => Promise<string>;
}

function injectPreludeIntoHtml(html: string, preludeScript: string): string {
  const tag = `<script data-open-director-host="1">\n${preludeScript}\n</script>`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}\n${tag}\n${html.slice(insertAt)}`;
  }
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}\n<head>${tag}</head>\n${html.slice(insertAt)}`;
  }
  return `${tag}\n${html}`;
}

function safeResolve(projectDir: string, urlPath: string): string | null {
  const root = resolve(projectDir);
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = resolve(root, rel);
  const diff = relative(root, full);
  if (diff.startsWith('..') || diff.includes(`..${sep}`) || full === root) {
    return null;
  }
  return full;
}

function sendFileWithRange(req: IncomingMessage, res: ServerResponse, fullPath: string, mime: string): void {
  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start <= end && start < total) {
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        createReadStream(fullPath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(fullPath).pipe(res);
}

/**
 * Start a local HTTP server for a `.motion` project directory, serving assets
 * with range support, `/__film/film-params.mjs`, and deterministic host clock injection.
 */
export async function startProjectServer(
  projectDir: string,
  options: ProjectServerOptions = {},
): Promise<ProjectServer> {
  const root = resolve(projectDir);
  const prelude = buildFilmClockPrelude(options.clockConfig);

  const server: Server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      // Serve __film/film-params.mjs at root or any subfolder depth
      if (pathname === '/__film/film-params.mjs' || pathname.endsWith('/__film/film-params.mjs')) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(FILM_PARAMS_RUNTIME_SOURCE);
        return;
      }

      if (pathname === '/__film/motion-primitives.mjs' || pathname.endsWith('/__film/motion-primitives.mjs')) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(MOTION_PRIMITIVES_SOURCE);
        return;
      }

      const sfxMatch = pathname.match(/\/__film\/sfx\/([^/]+?)(?:\.wav)?$/);
      if (sfxMatch) {
        const wav = synthesizeBuiltinSfxWav(decodeURIComponent(sfxMatch[1]));
        if (wav) {
          res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': String(wav.byteLength),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(wav);
          return;
        }
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if ((pathname === '/' || pathname === '/__film/stage.html') && options.stageHtmlProvider) {
        const html = await options.stageHtmlProvider();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(html);
        return;
      }

      const targetPath = pathname === '/' ? join(root, 'composition.html') : safeResolve(root, pathname);
      if (!targetPath || !existsSync(targetPath) || statSync(targetPath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const ext = extname(targetPath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';

      if ((ext === '.html' || ext === '.htm') && reqUrl.searchParams.get('__film_host') === '1') {
        const rawHtml = readFileSync(targetPath, 'utf8');
        const injected = injectPreludeIntoHtml(rawHtml, prelude);
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(injected);
        return;
      }

      sendFileWithRange(req, res, targetPath, mime);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((err as Error).message);
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, '127.0.0.1', () => ok());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind project server');
  }

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((ok, fail) => {
        server.close((err) => (err ? fail(err) : ok()));
      }),
  };
}
