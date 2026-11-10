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
 * Processes a single file by fetching project information and updating its environment configuration
 * @param file - The file to process
 * @returns Promise resolving to the processed file with updated environment info, or the original file if processing fails
 */
export const processFile = async (file: File): Promise<File> => {
  const firstDownload = file.downloads[0];
  const projectId = firstDownload ? parseProjectId(firstDownload) : null;

  console.log(
    `Processing ${file.path} with project id ${projectId ?? 'unknown'}`,
  );

  if (!projectId) return file;

  const project = await cachedFetchProject(projectId);
  const updatedFile = project ? createUpdatedFile(file, project) : file;

  return updatedFile;
};
