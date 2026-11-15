import { createModrinthClient } from '@modrinth';

import { CLI_USAGE, parseCli, UsageError } from './args.js';
import { resolvePackPaths } from './pack.js';
import { runProcess } from './process.js';
import { runUpdate } from './update.js';

const runCli = async (argv: readonly string[]): Promise<void> => {
  const parsed = parseCli(argv);
  if (parsed.command === 'help') {
    console.log(CLI_USAGE);
    return;
  }

  const paths = resolvePackPaths(parsed.pack);
  const modrinth = createModrinthClient(paths.cacheDir);

  if (parsed.command === 'process') {
    await runProcess({
      modrinth,
      modsOnly: parsed.modsOnly,
      paths,
      writeIndex: parsed.writeIndex,
    });
    return;
  }

  await runUpdate({
    game: parsed.game,
    modrinth,
    paths,
    preserveOriginalRoots: parsed.preserveOriginalRoots,
  });
};

runCli(process.argv.slice(2)).catch((caught: unknown) => {
  console.error(caught instanceof UsageError ? caught.message : caught);
  process.exitCode = 1;
});
