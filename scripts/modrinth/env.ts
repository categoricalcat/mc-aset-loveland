import type { File } from './types.js';

import { config } from '../config.js';
import { getProject, parseProjectId } from './api.js';

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
    `Processing ${file.path} with project id ${projectId ?? 'missing'}`,
  );

  if (!projectId) return { file, project: 'no-id' };

  try {
    const project = await getProject(projectId);
    if (project === null) return { file, project: 'not-found' };
    return {
      file: {
        ...file,
        env: {
          client: project.client_side,
          server: project.server_side,
        },
      },
      project: 'found',
    };
  } catch (caught) {
    const status = caught instanceof Error ? caught.message : 'lookup failed';
    return { file, project: 'error', projectId, status };
  }
};

export const processAndLogFile = async (
  file: File,
  index: number,
  total: number,
): Promise<{ error: boolean; file: File }> => {
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
    console.log(
      `  Client-only ${file.path}: client=${client}, server=${server}`,
    );
    return { error, file: processed.file };
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

export const keptFiles = (
  processed: readonly { file: File | null }[],
): File[] =>
  processed
    .map(({ file }) => file)
    .filter((file): file is File => file !== null);

export const serverFiles = (files: readonly File[]): File[] =>
  files.filter(file => file.env.server !== 'unsupported');
