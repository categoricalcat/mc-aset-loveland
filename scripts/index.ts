import {
  keptFiles,
  type ModrinthIndex,
  processAndLogFile,
  serverFiles,
} from '@modrinth';
import fs from 'fs/promises';

import { config } from './config.js';
import { reportLookupErrors, runPack } from './pack.js';

const outcome = await runPack(
  config.processedPackPath,
  'processing',
  async index => {
    console.log(` Processing ${index.files.length} files from ${index.name}`);

    // Must stay sequential: fetchProject throttling assumes one request in flight.
    const processed = await Array.fromAsync(index.files, (file, i) =>
      processAndLogFile(file, i, index.files.length),
    );

    const updated: ModrinthIndex = {
      ...index,
      files: serverFiles(keptFiles(processed)),
    };

    await fs.writeFile(config.outputPath, JSON.stringify(updated, null, 2));
    console.log(
      `\nProcessing complete! Modified index written to ${config.outputPath}`,
    );

    return {
      errors: processed.filter(({ error }) => error).length,
      index: updated,
    };
  },
);

if (outcome !== undefined) {
  console.log(`Created processed pack at ${config.processedPackPath}`);
  reportLookupErrors(outcome.errors);
}
