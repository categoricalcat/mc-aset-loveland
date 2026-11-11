import type { File } from '../../../types/modrinth.js';

import { config } from '../../config.js';
import { isUnsupported } from './is-unsupported.js';

/**
 * Keeps a file for the server pack.
 * Drops server-unsupported files, and non-mods when modsOnly is set.
 */
export const shouldProcessFile = (file: File): boolean => {
  if (config.modsOnly && !file.path.startsWith('mods/')) return false;
  return !isUnsupported(file.env);
};
