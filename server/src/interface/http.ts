import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { RealFileStore, type FileStore } from '../substrate/files.js';
import type { Config } from '../substrate/config.js';
import type { Storage } from '../substrate/ports.js';
import {
  checkModel,
  ensureConnectorTable,
  listConnectors,
  modelStatus,
  platformStatus,
  setConnector,
  type ApiResponse,
} from './api.js';
import {
  BrowserState,
  actInSession,
  browserCatalogue,
  readPageForUser,
  resetSession,
  sessionState,
  startSession,
} from './browser-api.js';

/**
 * The local HTTP surface (§53).
 *
 * `node:http` directly, no framework, no build step, loopback by default.
 * The server does two things: serve the static Get Started UI, and answer
 * the small JSON API in `api.ts`. All the policy lives there; this file is
 * transport.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface HttpDeps {
  storage: Storage;
  config: Config;
  now: () => number;
  eventCount: () => number;
  /** Content digest, injected rather than imported: `interface/` has no crypto. */
  digest?: (input: string) => string;
  browser?: BrowserState;
  files?: FileStore;
  /** Root of the static UI. Defaults to `web/` beside the built output. */
  webRoot?: string;
}

function defaultWebRoot(): string {
  // dist/src/interface/http.js → ../../../web
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'web');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for('arish.invalid-json');
  }
}

const INVALID_JSON = Symbol.for('arish.invalid-json');

/** Exact-match routes, so dispatch is a lookup rather than a ladder. */
const ROUTES: Record<string, (body: unknown, deps: HttpDeps) => ApiResponse> = {
  'GET /api/status': (_b, d) => platformStatus(d.storage, d.config, d.eventCount()),
  'GET /api/connectors': (_b, d) => listConnectors(d.storage),
  'GET /api/model': (_b, d) => modelStatus(d.config),
  'POST /api/model/check': (body) => checkModel(body),
  'GET /api/browser/catalogue': () => browserCatalogue(),
  'GET /api/browser': (_b, d) => sessionState(browserOf(d)),
  'GET /api/browser/page': (_b, d) => readPageForUser(browserOf(d)),
  'POST /api/browser/plan': (body, d) => startSession(browserOf(d), body),
  'POST /api/browser/reset': (_b, d) => resetSession(browserOf(d)),
};

const ASYNC_ROUTES: Record<string, (body: unknown, deps: HttpDeps) => Promise<ApiResponse>> = {
  'POST /api/browser/act': (body, d) => actInSession(browserOf(d), body),
};

/**
 * One browser state per deps object, created on first use.
 *
 * Lazy because most requests never touch it, and attached to `deps` so a
 * test that builds its own deps gets its own browser and cannot be
 * polluted by another test's session.
 */
const BROWSERS = new WeakMap<HttpDeps, BrowserState>();

function browserOf(deps: HttpDeps): BrowserState {
  if (deps.browser !== undefined) return deps.browser;
  let state = BROWSERS.get(deps);
  if (state === undefined) {
    state = new BrowserState({ now: deps.now, digest: deps.digest ?? weakDigest });
    BROWSERS.set(deps, state);
  }
  return state;
}

/**
 * A fallback digest for sealing a plan when none was injected.
 *
 * Not a security primitive and not pretending to be: the seal detects
 * accidental mutation of a committed plan inside one process. A caller
 * that needs it to resist an adversary passes a real digest in `deps`.
 */
function weakDigest(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const CONNECTOR_TOGGLE = /^\/api\/connectors\/([a-z0-9-]+)$/;

/** Route one API request. Separated so a test can call it without a socket. */
export async function handleApi(
  method: string,
  path: string,
  body: unknown,
  deps: HttpDeps,
): Promise<ApiResponse> {
  if (body === INVALID_JSON) return { status: 400, body: { error: 'Request body was not valid JSON.' } };

  const exact = ROUTES[`${method} ${path}`];
  if (exact !== undefined) return Promise.resolve(exact(body, deps));

  const async_ = ASYNC_ROUTES[`${method} ${path}`];
  if (async_ !== undefined) return async_(body, deps);

  const id = method === 'POST' ? CONNECTOR_TOGGLE.exec(path)?.[1] : undefined;
  if (id !== undefined) return setConnector(deps.storage, id, body, deps.now());

  return { status: 404, body: { error: `No route for ${method} ${path}` } };
}

function sendJson(res: ServerResponse, { status, body }: ApiResponse): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The UI is same-origin and there is no reason for anything else to
    // reach a loopback agent API.
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, files: FileStore, root: string, urlPath: string): void {
  const relative = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath;
  const bytes = files.readWithin(root, relative);
  if (bytes === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(relative).toLowerCase()] ?? 'application/octet-stream',
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
  });
  res.end(Buffer.from(bytes));
}

export function createHttpServer(deps: HttpDeps): Server {
  ensureConnectorTable(deps.storage);
  const files = deps.files ?? new RealFileStore();
  const root = deps.webRoot ?? defaultWebRoot();

  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    void (async () => {
      try {
        if (path.startsWith('/api/')) {
          sendJson(res, await handleApi(method, path, await readBody(req), deps));
          return;
        }
        serveStatic(res, files, root, path);
      } catch (error) {
        // A thrown error is a bug, not a user mistake. Report the kind and
        // nothing else: the message may name internal paths.
        sendJson(res, {
          status: 500,
          body: { error: 'Internal error', kind: error instanceof Error ? error.name : 'unknown' },
        });
      }
    })();
  });
}

export function listen(server: Server, host: string, port: number): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? { host: address.address, port: address.port } : { host, port });
    });
  });
}
