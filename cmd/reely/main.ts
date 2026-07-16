import minimist from 'minimist';
import { setLogLevel } from '../../internal/app/reely/logger';
import { loadConfig } from '../../internal/app/reely/config/main';
import { getVersion } from '../../internal/app/reely/version';
import { Application, ProviderUnavailableError } from '../../internal/app/reely/app';
import { logger } from '../../internal/app/reely/logger';
import type { Config } from '../../types/reely';
import type { ReelyError } from '../../internal/app/reely/util/assert';

// Last-resort handlers for errors nothing else caught. Logging goes
// through the redacting logger so a stray stack can't leak secrets.
//
// Asymmetric policy:
//   - uncaughtException: leaves the process in an undefined state per
//     Node's own contract. Log fatally and exit; room state lives in
//     SQLite as of 0.5.0, so there is no in-memory save queue to flush.
//     Supervisor (Docker / systemd) restarts.
//   - unhandledRejection: log and continue. Every async path that matters
//     in this codebase wraps its own errors (Room.media, saveRoom,
//     applyFilters, the poster proxy, rate-limit cache, etc.), so a
//     rejection that escapes to here indicates a bug in a non-critical
//     path; killing the server on it does more damage than letting it
//     surface in logs. To override (e.g. CI), set
//     NODE_OPTIONS='--unhandled-rejections=strict' on the runtime.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${String(reason)}`);
});
process.on('uncaughtException', (err) => {
  logger.fatal(`Uncaught exception: ${String(err)}`);
  process.exit(1);
});

(async () => {
  const flags = minimist(process.argv.slice(2), { alias: { v: 'version' } });

  if (flags.version) {
    // CLI version output, not application logging -- needs to land on
    // stdout for shell redirection / scripting. logger goes to pino
    // (different sink + format); console.log is correct here.
    // biome-ignore lint/suspicious/noConsole: CLI version output.
    console.log(`cour ${await getVersion()}`);
    process.exit(0);
  }

  const CONFIG_PATH: string | undefined = flags.config ?? process.env.CONFIG_PATH;

  // loadConfig throws on malformed YAML / permission errors / empty
  // Docker secret -- catch them explicitly here and exit
  // fatally. Without this catch they'd escape to the global
  // unhandledRejection handler above, which only logs -- leaving the
  // process alive without a config (audit 12 #212).
  let config: Config;
  let errors: ReelyError[];
  try {
    [config, errors] = await loadConfig(CONFIG_PATH);
  } catch (err) {
    logger.fatal(`Failed to load config: ${String(err)}`);
    process.exit(1);
  }

  // Partial-error policy:
  //   - Exactly one error AND it is ServersMustNotBeEmpty -> boot in
  //     "unconfigured" mode (the static "set PLEX_URL + PLEX_TOKEN" notice
  //     replaces the SPA shell). Other shapes of error are FATAL even when
  //     ServersMustNotBeEmpty is among them -- a misconfigured config is
  //     never silently partially started, since the bad fields could ride
  //     into a future re-configuration step. So:
  //       errors = [ServersMustNotBeEmpty]                   -> boot warn
  //       errors = [PortMustBeNumber, ServersMustNotBeEmpty] -> fatal exit
  //       errors = []                                        -> normal boot
  if (errors.length === 1 && errors[0].name === 'ServersMustNotBeEmpty') {
    logger.error(
      'cour is not configured -- no server block. Set PROVIDER=anilist ' +
      '(or add servers: [{type: anilist}] to config.yaml) and restart.',
    );
  } else if (errors.length) {
    logger.fatal(
      `Found configuration errors: ${errors.map((e) => `\n - ${e.name} - ${e.message}`).join('')}`,
    );
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  logger.info(`cour ${await getVersion()}`);
  // Safe despite logging the full config: registerRedactions() (run in
  // loadConfig above) registered addRedaction() for the server URL and
  // basicAuth password, so the logger redacts both.
  logger.debug(`Config: ${JSON.stringify(config, null, 2)}`);

  // Graceful shutdown. SIGINT is Ctrl-C; SIGTERM is what `docker stop` sends
  // -- both must run the abort path. Registered exactly once (the old
  // config-reload loop re-registered SIGINT every iteration).
  const abortController = new AbortController();
  const shutdown = (sig: string) => {
    logger.info(`${sig} received. Shutting down.`);
    abortController.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const app = Application(config, abortController.signal);
    // statusCode resolves undefined on a clean shutdown -> exit 0.
    const exitCode = await app.statusCode;
    process.exit(exitCode ?? 0);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      logger.fatal(String(err));
    } else {
      logger.fatal(`Unexpected error: ${String(err)}`);
    }
    process.exit(1);
  }
})();
