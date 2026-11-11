import { join } from 'path';

import type { File } from '../../../types/modrinth.js';

import { fetchProject, parseProjectId } from '../../api/modrinth/index.js';
import { config } from '../../config.js';
import { withFileCache } from '../../utils/cache/index.js';
import { createUpdatedFile } from './create-updated-file.js';

// Create cached version of fetchProject
const cacheDir = join(process.cwd(), config.cacheDir);
const cachedFetchProject = withFileCache(
  cacheDir,
  (id: string) => `${id}.json`,
  fetchProject,
);

/**
 * Loads Modrinth client/server sides onto a file.
 * A missing project leaves the file unchanged so the caller can keep it.
 */
export const processFile = async (
  file: File,
): Promise<{ file: File; project: 'found' | 'missing' | 'no-id' }> => {
  const firstDownload = file.downloads[0];
  const projectId = firstDownload ? parseProjectId(firstDownload) : null;

  console.log(
    `Processing ${file.path} with project id ${projectId ?? 'unknown'}`,
  );

  if (!projectId) return { file, project: 'no-id' };

  const project = await cachedFetchProject(projectId);
  if (!project) return { file, project: 'missing' };

  return { file: createUpdatedFile(file, project), project: 'found' };
};
