import { join } from 'path';

import type {
  Dependencies,
  DependencyType,
  Env,
  File,
  ModrinthIndex,
  ModrinthProject,
  ModrinthVersion,
  VersionDependency,
  VersionFile,
  VersionQuery,
  VersionSource,
} from './types.js';

import { request } from '../http.js';
import { isJsonObject, isStringArray, type Json, parseJson } from '../json.js';
import {
  delay,
  memoizeWithResponseLog,
  readCacheEntry,
  retryAfterSeconds,
  writeCacheEntry,
} from '../utils.js';

// 300/min from X-Ratelimit-Limit. 80% is 240/min, one request every 250ms.
const RATE_WINDOW_S = 60;
const REQUEST_INTERVAL_MS = (RATE_WINDOW_S * 1000) / (300 * 0.8);

// Project env metadata and version lists change over time; versions and
// hashes do not, so only the mutable endpoints expire.
const MUTABLE_TTL_MS = 24 * 60 * 60 * 1000;

export const parseModrinthDownload = (
  url: string | undefined,
): null | { projectId: string; versionId: string } => {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    const [data, projectId, versions, versionId, filename] = parsed.pathname
      .split('/')
      .filter(Boolean);
    return parsed.hostname === 'cdn.modrinth.com' &&
      data === 'data' &&
      versions === 'versions' &&
      projectId !== undefined &&
      versionId !== undefined &&
      filename !== undefined
      ? { projectId, versionId }
      : null;
  } catch {
    return null;
  }
};

export const parseProjectId = (url: string | undefined): null | string =>
  parseModrinthDownload(url)?.projectId ?? null;

const side = (value: Json | undefined): Env['client'] =>
  value === 'optional' || value === 'required' || value === 'unsupported'
    ? value
    : 'optional';

const parseEach = <I, T>(
  items: readonly I[],
  parse: (item: I) => null | T,
): null | T[] => {
  const parsed: T[] = [];
  for (const item of items) {
    const value = parse(item);
    if (value === null) return null;
    parsed.push(value);
  }
  return parsed;
};

const parseProject = (body: Json): ModrinthProject | null => {
  if (!isJsonObject(body) || typeof body['id'] !== 'string') return null;
  return {
    client_side: side(body['client_side']),
    id: body['id'],
    server_side: side(body['server_side']),
  };
};

const parseVersionFile = (body: Json): null | VersionFile => {
  if (!isJsonObject(body)) return null;
  const filename = body['filename'];
  const primary = body['primary'];
  const size = body['size'];
  const url = body['url'];
  const hashes = body['hashes'];
  if (
    typeof filename !== 'string' ||
    typeof primary !== 'boolean' ||
    typeof size !== 'number' ||
    typeof url !== 'string' ||
    hashes === undefined ||
    !isJsonObject(hashes) ||
    typeof hashes['sha1'] !== 'string' ||
    typeof hashes['sha512'] !== 'string'
  ) {
    return null;
  }
  return {
    filename,
    hashes: { sha1: hashes['sha1'], sha512: hashes['sha512'] },
    primary,
    size,
    url,
  };
};

const dependencyTypes: Record<DependencyType, true> = {
  embedded: true,
  incompatible: true,
  optional: true,
  required: true,
};

const isDependencyType = (value: string): value is DependencyType =>
  Object.hasOwn(dependencyTypes, value);

// An unknown dependency type is dropped rather than invalidating its version.
const parseVersionDependency = (body: Json): null | VersionDependency[] => {
  if (!isJsonObject(body) || typeof body['dependency_type'] !== 'string') {
    return null;
  }
  const dependencyType = body['dependency_type'];
  const projectId = body['project_id'];
  const versionId = body['version_id'];
  if (typeof projectId !== 'string' && projectId !== null) return null;
  if (typeof versionId !== 'string' && versionId !== null) return null;
  return isDependencyType(dependencyType)
    ? [
        {
          dependency_type: dependencyType,
          project_id: projectId,
          version_id: versionId,
        },
      ]
    : [];
};

const parseVersion = (body: Json): ModrinthVersion | null => {
  if (!isJsonObject(body)) return null;
  const datePublished = body['date_published'];
  const id = body['id'];
  const projectId = body['project_id'];
  const versionNumber = body['version_number'];
  const versionType = body['version_type'];
  const loaders = body['loaders'];
  const gameVersions = body['game_versions'];
  const files = body['files'];
  const dependencies = body['dependencies'];
  if (
    typeof datePublished !== 'string' ||
    typeof id !== 'string' ||
    typeof projectId !== 'string' ||
    typeof versionNumber !== 'string' ||
    typeof versionType !== 'string' ||
    loaders === undefined ||
    !isStringArray(loaders) ||
    gameVersions === undefined ||
    !isStringArray(gameVersions) ||
    files === undefined ||
    !Array.isArray(files) ||
    dependencies === undefined ||
    !Array.isArray(dependencies)
  ) {
    return null;
  }
  const parsedFiles = parseEach(files, parseVersionFile);
  const parsedDependencies = parseEach(dependencies, parseVersionDependency);
  if (parsedFiles === null || parsedDependencies === null) return null;
  return {
    date_published: datePublished,
    dependencies: parsedDependencies.flat(),
    files: parsedFiles,
    game_versions: gameVersions,
    id,
    loaders,
    project_id: projectId,
    version_number: versionNumber,
    version_type: versionType,
  };
};

const parseVersionList = (body: Json): ModrinthVersion[] | null =>
  Array.isArray(body) ? parseEach(body, parseVersion) : null;

const parseFile = (body: Json): File | null => {
  if (!isJsonObject(body)) return null;
  const downloads = body['downloads'];
  const env = body['env'];
  const fileSize = body['fileSize'];
  const hashes = body['hashes'];
  const path = body['path'];
  if (
    downloads === undefined ||
    !isStringArray(downloads) ||
    env === undefined ||
    !isJsonObject(env) ||
    typeof fileSize !== 'number' ||
    hashes === undefined ||
    !isJsonObject(hashes) ||
    typeof hashes['sha1'] !== 'string' ||
    typeof hashes['sha512'] !== 'string' ||
    typeof path !== 'string'
  ) {
    return null;
  }
  const client = side(env['client']);
  const server = side(env['server']);
  return {
    downloads,
    env: { client, server },
    fileSize,
    hashes: { sha1: hashes['sha1'], sha512: hashes['sha512'] },
    path,
  };
};

const parseDependencies = (body: Json): Dependencies | null => {
  if (!isJsonObject(body) || typeof body['minecraft'] !== 'string') return null;
  const fabric = body['fabric-loader'];
  const neoforge = body['neoforge'];
  if (
    (fabric !== undefined && typeof fabric !== 'string') ||
    (neoforge !== undefined && typeof neoforge !== 'string')
  ) {
    return null;
  }
  const dependencies: Dependencies = { minecraft: body['minecraft'] };
  if (typeof fabric === 'string') dependencies['fabric-loader'] = fabric;
  if (typeof neoforge === 'string') dependencies.neoforge = neoforge;
  return dependencies;
};

export const parseModrinthIndex = (body: Json): ModrinthIndex | null => {
  if (!isJsonObject(body)) return null;
  const dependencies = body['dependencies'];
  const files = body['files'];
  const formatVersion = body['formatVersion'];
  const game = body['game'];
  const name = body['name'];
  const summary = body['summary'];
  const versionId = body['versionId'];
  if (
    dependencies === undefined ||
    files === undefined ||
    !Array.isArray(files) ||
    typeof formatVersion !== 'number' ||
    typeof game !== 'string' ||
    typeof name !== 'string' ||
    typeof versionId !== 'string' ||
    (summary !== undefined && typeof summary !== 'string')
  ) {
    return null;
  }
  const parsedDependencies = parseDependencies(dependencies);
  const parsedFiles = parseEach(files, parseFile);
  if (parsedDependencies === null || parsedFiles === null) return null;
  const index: ModrinthIndex = {
    dependencies: parsedDependencies,
    files: parsedFiles,
    formatVersion,
    game,
    name,
    versionId,
  };
  if (typeof summary === 'string') index.summary = summary;
  return index;
};

// Caller stays sequential: one request in flight, then the interval.
const modrinthFetch = async (
  url: string,
  init?: RequestInit,
  retry = true,
): Promise<Response> => {
  const res = await request(url, init);
  if (res.status === 429 && retry) {
    const retryAfter = retryAfterSeconds(
      res.headers.get('Retry-After'),
      RATE_WINDOW_S,
    );
    console.warn(`  Rate limited, retrying in ${retryAfter}s`);
    await res.body?.cancel();
    await delay(retryAfter * 1000);
    return modrinthFetch(url, init, false);
  }
  await delay(REQUEST_INTERVAL_MS);
  return res;
};

const fetchModrinthJson = async <T>(
  url: string,
  parse: (body: Json) => null | T,
  label: string,
): Promise<null | T> => {
  const res = await modrinthFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parse(parseJson(await res.text()));
  if (parsed === null) throw new Error(`invalid ${label} payload`);
  return parsed;
};

const fetchVersions = async (
  query: VersionQuery,
): Promise<ModrinthVersion[]> => {
  const params = new URLSearchParams({
    game_versions: JSON.stringify([query.game]),
  });
  if (query.loaders.length > 0) {
    params.set('loaders', JSON.stringify(query.loaders));
  }
  return (
    (await fetchModrinthJson(
      `https://api.modrinth.com/v2/project/${query.projectId}/version?${params.toString()}`,
      parseVersionList,
      'version',
    )) ?? []
  );
};

/**
 * Maps each sha1 Modrinth knows to its version; unknown hashes are absent.
 * Hash lookups are immutable, so hits are cached permanently per hash and only
 * hashes Modrinth has not answered yet are requested; misses stay uncached.
 */
const fetchVersionsByHash = async (
  cacheDir: string,
  hashes: readonly string[],
): Promise<Map<string, ModrinthVersion>> => {
  const versions = new Map<string, ModrinthVersion>();
  const missing: string[] = [];
  for (const hash of new Set(hashes)) {
    const hit = await readCacheEntry<ModrinthVersion>(
      join(cacheDir, `hash-${hash}.json`),
      null,
    );
    if (hit === undefined) missing.push(hash);
    else versions.set(hash, hit);
  }
  if (missing.length === 0) return versions;

  const res = await modrinthFetch('https://api.modrinth.com/v2/version_files', {
    body: JSON.stringify({ algorithm: 'sha1', hashes: missing }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = parseJson(await res.text());
  const invalidPayload = 'invalid version_files payload';
  if (!isJsonObject(body)) throw new Error(invalidPayload);
  const entries = parseEach(Object.entries(body), ([hash, raw]) => {
    const version = parseVersion(raw);
    return version === null ? null : ([hash, version] as const);
  });
  if (entries === null) throw new Error(invalidPayload);
  for (const [hash, version] of entries) {
    versions.set(hash, version);
    await writeCacheEntry(join(cacheDir, `hash-${hash}.json`), version);
  }
  return versions;
};

export interface ModrinthClient extends VersionSource {
  fetchVersionsByHash: (
    hashes: readonly string[],
  ) => Promise<Map<string, ModrinthVersion>>;
  getProject: (projectId: string) => Promise<ModrinthProject | null>;
}

export const createModrinthClient = (cacheDir: string): ModrinthClient => ({
  fetchProjectVersions: memoizeWithResponseLog(
    cacheDir,
    (query: VersionQuery) =>
      `versions-${query.projectId}-${query.game}-${query.loaders.length > 0 ? query.loaders.join('+') : 'all'}.json`,
    fetchVersions,
    MUTABLE_TTL_MS,
  ),
  fetchVersionById: memoizeWithResponseLog(
    cacheDir,
    (id: string) => `version-${id}.json`,
    (versionId: string) =>
      fetchModrinthJson(
        `https://api.modrinth.com/v2/version/${versionId}`,
        parseVersion,
        'version',
      ),
    null,
  ),
  fetchVersionsByHash: hashes => fetchVersionsByHash(cacheDir, hashes),
  getProject: memoizeWithResponseLog(
    cacheDir,
    (id: string) => `${id}.json`,
    (projectId: string) =>
      fetchModrinthJson(
        `https://api.modrinth.com/v2/project/${projectId}`,
        parseProject,
        'project',
      ),
    MUTABLE_TTL_MS,
  ),
});
