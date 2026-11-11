import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { dirname, join } from 'path';

import { type Json, parseJson } from './json.js';

export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export const readJson = async (path: string): Promise<Json> =>
  parseJson(await fs.readFile(path, 'utf8'));

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

export const withFileCache =
  <Arg, Res>(
    cacheDir: string,
    cacheKey: (arg: Arg) => string,
    fn: (arg: Arg) => Promise<null | Res>,
    parse: (raw: Json) => null | Res,
  ) =>
  (arg: Arg): Promise<null | Res> => {
    const filePath = join(cacheDir, cacheKey(arg));
    return readJson(filePath)
      .catch(() => null)
      .then(cached => {
        const parsed = cached === null ? null : parse(cached);
        if (parsed !== null) {
          console.log(`Using cached ${filePath}`);
          return parsed;
        }
        console.log(`Fetching ${filePath} from API`);
        return fn(arg).then(res =>
          res === null
            ? res
            : fs
                .mkdir(dirname(filePath), { recursive: true })
                .then(() => fs.writeFile(filePath, JSON.stringify(res), 'utf8'))
                .then(() => res),
        );
      });
  };

export const extractZip = async (
  zipPath: string,
  outputDir: string,
): Promise<void> => {
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(outputDir, true);
};

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
