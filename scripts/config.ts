import { mkdirSync } from 'fs';
import { basename } from 'path';

const rawInput = process.argv[2] ?? 'bias';
const modpackStem = basename(rawInput, '.mrpack');

/**
 * Configuration for the modpack processor
 */
export const config = {
  /** Directory where the modpack will be extracted */
  backupDir: `.backups/${modpackStem}`,

  /** Directory for caching Modrinth API responses */
  cacheDir: '.backups/modrinth_cache',

  /** Path to the modrinth index file within the modpack */
  indexPath: 'modrinth.index.json',

  /** When true, only process files in the mods/ directory */
  modsOnly: false as boolean,

  /** Path to the input modpack file */
  mrpackPath: rawInput.endsWith('.mrpack') ? rawInput : `${rawInput}.mrpack`,

  /** Path to the output index file */
  outputPath: 'index-copy.json',

  /** Path to the processed modpack output */
  processedPackPath: `${modpackStem}-processed.mrpack`,
} as const;

mkdirSync(config.cacheDir, { recursive: true });
