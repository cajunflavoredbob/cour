import { readFile } from 'node:fs/promises';
import { load as parseYaml, CORE_SCHEMA } from 'js-yaml';
import type { Config } from '../../../../types/reely';
import { isRecord } from '../util/assert';
import { ConfigFileNotFoundError } from './errors';

export const loadFromYaml = async (path: string): Promise<Partial<Config>> => {
  let raw: string;

  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // Surface a typed error only for the genuine "file does not exist" case.
    // Other I/O errors (EACCES, EISDIR, EIO, etc.) should propagate as-is so
    // operators see the actual cause rather than a misleading not-found
    // message that masks permission or hardware issues.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigFileNotFoundError(`${path} does not exist`);
    }
    throw err;
  }

  // A contentless file -- blank, or comments/blank lines only (the
  // realistic shape: an operator comments out every line): js-yaml 5
  // throws its own "expected a document" here where v4 returned
  // undefined. Route it through the same assertion a non-mapping
  // document hits, so the operator sees the one consistent "must be an
  // object" boot error either way.
  const contentless = raw.split('\n').every((line) => /^\s*(#|$)/.test(line));
  if (contentless) isRecord(undefined, path);

  // CORE_SCHEMA narrows js-yaml's default to YAML 1.2 core types:
  // strings, numbers, true/false (NOT the 1.1 yes/no/on/off/y/n
  // sludge -- `port: on` and `LOG_LEVEL: y` stay strings for the
  // validator to reject, the original point of audit 12 #235's schema
  // pin), plus the null idioms (~ / Null / empty value). The previous
  // JSON_SCHEMA pin delivered the same set on js-yaml v4, but v5
  // reworked JSON_SCHEMA to strict JSON semantics where `rootPath: ~`
  // parses as the string "~" -- a config that booted on v4 would feed
  // garbage into the validator and die on a misleading error.
  const parsed = parseYaml(raw, { schema: CORE_SCHEMA });
  isRecord(parsed, path);

  return parsed as Partial<Config>;
};
