import {
  type File,
  type ModrinthIndex,
  parseModrinthIndex,
  processAndLogFile,
  resolvePackFiles,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import { config } from './config.js';
import { latestLoaderVersion, type Loader } from './loaders.js';
import { extractZip, readJson, zipFolder } from './utils.js';

const GAME = '26.3';

const run = async (): Promise<void> => {
  await extractZip(config.mrpackPath, config.backupDir);
  console.log(`Extracted ${config.mrpackPath} to ${config.backupDir}`);

  const indexPath = path.join(config.backupDir, config.indexPath);
  const index = parseModrinthIndex(await readJson(indexPath));
  if (index === null) throw new Error(`invalid index ${indexPath}`);
  // Pre-26.3 copies here would load alongside the resolved mods.
  await fs.rm(path.join(config.backupDir, 'overrides', 'mods'), {
    force: true,
    recursive: true,
  });

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

  const updatedIndex: ModrinthIndex = {
    ...index,
    dependencies: {
      ...index.dependencies,
      [loaderKey]: loaderVersion,
      minecraft: GAME,
    },
    files: processed
      .map(({ file }) => file)
      .filter((file): file is File => file !== null),
  };

  await fs.writeFile(indexPath, JSON.stringify(updatedIndex));
  const outPath = config.mrpackPath.replace(/\.mrpack$/, `-${GAME}.mrpack`);
  await zipFolder(config.backupDir, outPath);
  console.log(
    `Created updated pack at ${outPath} (${updatedIndex.files.length} mods, ${loaderKey} ${loaderVersion})`,
  );
  if (unresolved.length > 0) {
    console.log(
      `Removed (no ${GAME} ${loader} build): ${unresolved.join(', ')}`,
    );
  }

  const errorCount = processed.filter(({ error }) => error).length;
  if (errorCount > 0) {
    console.error(`\n${errorCount} Modrinth lookup error(s); see log above`);
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (caught) {
  console.error(
    'Error updating modpack:',
    caught instanceof Error ? caught : new Error('modpack update failed'),
  );
  process.exitCode = 1;
}
