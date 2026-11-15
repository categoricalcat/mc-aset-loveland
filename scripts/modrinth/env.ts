import type { File } from './types.js';

export const serverFiles = (files: readonly File[]): File[] =>
  files.filter(file => file.env.server !== 'unsupported');
