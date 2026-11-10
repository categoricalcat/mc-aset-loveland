import { mkdirSync } from 'fs';

const MODPACK_NAME = 'bias';

/**
 * Configuration for the modpack processor
 */
export const config = {
  /** Directory where the modpack will be extracted */
  backupDir: `.backups/${MODPACK_NAME}`,

  /** Directory for caching Modrinth API responses */
  cacheDir: '.backups/modrinth_cache',

  /** When true, files whose env declares unsupported for client or server are ignored */
  ignoreUnsupported: false as boolean,

  /** Path to the modrinth index file within the modpack */
  indexPath: 'modrinth.index.json',

  /** Directory where the mods will be downloaded */
  modsDir: '.backups/mods',

  /** When true, only process files in the mods/ directory */
  modsOnly: false as boolean,

  /** Path to the input modpack file */
  mrpackPath: `${MODPACK_NAME}.mrpack`,

  /** Path to the output index file */
  outputPath: 'index-copy.json',

  /** Path to the processed modpack output */
  processedPackPath: `${MODPACK_NAME}-processed.mrpack`,
} as const;

// mkdir -p for [cacheDir, modsDir]
mkdirSync(config.cacheDir, { recursive: true });
mkdirSync(config.modsDir, { recursive: true });
