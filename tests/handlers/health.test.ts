import { describe, expect, it } from 'vitest';
import { handler } from '../../internal/app/reely/handlers/health';
import type { RouteContext } from '../../internal/app/reely/types';
import { makeReq, makeRes } from '../helpers';

// Smoke tests for the health handler. The Docker HEALTHCHECK polls this
// and docker-compose documents gating dependent services on
// `condition: service_healthy`, so the status code here is a real
// operator-facing signal, not decoration.
// (Audit 13 #338 originally classified this as "deliberately deferred
// -- trivial wrapper". The minimal smoke coverage is added 0.4.50 as
// part of the 0.5.0 close-out so the audit-log status flips from
// untested to minimally-covered.)

// biome-ignore lint/suspicious/noExplicitAny: season surface only; the rest of ReelyProvider is unused here.
const providerStub = (provisional: boolean, season: boolean): any => ({
  type: 'anilist',
  options: { url: 'https://graphql.anilist.co' },
  ...(season ? { getSeason: () => ({ season: 'SUMMER', year: 2026 }) } : {}),
  isSeasonProvisional: () => provisional,
});

const ctxWith = (provisional: boolean, season = true): RouteContext => ({
  providers: [providerStub(provisional, season)],
});

describe('handler (/health)', () => {
  it('responds with HTTP 200', () => {
    const req = makeReq();
    const res = makeRes();
    handler()(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sends the "cour is alive" body (used by the Docker HEALTHCHECK)', () => {
    const req = makeReq();
    const res = makeRes();
    handler()(req, res);
    expect(res.send).toHaveBeenCalledWith('cour is alive');
  });

  it('returns void (no Promise; the docker healthcheck calls it synchronously)', () => {
    const req = makeReq();
    const res = makeRes();
    const result = handler()(req, res);
    expect(result).toBeUndefined();
  });

  it('stays 200 when the provider is serving its real season', () => {
    const res = makeRes();
    handler(ctxWith(false))(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // The reason this endpoint is no longer unconditional: a degraded
  // upstream used to fail the boot, so an outage was visible as a
  // restart loop. The server now stays up on the previous season's deck
  // with every room operation refused, and reporting that as healthy
  // would hide a total functional outage from the healthcheck, from
  // `condition: service_healthy`, and from any uptime monitor.
  it('reports 503 while the provider is knowingly serving a stale season', () => {
    const res = makeRes();
    handler(ctxWith(true))(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    const body = String(res.send.mock.calls[0][0]);
    expect(body).toContain('not ready');
    expect(body).toContain('SUMMER 2026');
    // Says it recovers on its own, so nobody restarts the container by hand.
    expect(body).toContain('automatically');
  });

  it('does not throw when a provisional provider exposes no getSeason', () => {
    const res = makeRes();
    expect(() => handler(ctxWith(true, false))(makeReq(), res)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('stays 200 for a provider with no season surface at all', () => {
    // isSeasonProvisional is optional on ReelyProvider; a provider
    // without it must not be reported unhealthy forever.
    const res = makeRes();
    handler({ providers: [{ type: 'anilist' }] as never })(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
