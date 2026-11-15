import { deepEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';

import { CLI_USAGE, DEFAULT_GAME, parseCli, UsageError } from './args.js';

void test('parses subcommands, flags, option terminators, and pack paths', () => {
  deepEqual(parseCli(['update']), {
    command: 'update',
    game: DEFAULT_GAME,
    pack: 'bias',
    preserveOriginalRoots: false,
  });
  deepEqual(
    parseCli(['update', '--preserve', '--game', '26.4', '--', 'other']),
    {
      command: 'update',
      game: '26.4',
      pack: 'other',
      preserveOriginalRoots: true,
    },
  );
  deepEqual(parseCli(['process']), {
    command: 'process',
    modsOnly: false,
    pack: 'bias',
    writeIndex: false,
  });
  deepEqual(
    parseCli([
      'process',
      '--mods-only',
      '--write-index',
      'packs/custom.mrpack',
    ]),
    {
      command: 'process',
      modsOnly: true,
      pack: 'packs/custom.mrpack',
      writeIndex: true,
    },
  );
  deepEqual(parseCli(['--help']), { command: 'help' });
  deepEqual(parseCli(['--', '--help']), { command: 'help' });
  deepEqual(parseCli(['--', 'update', '--preserve', 'other']), {
    command: 'update',
    game: DEFAULT_GAME,
    pack: 'other',
    preserveOriginalRoots: true,
  });
  deepEqual(parseCli(['update', '-h']), { command: 'help' });
});

void test('rejects invalid invocations with a usage error', () => {
  const usagePattern = new RegExp(
    CLI_USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  for (const invalid of [
    [],
    ['unknown'],
    ['toString'],
    ['update', '--mods-only'],
    ['update', '--game', ''],
    ['process', '--preserve'],
    ['update', 'one', 'two'],
    ['process', ''],
  ]) {
    throws(
      () => parseCli(invalid),
      (caught: unknown) =>
        caught instanceof UsageError && usagePattern.test(caught.message),
    );
  }
  throws(() => parseCli(['update', '--mods-only']), /--mods-only/);
  throws(() => parseCli(['unknown']), /unknown command unknown/);
});
