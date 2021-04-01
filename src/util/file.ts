import { promisify as p } from 'util';
import { lstat, mkdirs, readdir as fsReaddir, remove } from 'fs-extra';
import * as fs from 'fs';
import { join, resolve } from 'path';
import { asyncFilter } from './array';
import { flatten } from 'lodash';

export async function createDirectoryIfMissing(file: string) {
  if (!(await fileExists(file))) {
    await p(mkdirs)(file);
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch (error) {
    return false;
  }
}

export async function isDirectory(dir: string): Promise<boolean> {
  return (await fileExists(dir)) && (await lstat(dir)).isDirectory();
}

export async function deleteIfExists(path: string) {
  if (await fileExists(path)) {
    //@ts-ignore
    await p(remove)(path, { recursive: true });
  }
}

/**
 * returns all files (including directories) in path with fileExtension if specified
 * @param dir
 * @param recursive: reads sub directories
 * @param fileExtension: Only returns files with fileExtension if specified
 */
export async function readDir(
  dir: string,
  recursive: boolean = false,
  fileExtensions?: string[],
  excluded?: string[],
  excludedFiles?: string[],
  excludeDirectories?: boolean
): Promise<string[]> {
  async function readDir_(dir: string, pointer: string): Promise<string[]> {
    let files = await fsReaddir(dir);
    const subDirs = await asyncFilter(
      files,
      async (file) => (!excluded || !excluded.includes(join(pointer, file))) && (await isDirectory(resolve(dir, file)))
    );

    if (fileExtensions) {
      files = files
        .filter((file) => !file.includes('.') || fileExtensions.some((fileExtension) => file.endsWith(fileExtension)))
        .map((file) => resolve(dir, file));
    }
    if (excludedFiles)
      files = files.filter((file) => !excludedFiles.some((excludedFile) => resolve(dir, file).endsWith(excludedFile)));

    if (excludeDirectories) {
      files = await asyncFilter(files, async (f) => !(await isDirectory(f)));
    }

    // Resolve the files
    files = files.map((f) => resolve(dir, f));

    if (recursive) {
      return flatten(
        await Promise.all(subDirs.map(async (subDir) => readDir_(resolve(dir, subDir), join(pointer, subDir))))
      ).concat(files);
    } else {
      return files;
    }
  }
  return readDir_(dir, '');
}
