import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import type { Config } from '../../../types/reely';
import { logger } from './logger';
import { createWsUpgradeHandler } from './handlers/api';
import { handler as basicAuthHandler } from './handlers/basic_auth';
import { handler as healthHandler } from './handlers/health';
import { handler as posterHandler } from './handlers/poster';
import { handler as serveStaticHandler } from './handlers/serve_static';
import { handler as templateHandler } from './handlers/template';
import { rateLimit } from './middleware/rateLimit';
import { createProvider as createAnimeProvider } from './providers/anime';
import type { ReelyProvider } from './providers/types';
import { openDb } from '../cour/db';
import { createCourStore } from '../cour/store';
import { getAllRooms } from './room';
import { reconcileRoomSeasons } from './roomStore';
import { Client } from './client';

export class ProviderUnavailableError extends Error {}

export interface ApplicationInstance {
  statusCode: Promise<number | undefined>;
}

export const Application = (config: Config, signal?: AbortSignal): ApplicationInstance => {
  // statusCode resolves to:
  //   - undefined: clean shutdown via the abort signal (main.ts exits 0)
  //   - number:    process should exit with that code (catch-all errors -> 1)
  // statusCode rejects with ProviderUnavailableError so main.ts can log that
  // case specifically.
  const statusCode = new Promise<number | undefined>((resolveStatus, rejectStatus) => {
    (async () => {
      // Read TLS cert + key FIRST when TLS is configured (audit 13 #293).
      // The prior ordering read these only when constructing the https
      // server, way past express setup + middleware mount + provider
      // probes -- so a bad certFile / keyFile path burned every startup
      // side effect (provider isAvailable check + middleware allocation)
      // before surfacing the
      // ENOENT. Reading early surfaces the path error immediately and
      // leaves no dangling state to clean up. The buffers are held in
      // closure scope and re-used when createHttpsServer runs below.
      let tlsBundle: { cert: Buffer; key: Buffer } | undefined;
      if (config.tlsConfig) {
        const [cert, key] = await Promise.all([
          readFile(config.tlsConfig.certFile),
          readFile(config.tlsConfig.keyFile),
        ]);
        tlsBundle = { cert, key };
      }

      const providers: ReelyProvider[] = [];

      // The cour database (0.5.0): users, rooms, verdicts, results. One
      // handle per process; node:sqlite is synchronous, so no pool.
      const cour = createCourStore(openDb());

      // Re-fetch each open in-memory room's deck and push it to connected
      // clients. Shared by stills enrichment and season rotation -- both
      // swap the provider snapshot under rooms that are already open.
      const pushMediaToOpenRooms = () => {
        for (const room of getAllRooms()) {
          void room
            .applyFilters(room.filters ?? [])
            .then((media) => {
              if (media) {
                // Empty appliedBy: media update without the
                // "<user> applied filters" toast client-side.
                room.notifyFilterApplied('', media, room.filters ?? []);
              }
            })
            .catch((err) => {
              logger.warn(`media push to "${room.roomName}" failed: ${String(err)}`);
            });
        }
      };

      // cour is single-server by design; the `servers` Config field stays
      // an array as a config-shape extension point (audit 12 #233 / #239 /
      // #273 rationale carried from reely). anilist is the only provider
      // since the 0.4.0 plex teardown. The warn below catches an operator
      // who accidentally pasted two server blocks.
      if (config.servers.length > 0) {
        if (config.servers.length > 1) {
          logger.warn(
            `${config.servers.length} servers configured; cour supports one server. Only the first will be used.`,
          );
        }
        const serverConfig = config.servers[0];
        if (serverConfig.type === 'anilist' || serverConfig.type === undefined) {
          providers.push(createAnimeProvider('0', {
            url: serverConfig.url,
            ...config.anime,
            // Static config (0.12.0): TMDB_API_KEY env / config.yaml. The
            // runtime settings dialog died with the admin surface.
            getTmdbKey: () => config.anime?.tmdbApiKey,
            // Stills land minutes after a key is saved; rooms that are
            // already open need the refreshed media pushed or their
            // clients keep the stale (still-less) payload until a rejoin.
            onStillsEnriched: pushMediaToOpenRooms,
            // Season rotation landed (new snapshot already serving):
            // delete last season's rooms (the rotation reaper -- rows
            // resurrect fresh on the next join or verdict), re-deck open
            // rooms, and re-send the config frame so connected UIs
            // relabel and retheme without waiting for a reconnect.
            onSeasonRotated: (season) => {
              reconcileRoomSeasons(cour, season);
              pushMediaToOpenRooms();
              const provider = providers[0];
              void provider
                .getName()
                .then((serverName) => {
                  const payload = {
                    requiresConfiguration: false,
                    serverName,
                    providerType: provider.type,
                    season: season.season,
                    year: season.year,
                  };
                  for (const room of getAllRooms()) {
                    room.broadcastMessage({ type: 'config', payload });
                  }
                })
                .catch((err) => {
                  logger.warn(`season config broadcast failed: ${String(err)}`);
                });
            },
          }));
        } else {
          throw new Error(`server type ${serverConfig.type} unhandled.`);
        }

        for (const provider of providers) {
          if (!await provider.isAvailable()) {
            // For anilist this means first-boot-offline: no disk cache to
            // serve AND the API unreachable. Every later boot serves the
            // cached season and rides out an outage.
            throw new ProviderUnavailableError(
              `${provider.type} provider unavailable: ${provider.options.url.substring(0, 32)}`,
            );
          }
        }

        // Boot-time season sweep: the server may have been down across a
        // rotation point, leaving rooms (and their verdicts/locks) from
        // a season the provider no longer serves. Runs after
        // isAvailable so the provider's season is settled (it may be the
        // previous season if the incoming fetch had to fall back), and
        // before listen() so no client can load a stale room first.
        const bootSeason = providers[0]?.getSeason?.();
        if (bootSeason) reconcileRoomSeasons(cour, bootSeason);
      }

      const app = express();
      // Explicit (audit 12 #275): reely's rate limiter keys on
      // `socket.remoteAddress` (the real TCP peer) rather than `req.ip`,
      // and `req.ip` only follows `X-Forwarded-For` when `trust proxy` is
      // set. Setting `trust proxy` to false here makes the no-proxy
      // assumption explicit so a future contributor can't toggle it
      // accidentally and quietly enable IP-spoofing via headers.
      app.disable('trust proxy');
      // Structured per-request access logs (audit 12 #274): deliberately
      // not wired today. pino-http would mount here and emit one log line
      // per HTTP response with method / path / status / duration. The
      // 429 + 401 paths log explicitly via the rate-limit / basic-auth
      // middleware, so the practical visibility gap is mostly 2xx/3xx
      // noise. Revisit if an operator needs full request-trail logs.

      // Content Security Policy. useDefaults:false is deliberate -- helmet's
      // default CSP includes `upgrade-insecure-requests`, which would force
      // the browser to upgrade reely's plain-http LAN traffic to https and
      // break the whole app. We spell out the full directive set instead.
      //
      // script-src is strict 'self' (the Vite bundle and the PWA
      // registerSW.js are both self-hosted external files -- no inline
      // scripts in the production build). style-src needs 'unsafe-inline'
      // for React's style={{...}} attributes; inline styles are not a
      // meaningful XSS vector. Fonts have been self-hosted since 0.3.0,
      // so no external font origins remain. connect-src 'self' covers
      // the same-origin WebSocket (CSP3 treats ws/wss as same-origin to
      // the http/https page).
      app.use(helmet({
        // Helmet's default Referrer-Policy is no-referrer, and YouTube
        // REFUSES embedded playback without a referrer -- every PV in the
        // drawer showed "an error occurred" (found in the owner's first live
        // test, Firefox/Android). The browser default policy sends
        // origin-only cross-origin, which is all YouTube needs.
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        contentSecurityPolicy: {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            // PV trailers embed via YouTube's privacy-enhanced host
            // (0.7.0 details drawer). The iframe is the only external
            // surface the CSP allows.
            frameSrc: ['https://www.youtube-nocookie.com'],
            workerSrc: ["'self'"],
            manifestSrc: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        },
      }));

      // Gzip the SPA shell + static assets. Skip /api/poster (binary Plex
      // thumbs, already encoded -- gzipping a JPEG only wastes CPU). The
      // compression module also auto-skips responses without a compressible
      // mime, so this is mostly a CPU guard for the poster proxy.
      app.use(compression({
        filter: (req, res) => {
          if (req.path.startsWith('/api/poster/')) return false;
          return compression.filter(req, res);
        },
      }));

      // Inject providers into res.locals so all downstream route handlers can access them.
      app.use((_req, res, next) => { res.locals.providers = providers; next(); });

      // Per-route per-IP rate limits. Generous enough not to interfere with
      // legitimate use (poster fan-out on room join, healthcheck polling),
      // tight enough to short-circuit a flood.
      const healthLimit   = rateLimit({ windowMs: 60_000, max: 60,  name: 'health' });
      const posterLimit   = rateLimit({ windowMs: 60_000, max: 600, name: 'poster' });
      const templateLimit = rateLimit({ windowMs: 60_000, max: 60,  name: 'template' });

      app.get('/health', healthLimit, healthHandler);
      app.use(basicAuthHandler);
      app.get('/api/poster/:providerIndex/:metadataId/:thumbId', posterLimit, posterHandler);
      app.use(serveStaticHandler);
      app.get('*', templateLimit, templateHandler);

      // Build the underlying http/https server so we can attach the WS upgrade listener.
      // TLS bundle was already read at the top of this IIFE (audit 13
      // #293) so a bad cert/key path failed-fast before any startup
      // side effects. Re-use it here.
      const httpServer: ReturnType<typeof createHttpServer> = tlsBundle
        ? createHttpsServer({ cert: tlsBundle.cert, key: tlsBundle.key }, app)
        : createHttpServer(app);

      const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

      // Track liveness per-socket. We tag the WS via (ws as unknown as ...) to
      // avoid extending the ws type globally; the property is private to this
      // module.
      type LivenessTagged = { isAlive?: boolean };

      wss.on('connection', (ws) => {
        (ws as unknown as LivenessTagged).isAlive = true;
        ws.on('pong', () => {
          (ws as unknown as LivenessTagged).isAlive = true;
        });
        // Client manages its own lifecycle.
        new Client(ws, providers, cour);
      });

      httpServer.on('upgrade', createWsUpgradeHandler(wss));

      await new Promise<void>((resolveListening, rejectListening) => {
        httpServer.listen(config.port, config.hostname, () => {
          const proto = config.tlsConfig ? 'https' : 'http';
          logger.info(`Server listening on ${proto}://${config.hostname}:${config.port}`);
          // Visible flag in the container log for admins who bound to all
          // interfaces without Basic Auth. The app's room model is gated only
          // by knowledge of the room name -- on a routable network without
          // auth, that's effectively no gate at all.
          const bindsAllInterfaces =
            config.hostname === '0.0.0.0' || config.hostname === '::' || config.hostname === '';
          if (bindsAllInterfaces && !config.basicAuth) {
            logger.warn(
              `Bound to ${config.hostname || '0.0.0.0'} without Basic Auth. ` +
              'Anyone who can route to this host can join or create rooms. ' +
              'Set basicAuth in your config (or only expose this port to your LAN/VPN) to gate access.',
            );
          }
          resolveListening();
        });
        httpServer.once('error', rejectListening);
      });

      // Ping all connected clients every 30 seconds to keep connections alive
      // through reverse proxies that close idle WebSocket connections, AND to
      // detect zombie connections: any socket that hasn't responded to the
      // previous ping (still tagged isAlive=false) gets terminated. Created
      // only after listen() succeeds so a listen failure (which throws out of
      // this block) can't leak the interval -- _shutdownFn, the only thing
      // that clears it, is assigned further down.
      const pingInterval = setInterval(() => {
        for (const ws of wss.clients) {
          const tagged = ws as unknown as LivenessTagged;
          if (tagged.isAlive === false) {
            logger.info('Terminating unresponsive WebSocket (missed pong)');
            ws.terminate();
            continue;
          }
          tagged.isAlive = false;
          if (ws.readyState === ws.OPEN) ws.ping();
        }
      }, 30_000);

      // Shutdown is idempotent: the abort signal can only fire once, but
      // guard anyway. State is local to this Application instance -- no
      // module-global, so nothing leaks across instances.
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('Shutting down...');
        clearInterval(pingInterval);
        // wss.close() only stops accepting new connections; existing sockets
        // stay open. httpServer.close() then waits for all connections to end.
        // Terminate WS clients, then closeAllConnections() drops any lingering
        // plain-HTTP sockets (e.g. a slow poster-proxy stream) so the close
        // callback fires promptly instead of hanging until those drain.
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        httpServer.close(() => {
          logger.info('Server closed.');
          resolveStatus(undefined);
        });
        httpServer.closeAllConnections();
      };

      signal?.addEventListener('abort', () => {
        logger.info('Abort signal received. Closing server.');
        // Fire-and-forget: the listener can't await. shutdown() guards
        // itself against re-entry.
        void shutdown();
      });
      // A SIGINT/SIGTERM that arrived during async startup (TLS read, disk
      // sweep, provider probe, listen) fired abort() before the listener
      // above existed -- and an already-aborted signal does NOT invoke
      // listeners added after the fact (the exact semantics
      // tests/app/app.test.ts's waitForAbortListener works around). Without
      // this check, a docker stop mid-boot is logged by main.ts then
      // ignored: the server finishes starting and runs until SIGKILL.
      // (audit 16 #423)
      if (signal?.aborted) void shutdown();
    })().catch((err) => {
      // ProviderUnavailableError flows up to main.ts so it can log it
      // specifically; everything else becomes a generic startup-error exit.
      if (err instanceof ProviderUnavailableError) {
        rejectStatus(err);
        return;
      }
      logger.error(`Application startup error: ${String(err)}`);
      resolveStatus(1);
    });
  });

  return { statusCode };
};
