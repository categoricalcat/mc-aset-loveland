import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { dirname, join } from 'path';

export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));

export const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(path, 'utf8')) as unknown;

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
    isValid: (raw: unknown) => raw is Res,
  ) =>
  (arg: Arg): Promise<null | Res> => {
    const filePath = join(cacheDir, cacheKey(arg));
    return readJson(filePath)
      .catch(() => null)
      .then(cached => {
        if (isValid(cached)) {
          console.log(`Using cached ${filePath}`);
          return cached;
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
      reject(toError(err));
    }
  });
