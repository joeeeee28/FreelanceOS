import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real local HTTP server for crawler tests.
 *
 * The crawl path involves sockets, redirects, status codes and robots.txt, and
 * a hand-written fake fetcher would quietly diverge from how `fetch` actually
 * behaves. This serves fixed content over real HTTP on a loopback port, so the
 * fetcher is exercised end to end without ever touching the public internet.
 */

export interface FixtureRoute {
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Artificial delay, for timeout tests. */
  delayMs?: number;
}

/**
 * A route that computes its response per request.
 *
 * Needed for behaviour that depends on call order — an endpoint that fails
 * twice and then recovers, for instance — which a static fixture cannot
 * express.
 */
export type DynamicRoute = () => FixtureRoute | Promise<FixtureRoute>;

export interface FixtureServer {
  url: string;
  /** Number of requests received per path, to assert on politeness. */
  hits: Map<string, number>;
  close(): Promise<void>;
}

export async function startFixtureServer(
  routes: Record<string, FixtureRoute | DynamicRoute>,
): Promise<FixtureServer> {
  const hits = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    // Query strings must not split the hit count for one path, but they also
    // must not be matched against literally.
    const path = (req.url ?? "/").split("#")[0].split("?")[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);

    const defined = routes[path];

    if (defined === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    void (async () => {
      let route: FixtureRoute;
      try {
        route = typeof defined === "function" ? await defined() : defined;
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Fixture route threw");
        return;
      }

      const send = () => {
        res.writeHead(route.status ?? 200, {
          "content-type": route.contentType ?? "text/html; charset=utf-8",
          ...route.headers,
        });
        res.end(route.body ?? "");
      };

      if (route.delayMs !== undefined && route.delayMs > 0) {
        setTimeout(send, route.delayMs);
      } else {
        send();
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
