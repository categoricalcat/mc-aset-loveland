import type { Env, EnvTarget, File, ModrinthProject } from './types.js';

type ProcessedFile =
  | { file: File; project: 'error'; projectId: string; status: string }
  | { file: File; project: 'found' | 'no-id' | 'not-found' | 'skipped' };

type ProjectLookup = (projectId: string) => Promise<ModrinthProject | null>;

const keptReasons: Record<
  Exclude<ProcessedFile['project'], 'found'>,
  (server: Env['server']) => string
> = {
  error: server => `lookup failed, server=${server}`,
  'no-id': () => 'no project id in download URL',
  'not-found': server => `Modrinth project not found, server=${server}`,
  skipped: () => 'outside mods/, lookup skipped',
};

/**
 * A failed or empty lookup leaves the file unchanged so the caller can keep it.
 */
const processFile = async (
  { file, projectId }: EnvTarget,
  getProject: ProjectLookup,
  modsOnly: boolean,
): Promise<ProcessedFile> => {
  if (modsOnly && !file.path.startsWith('mods/')) {
    return { file, project: 'skipped' };
  }

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
  target: EnvTarget,
  index: number,
  total: number,
  getProject: ProjectLookup,
  modsOnly: boolean,
): Promise<{ error: boolean; file: File }> => {
  const { file } = target;
  console.log(`Processing ${index + 1}/${total}: ${file.path}`);

  const processed = await processFile(target, getProject, modsOnly);
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
  } else if (processed.project !== 'found') {
    console.log(
      `  Kept ${file.path}: ${keptReasons[processed.project](server)}`,
    );
  } else if (client !== file.env.client || server !== file.env.server) {
    console.log(
      `  Updated env for ${file.path}: client=${client}, server=${server}`,
    );
  } else {
    console.log(`  Unchanged ${file.path}: client=${client}, server=${server}`);
  }

  return { error, file: processed.file };
};

export const serverFiles = (files: readonly File[]): File[] =>
  files.filter(file => file.env.server !== 'unsupported');
