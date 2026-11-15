import {
  checkConflicts,
  type FabricMod,
  type File,
  missingRequiredProjects,
  type ModrinthClient,
  type ModrinthIndex,
  type ModrinthVersion,
  parseFabricMod,
  parseModrinthIndex,
  type ResolvedVersion,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import type { Loader } from '../loaders.js';

import { parseJson } from '../json.js';
import {
  extractZip,
  isMissing,
  readJson,
  readZipText,
  sha1File,
  zipFolder,
} from '../utils.js';

export interface PackPaths {
  cacheDir: string;
  indexPath: string;
  inputPath: string;
  stem: string;
  workDir: string;
}

interface Archive {
  finalPath: string;
  stagedPath: string;
}

interface PackWorkspace {
  index: ModrinthIndex;
  paths: PackPaths;
  stageArchive: (
    finalPath: string,
    nextIndex: ModrinthIndex,
    beforeZip?: () => Promise<void>,
  ) => Promise<void>;
}

export const resolvePackPaths = (
  rawInput: string,
  cwd = process.cwd(),
): PackPaths => {
  const stem = path.basename(rawInput, '.mrpack');
  const workDir = path.join(cwd, '.backups', stem);
  return {
    cacheDir: path.join(cwd, '.backups', 'modrinth_cache'),
    indexPath: path.join(workDir, 'modrinth.index.json'),
    inputPath: rawInput.endsWith('.mrpack') ? rawInput : `${rawInput}.mrpack`,
    stem,
    workDir,
  };
};

export const publishArchives = async (
  archives: readonly Archive[],
): Promise<void> => {
  const backups = new Map<Archive, string>();
  const published: Archive[] = [];
  try {
    for (const archive of archives) {
      const backupPath = `${archive.finalPath}.${process.pid}.previous`;
      try {
        await fs.rename(archive.finalPath, backupPath);
        backups.set(archive, backupPath);
      } catch (caught) {
        if (!isMissing(caught)) throw caught;
      }
    }
    for (const archive of archives) {
      await fs.rename(archive.stagedPath, archive.finalPath);
      published.push(archive);
    }
  } catch (caught) {
    const rollback = [
      ...(await Promise.allSettled(
        published.map(archive => fs.rm(archive.finalPath, { force: true })),
      )),
      ...(await Promise.allSettled(
        [...backups].map(([archive, backupPath]) =>
          fs.rename(backupPath, archive.finalPath),
        ),
      )),
    ];
    for (const result of rollback) {
      if (result.status === 'rejected') {
        console.error(`Archive rollback failed: ${String(result.reason)}`);
      }
    }
    throw caught;
  }
  await Promise.all(
    [...backups.values()].map(backupPath =>
      fs.rm(backupPath).catch((caught: unknown) => {
        console.warn(
          `Unable to remove backup archive ${backupPath}: ${String(caught)}`,
        );
      }),
    ),
  );
};

export const writeErrorLog = (
  logPath: string,
  entries: readonly string[],
): Promise<void> =>
  entries.length === 0
    ? fs.rm(logPath, { force: true })
    : fs.writeFile(logPath, `${entries.join('\n')}\n`);

export const packLoader = (index: ModrinthIndex): Loader =>
  index.dependencies.neoforge === undefined ? 'fabric' : 'neoforge';

export interface OverrideJar {
  jarPath: string;
  name: string;
  version: ModrinthVersion | undefined;
}

interface OverridePartition {
  duplicates: OverrideJar[];
  kept: OverrideJar[];
}

const fabricMod = (jar: { jarPath: string; name: string }): FabricMod[] => {
  try {
    const text = readZipText(jar.jarPath, 'fabric.mod.json');
    if (text === null) return [];
    const mod = parseFabricMod(parseJson(text), jar.name);
    return mod === null ? [] : [mod];
  } catch {
    console.warn(`  Unreadable ${jar.name} or its fabric.mod.json`);
    return [];
  }
};

// A required dep can be the updated copy of a jar Prism left in overrides/mods.
const modSlug = (filename: string): string =>
  path
    .basename(filename, '.jar')
    .toLowerCase()
    .split(/[-+_](?=\d|mc\d|v\d|fabric|neoforge|forge|quilt)/)[0] ?? '';

export const partitionOverrides = async (
  files: readonly File[],
  resolved: ReadonlyMap<string, ResolvedVersion>,
  overrideModsDir: string,
  fetchVersionsByHash: ModrinthClient['fetchVersionsByHash'],
): Promise<OverridePartition> => {
  const indexed = new Set(
    files
      .filter(file => file.path.startsWith('mods/'))
      .map(file => modSlug(file.path)),
  );
  const overrideJars = (
    await fs
      .readdir(overrideModsDir, { withFileTypes: true })
      .catch((caught: unknown) => {
        if (isMissing(caught)) return [];
        throw caught;
      })
  ).flatMap(entry =>
    entry.isFile() && entry.name.endsWith('.jar') ? [entry.name] : [],
  );
  const jars = await Promise.all(
    overrideJars.map(async name => {
      const jarPath = path.join(overrideModsDir, name);
      return { jarPath, name, sha1: await sha1File(jarPath) };
    }),
  );
  const byHash = await fetchVersionsByHash(jars.map(jar => jar.sha1));
  const duplicates: OverrideJar[] = [];
  const kept: OverrideJar[] = [];
  for (const jar of jars) {
    const version = byHash.get(jar.sha1);
    // Jars Modrinth does not know fall back to the filename prefix.
    const isDuplicate =
      version === undefined
        ? indexed.has(modSlug(jar.name))
        : resolved.has(version.project_id);
    (isDuplicate ? duplicates : kept).push({ ...jar, version });
  }
  return { duplicates, kept };
};

export const removeDuplicateJars = async (
  duplicates: readonly OverrideJar[],
): Promise<void> => {
  await Promise.all(duplicates.map(jar => fs.rm(jar.jarPath)));
  if (duplicates.length > 0) {
    console.log(
      `Removed override jars already in the index: ${duplicates.map(jar => jar.name).join(', ')}`,
    );
  }
};

// A dep on a project with no builds for this loader (e.g. a NeoForge-only
// library required by a universal jar) can never apply to this pack. A failed
// lookup keeps the dep fatal: inapplicability must be proven, not assumed.
const skippedDepReasons = async (
  missing: readonly string[],
  loader: Loader,
  getProject: ModrinthClient['getProject'],
): Promise<Map<string, string>> => {
  const reasons = new Map<string, string>();
  // Sequential: Modrinth throttling assumes one request in flight.
  for (const projectId of missing) {
    const project = await getProject(projectId).catch(() => null);
    if (project !== null && !project.loaders.includes(loader)) {
      reasons.set(projectId, `it has no ${loader} builds`);
    }
  }
  return reasons;
};

const OTHER_SIDE = 'only shipped on the other side';

// A message raised on both sides needs no label; a side-specific one does.
const mergeSideMessages = (
  client: readonly string[],
  server: readonly string[],
): string[] => {
  const clientSet = new Set(client);
  const serverSet = new Set(server);
  return [
    ...client.filter(message => serverSet.has(message)),
    ...client
      .filter(message => !serverSet.has(message))
      .map(message => `[client] ${message}`),
    ...server
      .filter(message => !clientSet.has(message))
      .map(message => `[server] ${message}`),
  ];
};

// Checks run per installation side: the client and server zips install
// different file sets. A dep missing from the whole pack is fatal on the
// side that needs it; a dep shipped only on the other side warns, since jar
// metadata proves such requirements are often hints. Override jars ship in
// the client zip only.
export const assertNoConflicts = async (
  resolved: ReadonlyMap<string, ResolvedVersion>,
  overrides: readonly OverrideJar[],
  loader: Loader,
  getProject: ModrinthClient['getProject'],
  files: readonly File[],
): Promise<string[]> => {
  const envByPath = new Map(files.map(file => [file.path, file.env]));
  const overrideMods = overrides.flatMap(({ name, version }) =>
    version === undefined
      ? []
      : [{ ...version, path: `overrides/mods/${name}` }],
  );
  const jars = loader === 'fabric' ? overrides.flatMap(fabricMod) : [];
  const allMods = [...resolved.values(), ...overrideMods];
  const allProjects = new Set(allMods.map(mod => mod.project_id));
  const skippedVersions = new Map(allMods.map(mod => [mod.id, OTHER_SIDE]));
  const checkSide = async (
    side: 'client' | 'server',
  ): Promise<ReturnType<typeof checkConflicts>> => {
    const mods = [
      ...[...resolved.values()].filter(
        mod =>
          (envByPath.get(mod.path)?.[side] ?? 'required') !== 'unsupported',
      ),
      ...(side === 'client' ? overrideMods : []),
    ];
    const missing = missingRequiredProjects(mods);
    // A dep shipped on the other side is an env split, not an absence: the
    // pack has the project, so only a side-absent dep can be a real conflict.
    // Those need no lookup; only side-absent deps must prove inapplicability.
    const skipped = await skippedDepReasons(
      missing.filter(projectId => !allProjects.has(projectId)),
      loader,
      getProject,
    );
    for (const projectId of missing) {
      if (allProjects.has(projectId)) {
        skipped.set(projectId, OTHER_SIDE);
      }
    }
    return checkConflicts(
      mods,
      side === 'client' ? jars : [],
      skipped,
      skippedVersions,
    );
  };
  // Sequential: Modrinth throttling assumes one request in flight.
  const client = await checkSide('client');
  const server = await checkSide('server');
  const merged = (key: 'conflicts' | 'errors' | 'warnings'): string[] =>
    mergeSideMessages(client[key], server[key]);
  const conflicts = merged('conflicts');
  for (const warning of merged('warnings')) {
    console.warn(`  Warning: ${warning}`);
  }
  if (conflicts.length > 0) {
    console.error(`\n${conflicts.length} mod conflict(s):`);
    for (const conflict of conflicts) console.error(`  ${conflict}`);
    throw new Error('mod conflicts; no pack written');
  }
  return merged('errors');
};

export const runPackPipeline = async <T>(
  paths: PackPaths,
  build: (workspace: PackWorkspace) => Promise<T>,
): Promise<T> => {
  await extractZip(paths.inputPath, paths.workDir);
  console.log(`Extracted ${paths.inputPath} to ${paths.workDir}`);

  const index = parseModrinthIndex(await readJson(paths.indexPath));
  if (index === null) throw new Error(`invalid index ${paths.indexPath}`);

  const staged: Archive[] = [];
  try {
    const result = await build({
      index,
      paths,
      stageArchive: async (finalPath, nextIndex, beforeZip) => {
        await fs.writeFile(paths.indexPath, JSON.stringify(nextIndex));
        await beforeZip?.();
        const stagedPath = `${finalPath}.${process.pid}.tmp`;
        staged.push({ finalPath, stagedPath });
        await zipFolder(paths.workDir, stagedPath);
      },
    });
    await publishArchives(staged);
    return result;
  } finally {
    await Promise.all(
      staged.map(({ stagedPath }) => fs.rm(stagedPath, { force: true })),
    );
  }
};
