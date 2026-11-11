import {
  type File,
  type ModrinthIndex,
  parseModrinthIndex,
  processAndLogFile,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import { config } from './config.js';
import { extractZip, readJson, zipFolder } from './utils.js';

const run = async (): Promise<void> => {
  await extractZip(config.mrpackPath, config.backupDir);
  console.log(`Extracted ${config.mrpackPath} to ${config.backupDir}`);

  const indexPath = path.join(config.backupDir, config.indexPath);
  const index = parseModrinthIndex(await readJson(indexPath));
  if (index === null) throw new Error(`invalid index ${indexPath}`);
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

try {
  await run();
} catch (caught) {
  console.error(
    'Error processing modpack:',
    caught instanceof Error ? caught : new Error('modpack processing failed'),
  );
  process.exitCode = 1;
}
