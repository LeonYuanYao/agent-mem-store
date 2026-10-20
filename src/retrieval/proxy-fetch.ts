import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

/**
 * `fetch` for HTTPS requests that must leave through a specific HTTP proxy
 * (CONNECT tunnel), for example a model API that rejects the machine's region.
 * Node 22's global fetch ignores proxy settings, and a dependency for one call
 * site is not worth it. Supports what the Jev client uses: method, string body,
 * headers, `redirect: "error"` and an AbortSignal; the response body streams.
 *
 * The TLS handshake through a proxy costs most of a request, so connections
 * are kept alive between requests and new ones resume the previous TLS session.
 */

const agents = new Map<string, Agent>();

class TunnelAgent extends Agent {
  readonly #proxy: URL;
  readonly #sessions = new Map<string, Buffer>();

  public constructor(proxy: URL) {
    super({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, maxFreeSockets: 2, timeout: 60_000 });
    this.#proxy = proxy;
  }

  public override createConnection(options: ConnectionOptions, callback?: (error: Error | null, socket: Duplex) => void): Duplex {
    const host = options.servername ?? options.host ?? "";
    const authority = `${host}:${String(options.port ?? 443)}`;
    const connect = httpRequest({
      host: this.#proxy.hostname, port: Number(this.#proxy.port || "80"), method: "CONNECT", path: authority, headers: { host: authority }
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback?.(new TypeError(`Proxy refused the tunnel (HTTP ${String(response.statusCode)}).`), socket);
        return;
      }
      const session = this.#sessions.get(host);
      const secure = tlsConnect({ socket, servername: host, ...(session === undefined ? {} : { session }) });
      secure.on("session", (next: Buffer) => { this.#sessions.set(host, next); });
      secure.once("secureConnect", () => { callback?.(null, secure); });
      secure.once("error", (error: Error) => {
        this.#sessions.delete(host);
        callback?.(error, secure);
      });
    });
    connect.once("error", (error) => { callback?.(error, connect.socket ?? (undefined as unknown as Duplex)); });
    connect.end();
    // The connection is handed over asynchronously through the callback.
    return undefined as unknown as Duplex;
  }
}

export function proxiedFetch(proxyUrl: string): typeof fetch {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") throw new TypeError("Only http:// proxies are supported.");
  let agent = agents.get(proxy.href);
  if (agent === undefined) {
    agent = new TunnelAgent(proxy);
    agents.set(proxy.href, agent);
  }
  const tunnelAgent = agent;
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== "https:") throw new TypeError("proxiedFetch only fetches https:// URLs.");
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") throw new TypeError("proxiedFetch only sends string bodies.");
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest({
        host: target.hostname, servername: target.hostname, port: Number(target.port || "443"),
        path: `${target.pathname}${target.search}`, method: init?.method ?? "GET",
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          ...(typeof body === "string" ? { "content-length": String(Buffer.byteLength(body)) } : {})
        },
        agent: tunnelAgent,
        ...(signal === undefined ? {} : { signal })
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (init?.redirect === "error" && status >= 300 && status < 400) {
          response.destroy();
          reject(new TypeError("Redirect refused."));
          return;
        }
        resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
          status, statusText: response.statusMessage ?? "", headers: responseHeaders(response.headers)
        }));
      });
      request.once("error", reject);
      request.end(body ?? undefined);
    });
  };
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  }
  return result;
}
