import { type ModrinthIndex, parseModrinthIndex } from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import { config } from './config.js';
import { extractZip, readJson, zipFolder } from './utils.js';

const failure = {
  processing: {
    fallback: 'modpack processing failed',
    label: 'Error processing modpack:',
  },
  updating: {
    fallback: 'modpack update failed',
    label: 'Error updating modpack:',
  },
} as const;

export const reportLookupErrors = (errorCount: number): void => {
  if (errorCount === 0) return;
  console.error(`\n${errorCount} Modrinth lookup error(s); see log above`);
  process.exitCode = 1;
};

export const runPack = async <R extends { index: ModrinthIndex }>(
  outZip: string,
  action: keyof typeof failure,
  transform: (index: ModrinthIndex) => Promise<R>,
): Promise<R | undefined> => {
  try {
    await extractZip(config.mrpackPath, config.backupDir);
    console.log(`Extracted ${config.mrpackPath} to ${config.backupDir}`);

    const indexPath = path.join(config.backupDir, config.indexPath);
    const index = parseModrinthIndex(await readJson(indexPath));
    if (index === null) throw new Error(`invalid index ${indexPath}`);

    const result = await transform(index);
    await fs.writeFile(indexPath, JSON.stringify(result.index));
    await zipFolder(config.backupDir, outZip);
    return result;
  } catch (caught) {
    console.error(
      failure[action].label,
      caught instanceof Error ? caught : new Error(failure[action].fallback),
    );
    process.exitCode = 1;
    return undefined;
  }
};
