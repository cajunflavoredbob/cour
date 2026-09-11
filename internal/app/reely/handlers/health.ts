import type { Request, Response } from 'express';
import type { RouteContext } from '../types';

/**
 * Liveness AND readiness. A provider knowingly serving a stale season
 * refuses every join, create and verdict, so reporting 200 there would
 * call a totally unusable server healthy, including to a
 * `condition: service_healthy` gate. It flips back on its own once the
 * provider's retry lands.
 *
 * `ctx` is required so tsc catches a wiring reduced to `healthHandler()`,
 * which would silently restore the unconditional 200.
 */
export const handler = (ctx: RouteContext) => (_req: Request, res: Response): void => {
  const provider = ctx.providers?.[0];
  if (provider?.isSeasonProvisional?.()) {
    const served = provider.getSeason?.();
    res
      .status(503)
      .send(
        'cour is alive but not ready: the anime provider is unreachable, so it is ' +
          `serving a stale ${served ? `${served.season} ${served.year}` : 'season'} ` +
          'and refusing room operations. This clears automatically once a ' +
          'rotation attempt succeeds.',
      );
    return;
  }
  res.status(200).send('cour is alive');
};
