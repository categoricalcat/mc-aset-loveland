import type { Env, File, ModrinthProject, ResolvedVersion } from '@modrinth';

import { deepEqual, rejects, strictEqual } from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { zipFolder } from '../utils.js';
import {
  assertNoConflicts,
  publishArchives,
  resolvePackPaths,
  runPackPipeline,
  writeErrorLog,
} from './pack.js';

const temporaryDirectory = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), 'mc-pack-test-'));

void test('resolves pack paths from a stem or an .mrpack path', () => {
  deepEqual(resolvePackPaths('packs/custom.mrpack', '/repo'), {
    cacheDir: '/repo/.backups/modrinth_cache',
    indexPath: '/repo/.backups/custom/modrinth.index.json',
    inputPath: 'packs/custom.mrpack',
    stem: 'custom',
    workDir: '/repo/.backups/custom',
  });
  deepEqual(resolvePackPaths('other', '/repo'), {
    cacheDir: '/repo/.backups/modrinth_cache',
    indexPath: '/repo/.backups/other/modrinth.index.json',
    inputPath: 'other.mrpack',
    stem: 'other',
    workDir: '/repo/.backups/other',
  });
});

void test('publishing restores both existing archives when a staged archive is missing', async () => {
  const directory = await temporaryDirectory();
  const client = path.join(directory, 'client.mrpack');
  const server = path.join(directory, 'server.mrpack');
  const stagedClient = path.join(directory, 'client.tmp');
  const stagedServer = path.join(directory, 'server.tmp');
  try {
    await Promise.all([
      fs.writeFile(client, 'old client'),
      fs.writeFile(server, 'old server'),
      fs.writeFile(stagedClient, 'new client'),
    ]);

    await rejects(
      publishArchives([
        { finalPath: client, stagedPath: stagedClient },
        { finalPath: server, stagedPath: stagedServer },
      ]),
      /ENOENT/,
    );

    strictEqual(await fs.readFile(client, 'utf8'), 'old client');
    strictEqual(await fs.readFile(server, 'utf8'), 'old server');
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('publishing replaces both archives after staging succeeds', async () => {
  const directory = await temporaryDirectory();
  const client = path.join(directory, 'client.mrpack');
  const server = path.join(directory, 'server.mrpack');
  const stagedClient = path.join(directory, 'client.tmp');
  const stagedServer = path.join(directory, 'server.tmp');
  try {
    await Promise.all([
      fs.writeFile(client, 'old client'),
      fs.writeFile(server, 'old server'),
      fs.writeFile(stagedClient, 'new client'),
      fs.writeFile(stagedServer, 'new server'),
    ]);

    await publishArchives([
      { finalPath: client, stagedPath: stagedClient },
      { finalPath: server, stagedPath: stagedServer },
    ]);

    strictEqual(await fs.readFile(client, 'utf8'), 'new client');
    strictEqual(await fs.readFile(server, 'utf8'), 'new server');
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

const appWithMissingDep: ResolvedVersion = {
  dependencies: [
    { dependency_type: 'required', project_id: 'lib', version_id: null },
  ],
  id: 'app-1',
  path: 'mods/app.jar',
  project_id: 'app',
};

const resolvedWithMissingDep = (): ReadonlyMap<string, ResolvedVersion> =>
  new Map([[appWithMissingDep.path, appWithMissingDep]]);

const project = (loaders: string[]): ModrinthProject => ({
  id: 'lib',
  loaders,
});

void test('assertNoConflicts keeps a missing dep fatal when the project lookup fails', async () => {
  await rejects(
    assertNoConflicts(
      resolvedWithMissingDep(),
      [],
      'fabric',
      () => Promise.reject(new Error('HTTP 503')),
      [],
    ),
    /mod conflicts/,
  );
});

void test('assertNoConflicts keeps a missing dep fatal when the project is unknown to Modrinth', async () => {
  await rejects(
    assertNoConflicts(
      resolvedWithMissingDep(),
      [],
      'fabric',
      () => Promise.resolve(null),
      [],
    ),
    /mod conflicts/,
  );
});

void test('assertNoConflicts keeps a missing dep fatal when the project builds for the loader', async () => {
  await rejects(
    assertNoConflicts(
      resolvedWithMissingDep(),
      [],
      'fabric',
      () => Promise.resolve(project(['fabric'])),
      [],
    ),
    /mod conflicts/,
  );
});

void test('assertNoConflicts downgrades a missing dep with no builds for the loader', async () => {
  const errors = await assertNoConflicts(
    resolvedWithMissingDep(),
    [],
    'fabric',
    () => Promise.resolve(project(['neoforge'])),
    [],
  );

  deepEqual(errors, []);
});

const envFile = (filePath: string, env: Env): File => ({
  downloads: [],
  env,
  fileSize: 1,
  hashes: { sha1: 'a', sha512: 'b' },
  path: filePath,
});

void test('assertNoConflicts warns when a dep is only shipped on the other side', async () => {
  const app = appWithMissingDep;
  const lib: ResolvedVersion = {
    dependencies: [],
    id: 'lib-1',
    path: 'mods/lib.jar',
    project_id: 'lib',
  };
  const resolved = new Map([
    [app.path, app],
    [lib.path, lib],
  ]);
  const files = [
    envFile(app.path, { client: 'required', server: 'required' }),
    envFile(lib.path, { client: 'unsupported', server: 'required' }),
  ];

  // lib is present in the pack but client-unsupported: the client side
  // warns instead of failing, because jar metadata proves such requirements
  // are often hints.
  deepEqual(
    await assertNoConflicts(
      resolved,
      [],
      'fabric',
      () => Promise.resolve(null),
      files,
    ),
    [],
  );

  // Absent from the entire pack: fatal on the side that needs it.
  const withoutLib = new Map([[app.path, app]]);
  await rejects(
    assertNoConflicts(
      withoutLib,
      [],
      'fabric',
      () => Promise.resolve(null),
      files,
    ),
    /mod conflicts/,
  );
});

void test('assertNoConflicts treats a version-only dep like a project dep across sides', async () => {
  const app: ResolvedVersion = {
    dependencies: [
      { dependency_type: 'required', project_id: null, version_id: 'lib-1' },
    ],
    id: 'app-1',
    path: 'mods/app.jar',
    project_id: 'app',
  };
  const lib: ResolvedVersion = {
    dependencies: [],
    id: 'lib-1',
    path: 'mods/lib.jar',
    project_id: 'lib',
  };
  const files = [
    envFile(app.path, { client: 'required', server: 'required' }),
    envFile(lib.path, { client: 'unsupported', server: 'required' }),
  ];
  const getProject = (): Promise<null> => Promise.resolve(null);

  deepEqual(
    await assertNoConflicts(
      new Map([
        [app.path, app],
        [lib.path, lib],
      ]),
      [],
      'fabric',
      getProject,
      files,
    ),
    [],
  );

  await rejects(
    assertNoConflicts(
      new Map([[app.path, app]]),
      [],
      'fabric',
      getProject,
      files,
    ),
    /mod conflicts/,
  );
});

void test('writeErrorLog writes entries and removes the log when there are none', async () => {
  const directory = await temporaryDirectory();
  const logPath = path.join(directory, 'errors.log');
  try {
    await writeErrorLog(logPath, ['first', 'second']);
    strictEqual(await fs.readFile(logPath, 'utf8'), 'first\nsecond\n');

    await writeErrorLog(logPath, []);
    await rejects(fs.access(logPath), /ENOENT/);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('runPackPipeline leaves existing archive untouched and cleans staged files on failure', async () => {
  const directory = await temporaryDirectory();
  const srcDir = path.join(directory, 'src');
  const workDir = path.join(directory, 'work');
  const inputPath = path.join(directory, 'pack.mrpack');
  const finalOut = path.join(directory, 'out.mrpack');
  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, 'modrinth.index.json'),
      JSON.stringify({
        dependencies: { 'fabric-loader': '0.16.0', minecraft: '26.3' },
        files: [],
        formatVersion: 1,
        game: 'minecraft',
        name: 'test-pack',
        versionId: '1.0.0',
      }),
    );
    await zipFolder(srcDir, inputPath);
    await fs.writeFile(finalOut, 'previous archive');

    await rejects(
      runPackPipeline(
        {
          cacheDir: path.join(directory, 'cache'),
          indexPath: path.join(workDir, 'modrinth.index.json'),
          inputPath,
          stem: 'pack',
          workDir,
        },
        async ({ index, stageArchive }) => {
          await stageArchive(finalOut, index);
          throw new Error('conflict check failed');
        },
      ),
      /conflict check failed/,
    );

    strictEqual(await fs.readFile(finalOut, 'utf8'), 'previous archive');
    const leftoverTmp = (await fs.readdir(directory)).filter(name =>
      name.endsWith('.tmp'),
    );
    strictEqual(leftoverTmp.length, 0);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
