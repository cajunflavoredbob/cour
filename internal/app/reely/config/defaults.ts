import type { Config } from '../../../../types/reely';
import { ANILIST_API_URL } from '../../anilist/api';

const defaultServerConfig: Partial<Config["servers"][number]> = {
  type: "anilist",
};

const defaultConfig: Partial<Config> = {
  hostname: "0.0.0.0",
  port: 8000,
  logLevel: "INFO",
  rootPath: "",
  // AniList is the only provider (0.13.2): it IS the default. Zero
  // configuration boots a working app; PROVIDER/YAML server entries
  // remain as overrides-in-shape only.
  servers: [{ type: "anilist", url: ANILIST_API_URL }],
};

export const applyDefaults = (
  config: Partial<Config>,
): Partial<Config> => {
  const _config = { ...defaultConfig, ...config };
  if (Array.isArray(_config.servers)) {
    _config.servers = _config.servers.map((server) => {
      const merged = { ...defaultServerConfig, ...server };
      // An anilist server needs no operator-supplied URL -- the public
      // GraphQL endpoint is the only real value. Filled here (not in the
      // provider) so the validator's URL check runs against the actual
      // value the provider will use. YAML `servers: [{ type: anilist }]`
      // is a complete configuration.
      if (merged.type === 'anilist' && !merged.url) {
        merged.url = ANILIST_API_URL;
      }
      return merged;
    });
  }
  return _config;
};
