import type { Request, Response } from 'express';
import type { RouteContext } from '../types';

/**
 * Liveness AND usability, deliberately both.
 *
 * This used to be an unconditional 200. That was honest while a provider
 * that could not serve its season failed the boot outright: the container
 * sat visibly in `Restarting` and an operator, an uptime monitor or a
 * `condition: service_healthy` gate all saw the outage. The server now
 * stays up on the previous season's deck instead of crash-looping, which
 * is better for everyone EXCEPT the signal: in that state every join,
 * create and verdict is refused, and an unconditional 200 would report a
 * totally unusable server as healthy.
 *
 * So a provider that is knowingly serving a stale season reports 503.
 * The process is alive and the response says why; what it is not is
 * ready. Recovery needs no intervention (the provider retries every 30s),
 * so this flips back on its own.
 */
export const handler = (ctx?: RouteContext) => (_req: Request, res: Response): void => {
  const provider = ctx?.providers?.[0];
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
