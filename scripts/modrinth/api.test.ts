import { mkdtemp, rm } from 'fs/promises';
import { deepEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'os';
import { join } from 'path';

import { createModrinthClient } from './index.js';

void test('fetchVersionsByHash caches misses without re-requesting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hash-cache-'));
  const client = createModrinthClient(dir);
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = () => {
    posts += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    deepEqual([...(await client.fetchVersionsByHash(['gone-hash']))], []);
    strictEqual(posts, 1);
    deepEqual([...(await client.fetchVersionsByHash(['gone-hash']))], []);
    strictEqual(posts, 1);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { force: true, recursive: true });
  }
});
