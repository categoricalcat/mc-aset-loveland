import {
  keptFiles,
  type ModrinthIndex,
  processAndLogFile,
  resolvePackFiles,
  serverFiles,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import { config } from './config.js';
import { latestLoaderVersion, type Loader } from './loaders.js';
import { reportLookupErrors, runPack } from './pack.js';
import { zipFolder } from './utils.js';

const GAME = '26.3';
const packStem = path.basename(config.mrpackPath, '.mrpack');
const serverPackPath = `${packStem}-update-server.mrpack`;
const clientPackPath = `${packStem}-update-client.mrpack`;

const outcome = await runPack(serverPackPath, 'updating', async index => {
  const loader: Loader =
    index.dependencies.neoforge === undefined ? 'fabric' : 'neoforge';
  const loaderKey = loader === 'neoforge' ? 'neoforge' : 'fabric-loader';
  const loaderVersion = await latestLoaderVersion(loader, GAME);
  const { files, unresolved } = await resolvePackFiles(
    index.files,
    GAME,
    loader,
  );

  const processed = await Array.fromAsync(files, (file, i) =>
    processAndLogFile(file, i, files.length),
  );
  const allFiles = keptFiles(processed);
  // A required dep can be the updated copy of a jar Prism left in overrides/mods.
  const modSlug = (filename: string): string =>
    path
      .basename(filename, '.jar')
      .toLowerCase()
      .split(/[-+_](?=\d|mc\d|v\d|fabric|neoforge|forge|quilt)/)[0] ?? '';
  const indexed = new Set(
    allFiles
      .filter(file => file.path.startsWith('mods/'))
      .map(file => modSlug(file.path)),
  );
  const overrideMods = path.join(config.backupDir, 'overrides', 'mods');
  const overrideJars = await fs
    .readdir(overrideMods)
    .catch((caught: unknown) => {
      if (
        caught instanceof Error &&
        'code' in caught &&
        caught.code === 'ENOENT'
      ) {
        return [];
      }
      throw caught;
    });
  const duplicateOverrides = overrideJars.filter(name =>
    indexed.has(modSlug(name)),
  );
  await Promise.all(
    duplicateOverrides.map(name => fs.rm(path.join(overrideMods, name))),
  );
  if (duplicateOverrides.length > 0) {
    console.log(
      `Removed override jars already in the index: ${duplicateOverrides.join(', ')}`,
    );
  }

  const updated = {
    ...index,
    dependencies: {
      ...index.dependencies,
      [loaderKey]: loaderVersion,
      minecraft: GAME,
    },
    files: allFiles,
  } satisfies ModrinthIndex;

  // Client zip still has overrides/mods. Server installers extract that
  // directory, so it is removed before the server zip.
  const indexPath = path.join(config.backupDir, config.indexPath);
  await fs.writeFile(indexPath, JSON.stringify(updated));
  await zipFolder(config.backupDir, clientPackPath);
  await fs.rm(path.join(config.backupDir, 'overrides', 'mods'), {
    force: true,
    recursive: true,
  });

  return {
    clientCount: allFiles.length,
    errors: processed.filter(({ error }) => error).length,
    index: {
      ...updated,
      files: serverFiles(allFiles),
    } satisfies ModrinthIndex,
    loader,
    loaderKey,
    loaderVersion,
    unresolved,
  };
});

if (outcome !== undefined) {
  await fs.rm('bias-updated.mrpack', { force: true });
  console.log(
    `Created ${clientPackPath} (${outcome.clientCount} files) and ${serverPackPath} (${outcome.index.files.length} files), ${outcome.loaderKey} ${outcome.loaderVersion}`,
  );
  if (outcome.unresolved.length > 0) {
    console.log(
      `Removed (no ${GAME} ${outcome.loader} build): ${outcome.unresolved.join(', ')}`,
    );
  }
  reportLookupErrors(outcome.errors);
}
