import fs from 'fs/promises';
import path from 'path';

import type { File, ModrinthIndex } from '../types/modrinth.js';

import { config } from './config.js';
import { processAndLogFile } from './modrinth.js';
import { extractZip, readJson, toError, zipFolder } from './utils.js';

const run = async (): Promise<void> => {
  await extractZip(config.mrpackPath, config.backupDir);
  console.log(`Extracted ${config.mrpackPath} to ${config.backupDir}`);

  const indexPath = path.join(config.backupDir, config.indexPath);
  const index = (await readJson(indexPath)) as ModrinthIndex;
  console.log(` Processing ${index.files.length} files from ${index.name}`);

  // Must stay sequential: fetchProject throttling assumes one request in flight.
  const processed = await Array.fromAsync(index.files, (file, i) =>
    processAndLogFile(file, i, index.files.length),
  );

  const updatedIndex: ModrinthIndex = {
    ...index,
    files: processed
      .map(({ file }) => file)
      .filter((file): file is File => file !== null),
  };

  await Promise.all([
    fs.writeFile(config.outputPath, JSON.stringify(updatedIndex, null, 2)),
    fs.writeFile(indexPath, JSON.stringify(updatedIndex)),
  ]);

  console.log(
    `\nProcessing complete! Modified index written to ${config.outputPath}`,
  );

  await zipFolder(config.backupDir, config.processedPackPath);
  console.log(`Created processed pack at ${config.processedPackPath}`);

  const errorCount = processed.filter(({ error }) => error).length;
  if (errorCount > 0) {
    console.error(`\n${errorCount} Modrinth lookup error(s); see log above`);
    process.exitCode = 1;
  }
};

void run().catch((e: unknown) => {
  console.error('Error processing modpack:', toError(e));
  process.exitCode = 1;
});
