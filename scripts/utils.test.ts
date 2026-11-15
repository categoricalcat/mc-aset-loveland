import { deepEqual, rejects, strictEqual } from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { memoizeWithResponseLog } from './utils.js';

const temporaryDirectory = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), 'mc-cache-test-'));

const DAY_MS = 24 * 60 * 60 * 1000;

void test('memoizes within one run and overwrites a stale entry', async () => {
  const directory = await temporaryDirectory();
  const logPath = path.join(directory, 'project.json');
  let calls = 0;
  try {
    await fs.writeFile(
      logPath,
      JSON.stringify({ fetchedAt: Date.now() - 2 * DAY_MS, value: 'stale' }),
    );
    const fetchValue = memoizeWithResponseLog(
      directory,
      () => 'project.json',
      () => {
        calls += 1;
        return Promise.resolve({ value: 'fresh' });
      },
      DAY_MS,
    );

    strictEqual((await fetchValue(undefined))?.value, 'fresh');
    strictEqual((await fetchValue(undefined))?.value, 'fresh');
    strictEqual(calls, 1);
    const written: unknown = JSON.parse(await fs.readFile(logPath, 'utf8'));
    deepEqual(
      typeof written === 'object' && written !== null && 'value' in written
        ? written.value
        : null,
      { value: 'fresh' },
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('serves a fresh disk entry without fetching', async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(
      path.join(directory, 'project.json'),
      JSON.stringify({ fetchedAt: Date.now(), value: { value: 'cached' } }),
    );
    const fetchValue = memoizeWithResponseLog<undefined, { value: string }>(
      directory,
      () => 'project.json',
      () => Promise.reject(new Error('must not fetch')),
      DAY_MS,
    );

    strictEqual((await fetchValue(undefined))?.value, 'cached');
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('serves a permanent entry regardless of age', async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(
      path.join(directory, 'version.json'),
      JSON.stringify({ fetchedAt: 0, value: { value: 'ancient' } }),
    );
    const fetchValue = memoizeWithResponseLog<undefined, { value: string }>(
      directory,
      () => 'version.json',
      () => Promise.reject(new Error('must not fetch')),
      null,
    );

    strictEqual((await fetchValue(undefined))?.value, 'ancient');
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('treats an unparseable entry as a miss', async () => {
  const directory = await temporaryDirectory();
  const logPath = path.join(directory, 'project.json');
  try {
    await fs.writeFile(logPath, '{"fetchedAt": 1');
    const fetchValue = memoizeWithResponseLog(
      directory,
      () => 'project.json',
      () => Promise.resolve({ value: 'fresh' }),
      null,
    );

    strictEqual((await fetchValue(undefined))?.value, 'fresh');
    const written: unknown = JSON.parse(await fs.readFile(logPath, 'utf8'));
    strictEqual(
      typeof written === 'object' && written !== null && 'value' in written,
      true,
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('persists nulls across runs with the entry ttl', async () => {
  for (const ttl of [DAY_MS, null]) {
    const directory = await temporaryDirectory();
    let calls = 0;
    try {
      const fetchValue = () =>
        memoizeWithResponseLog(
          directory,
          () => 'project.json',
          () => {
            calls += 1;
            return Promise.resolve(null);
          },
          ttl,
        )(undefined);

      strictEqual(await fetchValue(), null);
      strictEqual(await fetchValue(), null);
      strictEqual(calls, 1);
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  }
});

void test('evicts rejected lookups so subsequent calls retry cleanly', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  try {
    const fetchValue = memoizeWithResponseLog(
      directory,
      () => 'project.json',
      () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('transient HTTP 503'));
        return Promise.resolve({ value: 'recovered' });
      },
      null,
    );

    await rejects(fetchValue(undefined), /transient HTTP 503/);
    strictEqual((await fetchValue(undefined))?.value, 'recovered');
    strictEqual(calls, 2);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

void test('returns the response when logging it fails', async () => {
  const directory = await temporaryDirectory();
  const blocked = path.join(directory, 'blocked');
  try {
    await fs.writeFile(blocked, 'not a directory');
    const fetchValue = memoizeWithResponseLog(
      blocked,
      () => 'project.json',
      () => Promise.resolve({ value: 'fresh' }),
      null,
    );

    strictEqual((await fetchValue(undefined))?.value, 'fresh');
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
