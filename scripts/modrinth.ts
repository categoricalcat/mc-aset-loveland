import { join } from 'path';

import type { File, ModrinthProject } from '../types/modrinth.js';

import { config } from './config.js';
import { delay, retryAfterSeconds, toError, withFileCache } from './utils.js';

// 300/min from X-Ratelimit-Limit. 80% is 240/min, one request every 250ms.
const RATE_WINDOW_S = 60;
const REQUEST_INTERVAL_MS = (RATE_WINDOW_S * 1000) / (300 * 0.8);

const parseProjectId = (url: string): null | string =>
  url.split('/')[4] ?? null;

const isModrinthProject = (body: unknown): body is ModrinthProject =>
  typeof body === 'object' &&
  body !== null &&
  'id' in body &&
  'client_side' in body &&
  'server_side' in body;

// Runs only on a cache miss; the caller is already sequential.
const fetchProject = async (
  projectId: string,
  retry = true,
): Promise<ModrinthProject | null> => {
  const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}`);
  await delay(REQUEST_INTERVAL_MS);

  if (res.status === 429 && retry) {
    const retryAfter = retryAfterSeconds(
      res.headers.get('Retry-After'),
      RATE_WINDOW_S,
    );
    console.warn(`  Rate limited on ${projectId}, retrying in ${retryAfter}s`);
    await delay(retryAfter * 1000);
    return fetchProject(projectId, false);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body: unknown = await res.json();
  if (!isModrinthProject(body)) throw new Error('invalid project payload');
  return body;
};

const cachedFetchProject = withFileCache(
  join(process.cwd(), config.cacheDir),
  (id: string) => `${id}.json`,
  fetchProject,
  isModrinthProject,
);

type ProcessedFile =
  | { file: File; project: 'error'; projectId: string; status: string }
  | { file: File; project: 'found' | 'no-id' | 'not-found' | 'skipped' };

/**
 * A failed or empty lookup leaves the file unchanged so the caller can keep it.
 */
const processFile = async (file: File): Promise<ProcessedFile> => {
  if (config.modsOnly && !file.path.startsWith('mods/')) {
    return { file, project: 'skipped' };
  }

  const projectId = file.downloads[0]
    ? parseProjectId(file.downloads[0])
    : null;

  console.log(
    `Processing ${file.path} with project id ${projectId ?? 'unknown'}`,
  );

  if (!projectId) return { file, project: 'no-id' };

  try {
    const project = await cachedFetchProject(projectId);
    if (project === null) return { file, project: 'not-found' };
    return {
      file: {
        ...file,
        env: { client: project.client_side, server: project.server_side },
      },
      project: 'found',
    };
  } catch (e) {
    return { file, project: 'error', projectId, status: toError(e).message };
  }
};

export const processAndLogFile = async (
  file: File,
  index: number,
  total: number,
): Promise<{ error: boolean; file: File | null }> => {
  console.log(`Processing ${index + 1}/${total}: ${file.path}`);

  const processed = await processFile(file);
  const error = processed.project === 'error';

  if (processed.project === 'error') {
    console.error(
      `  Lookup error on ${file.path} (${processed.status}), project ${processed.projectId}`,
    );
  }

  const { client, server } = processed.file.env;
  if (server === 'unsupported') {
    console.log(`  Dropping ${file.path}: server=${server}`);
    return { error, file: null };
  }

  if (processed.project === 'error') {
    console.log(`  Kept ${file.path}: lookup failed, server=${server}`);
  } else if (processed.project === 'skipped') {
    console.log(`  Kept ${file.path}: outside mods/, lookup skipped`);
  } else if (processed.project === 'not-found') {
    console.log(
      `  Kept ${file.path}: Modrinth project not found, server=${server}`,
    );
  } else if (processed.project === 'no-id') {
    console.log(`  Kept ${file.path}: no project id in download URL`);
  } else if (client !== file.env.client || server !== file.env.server) {
    console.log(
      `  Updated env for ${file.path}: client=${client}, server=${server}`,
    );
  } else {
    console.log(`  Unchanged ${file.path}: client=${client}, server=${server}`);
  }

  return { error, file: processed.file };
};
