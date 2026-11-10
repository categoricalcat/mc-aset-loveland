import AdmZip from 'adm-zip';
import fs from 'fs/promises';

/**
 * Extracts a zip file to the specified output directory
 * @param zipPath - Path to the zip file to extract
 * @param outputDir - Directory where the zip contents will be extracted
 * @throws Will throw an error if extraction fails
 */
export const extractZip = async (
  zipPath: string,
  outputDir: string,
): Promise<void> => {
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);
};
