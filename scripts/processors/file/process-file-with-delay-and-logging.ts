import type { File } from '../../../types/modrinth.js';

import { delay } from '../../utils/async/index.js';
import { shouldProcessFile } from '../../utils/file/index.js';
import { processFile } from './process-file.js';

/**
 * Updates env from Modrinth, then drops the file only when the server cannot load it.
 * @param file - The file to process
 * @param index - The current index in the processing queue
 * @param total - The total number of files being processed
 * @returns The kept file, or null when server support is unsupported
 */
export const processFileWithDelayAndLogging = async (
  file: File,
  index: number,
  total: number,
): Promise<File | null> => {
  console.log(`Processing ${index + 1}/${total}: ${file.path}`);

  const processed = await processFile(file);

  if (!shouldProcessFile(processed.file)) {
    console.log(`  Dropping ${file.path}: server=${processed.file.env.server}`);
    return null;
  }

  await delay(1000 / 30);

  const { client, server } = processed.file.env;
  if (processed.project === 'missing') {
    console.log(
      `  Kept ${file.path}: Modrinth project missing, server=${server}`,
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

  return processed.file;
};
