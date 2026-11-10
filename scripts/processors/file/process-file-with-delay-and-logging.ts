import type { File } from '../../../types/modrinth.js';

import { parseProjectId } from '../../api/modrinth/index.js';
import { delay } from '../../utils/async/index.js';
import { shouldProcessFile } from '../../utils/file/index.js';
import { processFile } from './process-file.js';

/**
 * Processes a file with rate limiting delay and detailed logging
 * @param file - The file to process
 * @param index - The current index in the processing queue
 * @param total - The total number of files being processed
 * @returns Promise resolving to the processed file, or null if the file should be skipped
 */
export const processFileWithDelayAndLogging = async (
  file: File,
  index: number,
  total: number,
): Promise<File | null> => {
  console.log(`Processing ${index + 1}/${total}: ${file.path}`);

  const processedFile = await processFile(file);

  if (!shouldProcessFile(processedFile)) {
    console.log(`Skipping ${file.path}`);
    return null;
  } else await delay(1000 / 30); // Rate limiting

  // Log results
  if (JSON.stringify(processedFile.env) !== JSON.stringify(file.env)) {
    console.log(
      `  Updated env for ${file.path}: client=${processedFile.env.client}, server=${processedFile.env.server}`,
    );
  } else if (file.downloads[0]) {
    const firstDownload = file.downloads[0];
    const projectId = parseProjectId(firstDownload);
    console.log(
      projectId
        ? `  Failed to fetch project info for ${file.path}`
        : `  Could not extract project ID from ${firstDownload}`,
      file.downloads,
      processedFile.env,
      file.env,
    );
  } else {
    console.log(`  No downloads found for ${file.path}`);
  }

  return processedFile;
};
