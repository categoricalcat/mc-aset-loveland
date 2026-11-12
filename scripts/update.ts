import {
  checkConflicts,
  type FabricMod,
  fetchVersionsByHash,
  type File,
  keptFiles,
  type ModrinthIndex,
  type ModrinthVersion,
  parseFabricMod,
  processAndLogFile,
  type ResolvedVersion,
  resolvePackFiles,
  serverFiles,
} from '@modrinth';
import fs from 'fs/promises';
import path from 'path';

import { config } from './config.js';
import { parseJson } from './json.js';
import { latestLoaderVersion, type Loader } from './loaders.js';
import { reportLookupErrors, runPack } from './pack.js';
import { readZipText, sha1File, zipFolder } from './utils.js';

const GAME = '26.3';
const packStem = path.basename(config.mrpackPath, '.mrpack');
const serverPackPath = `${packStem}-update-server.mrpack`;
const clientPackPath = `${packStem}-update-client.mrpack`;
const overrideMods = path.join(config.backupDir, 'overrides', 'mods');

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

interface OverrideJar {
  jarPath: string;
  name: string;
  version: ModrinthVersion | undefined;
}

// A required dep can be the updated copy of a jar Prism left in overrides/mods.
const modSlug = (filename: string): string =>
  path
    .basename(filename, '.jar')
    .toLowerCase()
    .split(/[-+_](?=\d|mc\d|v\d|fabric|neoforge|forge|quilt)/)[0] ?? '';

const pruneOverrides = async (
  files: readonly File[],
  resolved: ReadonlyMap<string, ResolvedVersion>,
): Promise<OverrideJar[]> => {
  const indexed = new Set(
    files
      .filter(file => file.path.startsWith('mods/'))
      .map(file => modSlug(file.path)),
  );
  const overrideJars = (
    await fs
      .readdir(overrideMods, { withFileTypes: true })
      .catch((caught: unknown) => {
        if (
          caught instanceof Error &&
          'code' in caught &&
          caught.code === 'ENOENT'
        ) {
          return [];
        }
        throw caught;
      })
  ).flatMap(entry =>
    entry.isFile() && entry.name.endsWith('.jar') ? [entry.name] : [],
  );
  const jars = await Promise.all(
    overrideJars.map(async name => {
      const jarPath = path.join(overrideMods, name);
      return { jarPath, name, sha1: await sha1File(jarPath) };
    }),
  );
  const byHash = await fetchVersionsByHash(jars.map(jar => jar.sha1));
  const overrides = jars.map(jar => ({
    ...jar,
    version: byHash.get(jar.sha1),
  }));
  // Jars Modrinth does not know fall back to the filename prefix.
  const isDuplicate = ({ name, version }: OverrideJar) =>
    version === undefined
      ? indexed.has(modSlug(name))
      : resolved.has(version.project_id);
  const duplicateOverrides = overrides.filter(isDuplicate);
  await Promise.all(duplicateOverrides.map(jar => fs.rm(jar.jarPath)));
  if (duplicateOverrides.length > 0) {
    console.log(
      `Removed override jars already in the index: ${duplicateOverrides.map(jar => jar.name).join(', ')}`,
    );
  }
  return overrides.filter(jar => !isDuplicate(jar));
};

const assertNoConflicts = (
  resolved: ReadonlyMap<string, ResolvedVersion>,
  overrides: readonly OverrideJar[],
  loader: Loader,
): void => {
  const { conflicts, warnings } = checkConflicts(
    [
      ...resolved.values(),
      ...overrides.flatMap(({ name, version }) =>
        version === undefined
          ? []
          : [{ ...version, path: `overrides/mods/${name}` }],
      ),
    ],
    loader === 'fabric' ? overrides.flatMap(fabricMod) : [],
  );
  for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  if (conflicts.length > 0) {
    console.error(`\n${conflicts.length} mod conflict(s):`);
    for (const conflict of conflicts) console.error(`  ${conflict}`);
    throw new Error('mod conflicts; no pack written');
  }
};

const outcome = await runPack(serverPackPath, 'updating', async index => {
  const loader: Loader =
    index.dependencies.neoforge === undefined ? 'fabric' : 'neoforge';
  const loaderKey = loader === 'neoforge' ? 'neoforge' : 'fabric-loader';
  const loaderVersion = await latestLoaderVersion(loader, GAME);
  const { files, resolved, unresolved } = await resolvePackFiles(
    index.files,
    GAME,
    loader,
  );

  const processed = await Array.fromAsync(files, (file, i) =>
    processAndLogFile(file, i, files.length),
  );
  const allFiles = keptFiles(processed);
  assertNoConflicts(resolved, await pruneOverrides(allFiles, resolved), loader);

  const updated = {
    ...index,
    dependencies: {
      ...index.dependencies,
      [loaderKey]: loaderVersion,
      minecraft: GAME,
    },
    files: allFiles,
  } satisfies ModrinthIndex;

  // Client zip still has overrides/mods. Server installers extract that
  // directory, so it is removed before the server zip.
  const indexPath = path.join(config.backupDir, config.indexPath);
  await fs.writeFile(indexPath, JSON.stringify(updated));
  await zipFolder(config.backupDir, clientPackPath);
  await fs.rm(overrideMods, { force: true, recursive: true });

  return {
    clientCount: allFiles.length,
    errors: processed.filter(({ error }) => error).length,
    index: {
      ...updated,
      files: serverFiles(allFiles),
    } satisfies ModrinthIndex,
    loader,
    loaderKey,
    loaderVersion,
    unresolved,
  };
});

if (outcome !== undefined) {
  await fs.rm('bias-updated.mrpack', { force: true });
  console.log(
    `Created ${clientPackPath} (${outcome.clientCount} files) and ${serverPackPath} (${outcome.index.files.length} files), ${outcome.loaderKey} ${outcome.loaderVersion}`,
  );
  if (outcome.unresolved.length > 0) {
    console.log(
      `Removed (no ${GAME} ${outcome.loader} build): ${outcome.unresolved.join(', ')}`,
    );
  }
  reportLookupErrors(outcome.errors);
}
