import { join } from 'path';

import type {
  Dependencies,
  Env,
  File,
  ModrinthIndex,
  ModrinthProject,
  ModrinthVersion,
  VersionDependency,
  VersionFile,
} from './types.js';

import { config } from '../config.js';
import { request } from '../http.js';
import { isJsonObject, isStringArray, type Json, parseJson } from '../json.js';
import { delay, retryAfterSeconds, withFileCache } from '../utils.js';

// 300/min from X-Ratelimit-Limit. 80% is 240/min, one request every 250ms.
const RATE_WINDOW_S = 60;
const REQUEST_INTERVAL_MS = (RATE_WINDOW_S * 1000) / (300 * 0.8);

export const parseProjectId = (url: string): null | string =>
  url.split('/')[4] ?? null;

const side = (value: Json | undefined): Env['client'] =>
  value === 'optional' || value === 'required' || value === 'unsupported'
    ? value
    : 'optional';

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

const parseVersionDependency = (body: Json): null | VersionDependency => {
  if (!isJsonObject(body) || typeof body['dependency_type'] !== 'string') {
    return null;
  }
  const projectId = body['project_id'];
  if (typeof projectId !== 'string' && projectId !== null) return null;
  return { dependency_type: body['dependency_type'], project_id: projectId };
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
  const parsedFiles: VersionFile[] = [];
  for (const file of files) {
    const parsed = parseVersionFile(file);
    if (parsed === null) return null;
    parsedFiles.push(parsed);
  }
  const parsedDependencies: VersionDependency[] = [];
  for (const dependency of dependencies) {
    const parsed = parseVersionDependency(dependency);
    if (parsed === null) return null;
    parsedDependencies.push(parsed);
  }
  return {
    date_published: datePublished,
    dependencies: parsedDependencies,
    files: parsedFiles,
    game_versions: gameVersions,
    id,
    loaders,
    project_id: projectId,
    version_number: versionNumber,
    version_type: versionType,
  };
};

const parseVersionList = (body: Json): ModrinthVersion[] | null => {
  if (!Array.isArray(body)) return null;
  const versions: ModrinthVersion[] = [];
  for (const entry of body) {
    const parsed = parseVersion(entry);
    if (parsed === null) return null;
    versions.push(parsed);
  }
  return versions;
};

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
  if (parsedDependencies === null) return null;
  const parsedFiles: File[] = [];
  for (const file of files) {
    const parsed = parseFile(file);
    if (parsed === null) return null;
    parsedFiles.push(parsed);
  }
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
const modrinthFetch = async (url: string, retry = true): Promise<Response> => {
  const res = await request(url);
  if (res.status === 429 && retry) {
    const retryAfter = retryAfterSeconds(
      res.headers.get('Retry-After'),
      RATE_WINDOW_S,
    );
    console.warn(`  Rate limited, retrying in ${retryAfter}s`);
    await res.body?.cancel();
    await delay(retryAfter * 1000);
    return modrinthFetch(url, false);
  }
  await delay(REQUEST_INTERVAL_MS);
  return res;
};

const fetchProject = async (
  projectId: string,
): Promise<ModrinthProject | null> => {
  const res = await modrinthFetch(
    `https://api.modrinth.com/v2/project/${projectId}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const project = parseProject(parseJson(await res.text()));
  if (project === null) throw new Error('invalid project payload');
  return project;
};

export interface VersionQuery {
  game: string;
  loaders: readonly string[];
  projectId: string;
}

const fetchVersions = async (
  query: VersionQuery,
): Promise<ModrinthVersion[]> => {
  const params = new URLSearchParams({
    game_versions: JSON.stringify([query.game]),
  });
  if (query.loaders.length > 0) {
    params.set('loaders', JSON.stringify(query.loaders));
  }
  const res = await modrinthFetch(
    `https://api.modrinth.com/v2/project/${query.projectId}/version?${params.toString()}`,
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const versions = parseVersionList(parseJson(await res.text()));
  if (versions === null) throw new Error('invalid version payload');
  return versions;
};

const cacheDir = join(process.cwd(), config.cacheDir);

export const getProject = withFileCache(
  cacheDir,
  (id: string) => `${id}.json`,
  fetchProject,
  parseProject,
);

export const fetchProjectVersions = withFileCache(
  cacheDir,
  (query: VersionQuery) =>
    `versions-${query.projectId}-${query.game}-${query.loaders.length > 0 ? query.loaders.join('+') : 'all'}.json`,
  fetchVersions,
  parseVersionList,
);

const newestRelease = (
  versions: readonly ModrinthVersion[],
): ModrinthVersion | undefined => {
  const newest = [...versions].sort((a, b) =>
    b.date_published.localeCompare(a.date_published),
  );
  return (
    newest.find(version => version.version_type === 'release') ?? newest[0]
  );
};

const indexFile = (
  version: ModrinthVersion,
  versionFile: VersionFile,
  base: File | null,
  dir: string,
): { file: File; requiredProjectIds: string[] } => ({
  file: {
    downloads: [versionFile.url],
    env: base?.env ?? { client: 'required', server: 'required' },
    fileSize: versionFile.size,
    hashes: versionFile.hashes,
    path: `${dir}${versionFile.filename}`,
  },
  requiredProjectIds: version.dependencies.flatMap(dep =>
    dep.dependency_type === 'required' && dep.project_id !== null
      ? [dep.project_id]
      : [],
  ),
});

const resolveProject = async (
  projectId: string,
  game: string,
  loader: string,
  base: File | null,
): Promise<null | { file: File; requiredProjectIds: string[] }> => {
  const versions =
    (await fetchProjectVersions({
      game,
      loaders: [loader],
      projectId,
    })) ?? [];
  const version = newestRelease(versions);
  const versionFile =
    version?.files.find(file => file.primary) ?? version?.files[0];
  if (!version || !versionFile) return null;
  const dir =
    base === null
      ? 'mods/'
      : base.path.slice(0, base.path.lastIndexOf('/') + 1);
  return indexFile(version, versionFile, base, dir);
};

/**
 * Replaces each index file with its latest build and appends required deps.
 * Callers stay sequential: version fetches share one in-flight request.
 */
export const resolvePackFiles = async (
  files: readonly File[],
  game: string,
  loader: string,
): Promise<{ files: File[]; unresolved: string[] }> => {
  const resolved: File[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const pending: { base: File | null; projectId: string }[] = [];

  for (const file of files) {
    const projectId = file.downloads[0]
      ? parseProjectId(file.downloads[0])
      : null;
    if (projectId === null) {
      unresolved.push(file.path);
      continue;
    }
    seen.add(projectId);
    pending.push({ base: file, projectId });
  }

  for (const item of pending) {
    const result = await resolveProject(
      item.projectId,
      game,
      loader,
      item.base,
    );
    if (result === null) {
      // Resource packs and shader packs are not loader mods. A miss there
      // keeps the exported file; a mod with no 26.3 build is dropped.
      if (item.base !== null && !item.base.path.startsWith('mods/')) {
        resolved.push(item.base);
        continue;
      }
      unresolved.push(item.base?.path ?? item.projectId);
      continue;
    }
    resolved.push(result.file);
    for (const projectId of result.requiredProjectIds) {
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      pending.push({ base: null, projectId });
    }
  }

  return { files: resolved, unresolved };
};
