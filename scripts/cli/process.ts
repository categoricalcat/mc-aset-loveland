import {
  type Dependencies,
  exportedResolvedVersions,
  type File,
  type ModrinthClient,
  type ModrinthIndex,
  type ResolvedVersion,
  serverFiles,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import type { Loader } from '../loaders.js';

import {
  assertNoConflicts,
  packLoader,
  type PackPaths,
  partitionOverrides,
  removeDuplicateJars,
  runPackPipeline,
  writeErrorLog,
} from './pack.js';

export interface ProcessOptions {
  label?: string;
  modrinth: ModrinthClient;
  paths: PackPaths;
  resolve?: (index: ModrinthIndex, loader: Loader) => Promise<ResolveStep>;
  writeIndex?: boolean;
}

// Update is process with this one extra step: resolve newer versions first.
export interface ResolveStep {
  createdNote?: string;
  dependencies: Dependencies;
  extraErrors: readonly string[];
  files: readonly File[];
  logs: readonly string[];
  resolved: ReadonlyMap<string, ResolvedVersion>;
}

const exportedStep = async (
  index: ModrinthIndex,
  fetchVersionById: ModrinthClient['fetchVersionById'],
): Promise<ResolveStep> => ({
  dependencies: index.dependencies,
  extraErrors: [],
  files: index.files,
  logs: [],
  resolved: await exportedResolvedVersions(index.files, fetchVersionById),
});

export const runProcess = async ({
  label = 'process',
  modrinth,
  paths,
  resolve,
  writeIndex = false,
}: ProcessOptions): Promise<void> => {
  const clientPackPath = `${paths.stem}-${label}-client.mrpack`;
  const serverPackPath = `${paths.stem}-${label}-server.mrpack`;
  const overrideModsDir = path.join(paths.workDir, 'overrides', 'mods');

  const outcome = await runPackPipeline(
    paths,
    async ({ index, stageArchive }) => {
      console.log(` Processing ${index.files.length} files from ${index.name}`);
      const loader = packLoader(index);
      const step =
        resolve === undefined
          ? await exportedStep(index, modrinth.fetchVersionById)
          : await resolve(index, loader);
      // Env is authoritative as exported: the pack author curates it, and
      // update carries it through resolution. Modrinth project env is not
      // consulted — overwriting curated env regresses working packs.
      const allFiles = [...step.files];
      const overrides = await partitionOverrides(
        allFiles,
        step.resolved,
        overrideModsDir,
        modrinth.fetchVersionsByHash,
      );
      const errors = await assertNoConflicts(
        step.resolved,
        overrides.kept,
        loader,
        modrinth.getProject,
        allFiles,
      );

      const updated: ModrinthIndex = {
        ...index,
        dependencies: step.dependencies,
        files: allFiles,
      };
      const serverUpdated: ModrinthIndex = {
        ...updated,
        files: serverFiles(allFiles),
      };

      // Client zip keeps overrides/mods (minus duplicates already in the index).
      // Server installers extract that directory, so it is removed before the server zip.
      await stageArchive(clientPackPath, updated, async () => {
        await removeDuplicateJars(overrides.duplicates);
        if (writeIndex) {
          await fs.writeFile(
            'index-copy.json',
            JSON.stringify(updated, null, 2),
          );
          console.log('Modified index written to index-copy.json');
        }
      });
      await stageArchive(serverPackPath, serverUpdated, async () => {
        await fs.rm(overrideModsDir, { force: true, recursive: true });
      });

      return {
        clientCount: updated.files.length,
        createdNote: step.createdNote ?? '',
        errors: [...step.extraErrors, ...errors],
        logs: step.logs,
        serverCount: serverUpdated.files.length,
      };
    },
  );

  await writeErrorLog('errors.log', outcome.errors);
  console.log(
    `Created ${clientPackPath} (${outcome.clientCount} files) and ${serverPackPath} (${outcome.serverCount} files)${outcome.createdNote}`,
  );
  for (const line of outcome.logs) console.log(line);
  if (outcome.errors.length > 0) {
    console.warn(`${outcome.errors.length} issue(s) written to errors.log`);
  }
};
