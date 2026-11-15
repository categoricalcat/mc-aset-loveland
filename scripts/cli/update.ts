import { type ModrinthClient, resolvePackFiles } from '@modrinth';
import fs from 'fs/promises';

import type { PackPaths } from './pack.js';

import { latestLoaderVersion } from '../loaders.js';
import { runProcess } from './process.js';

export interface UpdateOptions {
  game: string;
  modrinth: ModrinthClient;
  paths: PackPaths;
  preserveOriginalRoots: boolean;
}

export const runUpdate = async ({
  game,
  modrinth,
  paths,
  preserveOriginalRoots,
}: UpdateOptions): Promise<void> => {
  await runProcess({
    label: 'update',
    modrinth,
    paths,
    resolve: async (index, loader) => {
      const loaderKey = loader === 'neoforge' ? 'neoforge' : 'fabric-loader';
      const loaderVersion = await latestLoaderVersion(loader, game);
      const { files, issues, resolved, unresolved } = await resolvePackFiles(
        index.files,
        game,
        loader,
        modrinth,
        preserveOriginalRoots,
      );
      const preserved = files.flatMap(item =>
        item.preserve && item.projectId !== null ? [item.file.path] : [],
      );
      return {
        createdNote: `, ${loaderKey} ${loaderVersion}`,
        dependencies: {
          ...index.dependencies,
          [loaderKey]: loaderVersion,
          minecraft: game,
        },
        extraErrors: issues,
        files,
        logs: [
          ...(unresolved.length > 0
            ? [`Removed (no ${game} ${loader} build): ${unresolved.join(', ')}`]
            : []),
          ...(preserved.length > 0
            ? [
                `Preserved at exported or pinned version: ${preserved.join(', ')}`,
              ]
            : []),
        ],
        resolved,
      };
    },
  });
  await fs.rm('bias-updated.mrpack', { force: true });
};
