import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';

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

// Nulls (404s) are persisted like hits: a 404 is deterministic per resource,
// so re-asking every run wastes a request. Mutable TTLs bound how long a
// deletion is believed; immutable endpoints believe it forever.
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
    const result = readCacheEntry<null | Res>(filePath, ttlMs)
      .then(async hit => {
        if (hit !== undefined) return hit;
        console.log(`Fetching ${filePath} from API`);
        const res = await fn(arg);
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

const exec = promisify(execFile);

export const extractZip = async (
  zipPath: string,
  outputDir: string,
): Promise<void> => {
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await exec('unzip', ['-q', '-o', zipPath, '-d', outputDir]);
};

export const sha1File = async (path: string): Promise<string> =>
  createHash('sha1')
    .update(await fs.readFile(path))
    .digest('hex');

// unzip exits 11 when the entry is absent; anything else is a real failure.
export const readZipText = (zipPath: string, entry: string): null | string => {
  try {
    return execFileSync('unzip', ['-p', zipPath, entry], {
      encoding: 'utf8',
    });
  } catch (caught) {
    if (caught instanceof Error && 'status' in caught && caught.status === 11) {
      return null;
    }
    throw caught;
  }
};

// Info-ZIP, not a JS zip library: AdmZip-written archives are rejected by
// strict readers (Prism Launcher's QuaZip fails to list them). -D and -X
// match the known-good Modrinth pack shape: no directory entries, no extra
// attributes.
export const zipFolder = async (
  folder: string,
  outZip: string,
): Promise<void> => {
  await fs.rm(outZip, { force: true });
  await exec('zip', ['-q', '-r', '-D', '-X', resolve(outZip), '.'], {
    cwd: folder,
  });
};
