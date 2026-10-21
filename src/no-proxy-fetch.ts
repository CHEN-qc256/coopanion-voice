/**
 * `fetch` for a service on this machine: no proxy, ever.
 *
 * On a machine behind a system proxy (Clash, a corporate MITM, `HTTP_PROXY`), a plain `fetch` to
 * `127.0.0.1` can end up at the proxy and fail with 502. `undici` does not read `HTTP_PROXY` by
 * default, but tools that install a global dispatcher (or `NODE_OPTIONS=--use-env-proxy`) do, and the
 * symptom — "the model is running but the pet says it cannot synthesize" — is hard to trace.
 * Talking to the loopback address over `node:http` sidesteps all of it.
 *
 * The signature follows `fetch(url, init)` for the part a TTS call uses: method, headers, body, signal.
 */

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}) => Promise<Response>;

/** A `fetch` that opens the TCP connection itself, so no proxy or global dispatcher is involved. */
export const localFetch: FetchLike = async (url, init = {}) => {
  const { request } = await import('node:http');
  const { request: secure } = await import('node:https');
  const target = new URL(url);
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : Buffer.from(init.body);
  const send = target.protocol === 'https:' ? secure : request;
  return new Promise<Response>((resolve, reject) => {
    const req = send({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers: {
        ...(init.headers ?? {}),
        ...(body ? { 'content-length': String(body.length) } : {}),
      },
      timeout: 180_000,
      signal: init.signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) headers.append(key, v);
          else if (value !== undefined) headers.set(key, value);
        }
        resolve(new Response(bytes, { status: res.statusCode ?? 0, headers }));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
};
