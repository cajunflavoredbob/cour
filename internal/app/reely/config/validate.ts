import { isRecord, type ReelyError } from '../util/assert';
import {
  AnimeCacheDirInvalid,
  AnimeConfigInvalid,
  AnimeSeasonInvalid,
  AnimeShowSequelsInvalid,
  AnimeYearInvalid,
  BasicAuthInvalid,
  BasicAuthPasswordInvalid,
  BasicAuthUserNameInvalid,
  ConfigMustBeRecord,
  HostNameMustBeString,
  LogLevelInvalid,
  PortMustBeNumber,
  ServerBasePathInvalid,
  ServerMustBeRecord,
  ServersMustBeArray,
  ServersMustNotBeEmpty,
  ServerTypeInvalid,
  ServerUrlInvalid,
  ServerUrlMustBeString,
  TlsConfigCertFileInvalid,
  TlsConfigInvalid,
  TlsConfigKeyFileInvalid,
} from './errors';

// Valid log level names accepted in configuration.
// These map to pino log levels internally (see logger.ts).
const VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];

// Valid anime broadcast seasons (anime.season), post-uppercase-normalize.
const VALID_ANIME_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

// Audit 15 #383: consolidates the repeated `typeof X !== 'string'` +
// `errors.push(new ErrorClass(message))` pattern (was 9 sites). The
// `value is string` predicate also narrows the caller's reference
// after the check, so the existing follow-on logic (URL.parse,
// length check, startsWith, etc.) sees a typed string.
const requireString = (
  value: unknown,
  errors: ReelyError[],
  ErrorClass: new (msg?: string) => ReelyError,
  message: string,
): value is string => {
  if (typeof value !== 'string') {
    errors.push(new ErrorClass(message));
    return false;
  }
  return true;
};

// Normalizes `value` IN PLACE (coerces port to a number, uppercases logLevel)
// and returns the list of validation errors. The name leads with "normalize"
// because that mutation is load-bearing, not a side effect: loadConfig()
// caches and uses the mutated object, and removing the coercion would break
// YAML configs that supply e.g. `port: "8000"` or `logLevel: info`.
export const normalizeAndValidateConfig = (
  value: unknown,
): ReelyError[] => {
  const errors: ReelyError[] = [];

  try {
    isRecord(value, 'config', ConfigMustBeRecord);

    if (value.hostname) {
      requireString(value.hostname, errors, HostNameMustBeString, 'hostname must be a string');
    }

    if (value.port !== undefined) {
      if (typeof value.port === 'string') {
        value.port = Number(value.port);
      }

      if (
        Number.isNaN(value.port) ||
        !Number.isInteger(value.port) ||
        (value.port as number) < 1 ||
        (value.port as number) > 65535
      ) {
        errors.push(new PortMustBeNumber('Port must be an integer between 1 and 65535'));
      }
    }

    if (value.logLevel) {
      if (typeof value.logLevel === 'string') {
        value.logLevel = value.logLevel.toUpperCase();

        if (!VALID_LOG_LEVELS.includes(value.logLevel as string)) {
          errors.push(
            new LogLevelInvalid(
              `logLevel must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
            ),
          );
        }
      } else {
        errors.push(new LogLevelInvalid('logLevel must be a string'));
      }
    }

    if (!Array.isArray(value.servers)) {
      errors.push(new ServersMustBeArray('servers must be an Array'));
    } else if (value.servers.length === 0) {
      errors.push(
        new ServersMustNotBeEmpty('At least one server must be configured'),
      );
    } else {
      for (const server of value.servers) {
        try {
          isRecord(server, 'server', ServerMustBeRecord);

          if (server.type) {
            if (server.type !== 'anilist') {
              errors.push(
                new ServerTypeInvalid(
                  `server type must be "anilist". Got "${server.type}"`,
                ),
              );
            }
          }

          if (requireString(server.url, errors, ServerUrlMustBeString, 'a server url must be specified')) {
            // URL parse is validation; redaction registration moved to
            // config/redact.ts in 0.4.16 (audit 12 #237 + #276). The
            // validator is now a pure (unknown) -> ReelyError[] and no
            // longer imports the logger.
            try {
              new URL(server.url);
            } catch {
              errors.push(new ServerUrlInvalid(
                `"${server.url}" is not a valid URL. Include the protocol, e.g. http://${server.url}`,
              ));
            }
          }

          // Plex-era fields (token, libraryTitleFilter) died with the
          // 0.4.0 teardown. Existing YAML/env values are silently ignored
          // (the validator doesn't error on unknown fields).

        } catch (err) {
          errors.push(err as ReelyError);
        }
      }
    }

    if (value.rootPath) {
      if (requireString(value.rootPath, errors, ServerBasePathInvalid, 'rootPath must be a string')) {
        if (value.rootPath === '/') {
          errors.push(new ServerBasePathInvalid('rootPath must not be "/"'));
        } else if (!value.rootPath.startsWith('/')) {
          errors.push(new ServerBasePathInvalid('rootPath must start with "/"'));
        }
      }
    }

    // Boolean-only knob (audit 10 #165 / audit 12 #226). The env loader's
    // EnvBool coerces strings to true booleans before we see them here, so
    // a non-boolean value originates from YAML -- a YAML `1` or `"true"`
    // is rejected so the operator can't think they've disabled exposure
    // when they haven't.

    if (value.basicAuth) {
      try {
        isRecord(value.basicAuth, 'basicAuth', BasicAuthInvalid);

        // Must be non-empty. An empty password used to pass the type check,
        // booting the app "protected" by the guessable base64("user:") --
        // a silent auth bypass.
        if (requireString(value.basicAuth.userName, errors, BasicAuthUserNameInvalid, 'basicAuth.userName must be a non-empty string')
            && value.basicAuth.userName === '') {
          errors.push(new BasicAuthUserNameInvalid('basicAuth.userName must be a non-empty string'));
        }
        if (requireString(value.basicAuth.password, errors, BasicAuthPasswordInvalid, 'basicAuth.password must be a non-empty string')
            && value.basicAuth.password === '') {
          errors.push(new BasicAuthPasswordInvalid('basicAuth.password must be a non-empty string'));
        }
      } catch (err) {
        errors.push(err as ReelyError);
      }
    }

    if (value.tlsConfig) {
      try {
        isRecord(value.tlsConfig, 'tlsConfig', TlsConfigInvalid);
        requireString(value.tlsConfig.certFile, errors, TlsConfigCertFileInvalid, 'tlsConfig.certFile must be a string');
        requireString(value.tlsConfig.keyFile, errors, TlsConfigKeyFileInvalid, 'tlsConfig.keyFile must be a string');
      } catch (err) {
        errors.push(err as ReelyError);
      }
    }

    if (value.anime) {
      try {
        isRecord(value.anime, 'anime', AnimeConfigInvalid);

        // Normalize case IN PLACE (same contract as logLevel above): YAML
        // `season: summer` and env ANIME_SEASON=Summer are both accepted;
        // downstream consumers (the anilist provider + cache filenames)
        // always see the canonical uppercase form.
        if (value.anime.season !== undefined) {
          if (typeof value.anime.season === 'string') {
            value.anime.season = value.anime.season.toUpperCase();
            if (!VALID_ANIME_SEASONS.includes(value.anime.season as string)) {
              errors.push(
                new AnimeSeasonInvalid(
                  `anime.season must be one of: ${VALID_ANIME_SEASONS.join(', ')}`,
                ),
              );
            }
          } else {
            errors.push(new AnimeSeasonInvalid('anime.season must be a string'));
          }
        }

        if (value.anime.year !== undefined) {
          // Same string-coercion courtesy as port: YAML `year: "2026"`.
          if (typeof value.anime.year === 'string') {
            value.anime.year = Number(value.anime.year);
          }
          // AniList's seasonal data starts in the 1940s; the upper bound
          // catches a fat-fingered 20026 while allowing next-season
          // configs a comfortable horizon.
          if (
            Number.isNaN(value.anime.year) ||
            !Number.isInteger(value.anime.year) ||
            (value.anime.year as number) < 1940 ||
            (value.anime.year as number) > 2100
          ) {
            errors.push(
              new AnimeYearInvalid('anime.year must be an integer between 1940 and 2100'),
            );
          }
        }

        // Boolean-only: EnvBool already
        // coerced the env form, so a non-boolean here is a YAML value like
        // `showSequels: "false"` -- which would be truthy if let through.
        if (value.anime.showSequels !== undefined && typeof value.anime.showSequels !== 'boolean') {
          errors.push(
            new AnimeShowSequelsInvalid('anime.showSequels must be a boolean'),
          );
        }

        if (value.anime.cacheDir !== undefined) {
          if (
            requireString(value.anime.cacheDir, errors, AnimeCacheDirInvalid, 'anime.cacheDir must be a non-empty string') &&
            value.anime.cacheDir === ''
          ) {
            errors.push(new AnimeCacheDirInvalid('anime.cacheDir must be a non-empty string'));
          }
        }
      } catch (err) {
        errors.push(err as ReelyError);
      }
    }
  } catch (err) {
    errors.push(err as ReelyError);
  }

  return errors;
};
