import type { ResolvedPackFile } from '@modrinth';

import { deepEqual, rejects, strictEqual } from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { zipFolder } from '../utils.js';
import {
  publishArchives,
  refreshPackEnv,
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

const modTarget = (preserve: boolean): ResolvedPackFile => ({
  file: {
    downloads: ['https://cdn.modrinth.com/data/projA/versions/ver1/mod.jar'],
    env: { client: 'required', server: 'required' },
    fileSize: 10,
    hashes: { sha1: 'a', sha512: 'b' },
    path: 'mods/mod.jar',
  },
  preserve,
  projectId: 'projA',
});

void test('refreshPackEnv throws when a Modrinth lookup errors', async () => {
  await rejects(
    refreshPackEnv([modTarget(false)], () =>
      Promise.reject(new Error('HTTP 503')),
    ),
    /1 Modrinth lookup error/,
  );
});

void test('refreshPackEnv looks up env for preserved entries too', async () => {
  const [file] = await refreshPackEnv([modTarget(true)], () =>
    Promise.resolve({
      client_side: 'required',
      id: 'projA',
      server_side: 'unsupported',
    }),
  );

  deepEqual(file?.env, { client: 'required', server: 'unsupported' });
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
