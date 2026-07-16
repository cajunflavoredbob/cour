import type { Config } from '../../../../types/reely';
import { ANILIST_API_URL } from '../../anilist/api';
import { readDockerSecret } from './load_secrets';

export type ConfigEnvVariableName =
  | 'AUTH_USER' | 'AUTH_PASS' | 'TLS_CERT' | 'TLS_KEY'
  | 'HOST' | 'PORT' | 'LOG_LEVEL' | 'ROOT_PATH' | 'ALLOWED_ORIGINS'
  | 'PROVIDER'
  | 'ANIME_SEASON' | 'ANIME_YEAR' | 'ANIME_SHOW_SEQUELS' | 'ANIME_CACHE_DIR'
  | 'TMDB_API_KEY';

// Splits a comma-separated env value, trimming each segment and dropping
// empties so "a,,b" or "a, b " yields ["a","b"], not ["a","","b"].
const EnvList = (value: string) =>
  value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

// Parses a boolean env value. Accepts true/1/yes/on (case-insensitive) as
// true; false/0/no/off as false. Anything else throws -- silent coercion
// of a typo'd value to a default would hide misconfiguration (a typo'd
// ANIME_SHOW_SEQUELS=ture would otherwise resolve to the default
// instead of surfacing the typo).
const EnvBool = (value: string): boolean => {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new Error(
    `Env var value ${JSON.stringify(value)} is not a valid boolean ` +
      '(accepts true/false, 1/0, yes/no, on/off, case-insensitive)',
  );
};

// Strips undefined entries so we don't accidentally override YAML config with
// undefined values when merging env config and file config together.
const trimRecord = (value: Record<string, unknown>) => {
  const entries = Object.entries(value).filter(([, v]) => typeof v !== 'undefined');
  if (entries.length !== 0) return Object.fromEntries(entries);
};

const getTrimmedEnv = (
  key: ConfigEnvVariableName,
  Type: typeof String | typeof Number | typeof EnvList | typeof EnvBool = String,
) => {
  const value = process.env[key];
  if (!value) return undefined;
  const parsed = Type(value.trim());
  // Number(non-numeric) is NaN, which would then be spread into the partial
  // config and override the default. Fail fast at load time with a clear
  // message instead of letting NaN propagate.
  if (Type === Number && !Number.isFinite(parsed as number)) {
    // JSON.stringify quotes + escapes the raw value (audit 12 #236) so
    // a hostile string like `PORT="<script>..."` lands in logs as a
    // safe literal rather than verbatim characters in the message.
    throw new Error(`Env var ${key}=${JSON.stringify(value)} is not a valid number`);
  }
  return parsed;
};

// Reads supported environment variables and returns a partial Config.
// Environment variables take precedence over the YAML config file (see
// config/main.ts).
//
// The plex-era vars (PLEX_URL / PLEX_TOKEN / LIBRARY_TITLE_FILTER /
// EXPOSE_PLEX_BASE_URL) died with the 0.4.0 teardown. PROVIDER remains as
// fail-fast validation -- a typo'd value should error, not silently boot
// the wrong (or any) stack -- but "anilist" is both the only accepted
// value and the default.
export const loadFromEnv = async (): Promise<Partial<Config> | undefined> => {
  // Partial-bundle gates (audit 12 #198): each bundle (basicAuth,
  // tlsConfig) is only emitted when BOTH halves of its required pair are
  // present. Without the gate, setting only AUTH_USER (or only TLS_CERT)
  // emits a bundle that spreads over the YAML and erases the partner
  // field already configured there.
  //
  // readDockerSecret is async (audit 12 #209) so loadFromEnv is too.
  const providerRaw = getTrimmedEnv('PROVIDER');
  if (providerRaw !== undefined && providerRaw !== 'anilist') {
    throw new Error(
      `Env var PROVIDER=${JSON.stringify(providerRaw)} is not a valid provider ` +
        '(cour is anime-only; the value must be "anilist" or unset)',
    );
  }

  // PROVIDER=anilist emits a complete server bundle on its own: AniList is
  // a public API, so there is no token, and the URL is the public endpoint.
  const server = providerRaw === 'anilist'
    ? { type: 'anilist', url: ANILIST_API_URL }
    : undefined;

  // Anime tuning block. trimRecord collapses an all-unset block to
  // undefined so it can't erase a YAML-provided block via the merge spread.
  const anime = trimRecord({
    season:      getTrimmedEnv('ANIME_SEASON'),
    year:        getTrimmedEnv('ANIME_YEAR', Number),
    showSequels: getTrimmedEnv('ANIME_SHOW_SEQUELS', EnvBool),
    cacheDir:    getTrimmedEnv('ANIME_CACHE_DIR'),
    tmdbApiKey:  getTrimmedEnv('TMDB_API_KEY'),
  });

  const authUser = getTrimmedEnv('AUTH_USER');
  const authPass = (await readDockerSecret('auth_pass')) ?? getTrimmedEnv('AUTH_PASS');
  const basicAuth = (authUser && authPass)
    ? { userName: authUser, password: authPass }
    : undefined;

  const certFile = getTrimmedEnv('TLS_CERT');
  const keyFile  = getTrimmedEnv('TLS_KEY');
  const tlsConfig = (certFile && keyFile)
    ? { certFile: certFile as string, keyFile: keyFile as string }
    : undefined;

  return trimRecord({
    hostname:           getTrimmedEnv('HOST'),
    port:               getTrimmedEnv('PORT', Number),
    logLevel:           getTrimmedEnv('LOG_LEVEL'),
    rootPath:           getTrimmedEnv('ROOT_PATH'),
    allowedOrigins:     getTrimmedEnv('ALLOWED_ORIGINS', EnvList),
    servers:            server ? [server] : undefined,
    basicAuth,
    tlsConfig,
    anime,
  }) as Partial<Config> | undefined;
};
