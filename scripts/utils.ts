import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import { dirname, join } from 'path';

import { isJsonObject, type Json, parseJson } from './json.js';

export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export const readJson = async (path: string): Promise<Json> =>
  parseJson(await fs.readFile(path, 'utf8'));

export const isMissing = (caught: unknown): boolean =>
  caught instanceof Error && 'code' in caught && caught.code === 'ENOENT';

// Capped so a bogus Retry-After cannot stall the run.
export const retryAfterSeconds = (
  header: null | string,
  maxSeconds: number,
): number => {
  if (header === null) return 1;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(asSeconds, maxSeconds);
  }
  const until = Date.parse(header);
  if (Number.isNaN(until)) return 1;
  return Math.min(maxSeconds, Math.max(0, (until - Date.now()) / 1000));
};

// ttlMs null means the entry never expires; anything unparseable is a miss.
export const readCacheEntry = async <Res>(
  filePath: string,
  ttlMs: null | number,
): Promise<Res | undefined> => {
  let entry: Json;
  try {
    entry = parseJson(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (
    !isJsonObject(entry) ||
    typeof entry['fetchedAt'] !== 'number' ||
    !('value' in entry) ||
    (ttlMs !== null && Date.now() - entry['fetchedAt'] >= ttlMs)
  ) {
    return undefined;
  }
  return entry['value'] as Res;
};

// A cache that cannot be written must not fail the lookup that produced it.
export const writeCacheEntry = (
  filePath: string,
  value: unknown,
): Promise<void> =>
  fs
    .mkdir(dirname(filePath), { recursive: true })
    .then(() =>
      fs.writeFile(
        filePath,
        JSON.stringify({ fetchedAt: Date.now(), value }),
        'utf8',
      ),
    )
    .catch((caught: unknown) => {
      console.warn(`Unable to log ${filePath}: ${String(caught)}`);
    });

// Nulls (404s) are memoized for the run but never persisted to disk.
export const memoizeWithResponseLog = <Arg, Res>(
  logDir: string,
  logName: (arg: Arg) => string,
  fn: (arg: Arg) => Promise<null | Res>,
  ttlMs: null | number,
): ((arg: Arg) => Promise<null | Res>) => {
  const memo = new Map<string, Promise<null | Res>>();
  return (arg: Arg): Promise<null | Res> => {
    const key = logName(arg);
    const current = memo.get(key);
    if (current !== undefined) return current;
    const filePath = join(logDir, key);
    const result = readCacheEntry<Res>(filePath, ttlMs)
      .then(async hit => {
        if (hit !== undefined) return hit;
        console.log(`Fetching ${filePath} from API`);
        const res = await fn(arg);
        if (res === null) return null;
        await writeCacheEntry(filePath, res);
        return res;
      })
      .catch((caught: unknown) => {
        memo.delete(key);
        throw caught;
      });
    memo.set(key, result);
    return result;
  };
};

export const extractZip = async (
  zipPath: string,
  outputDir: string,
): Promise<void> => {
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(outputDir, true);
};

export const sha1File = async (path: string): Promise<string> =>
  createHash('sha1')
    .update(await fs.readFile(path))
    .digest('hex');

export const readZipText = (zipPath: string, entry: string): null | string =>
  new AdmZip(zipPath).getEntry(entry)?.getData().toString('utf8') ?? null;

export const zipFolder = (folder: string, outZip: string): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(folder);
      zip.writeZip(outZip, err => {
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('zip failed'));
    }
  });
