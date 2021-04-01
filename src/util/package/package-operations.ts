import { exec } from 'child_process';
import * as fs from 'fs';
import { existsSync } from 'fs';
// @ts-ignore
const getRepositoryURL = require('get-repository-url');
import { basename, relative, resolve } from 'path';
import request from 'request';
import { promisify as p } from 'util';

import { Package } from './package';

import { createLogger } from '../../logging';
import { StaticConfiguration } from '../../static-configuration';
import { createDirectoryIfMissing, fileExists, isDirectory, readDir } from '../file';
import { dockerizedCommand } from '../docker';
import gitP, { SimpleGit } from 'simple-git/promise';
import { Client } from './client';
import { parseFileWithAcorn } from '../parsing';
import { asyncFilter } from '../array';

const logger = createLogger('package-operations', 'info');

let gitMain: Promise<SimpleGit> = new Promise(async (res) => {
  await createDirectoryIfMissing(StaticConfiguration.clientCloneFolder);
  res(gitP(StaticConfiguration.clientCloneFolder));
});

export class PackageOperations {
  static async fetchPackage(pkg: Package): Promise<string> {
    const pkgPath = resolve(StaticConfiguration.fetchPath, `${pkg.getNpmPackCompatName()}@${pkg.version}`);
    const pkgFetchPath = resolve(pkgPath, 'package');
    if (existsSync(pkgFetchPath)) {
      return pkgFetchPath;
    }
    try {
      await createDirectoryIfMissing(pkgPath);

      // get the .tgz packaged contents of pkg.name@pkg.version.
      // npm pack will save the contents to the file pkgTgz.
      const pkgAtVersion = `${pkg.name}@${pkg.version}`;
      const pkgTgz = resolve(pkgPath, `${pkg.getNpmPackCompatName()}-${pkg.version}.tgz`);
      await p(exec)(`npm pack ${pkgAtVersion}`, { cwd: pkgPath });

      await p(exec)(`tar -xzf ${pkgTgz}`, { cwd: pkgPath });

      const pkgFetchPath = resolve(pkgPath, 'package');
      logger.info(`Successfully fetched package ${pkgAtVersion} into ${pkgFetchPath}`);
      return pkgFetchPath;
    } catch (e) {
      logger.error(`Unable to clone package ${pkg}. Failed with error ${e}`);
      throw e;
    }
  }

  /**
   * Performs an npm install
   * @param pkg if a Package, then it first fetches the content from the npm
   * registry, and then performs an npm install on the extracted content.
   */
  static async npmInstall(
    pkg: Package | string,
    prodOnly?: boolean,
    docker?: boolean,
    continueOnError?: boolean
  ): Promise<string> {
    let path = '';
    try {
      if (pkg instanceof Package) {
        path = await this.fetchPackage(pkg);
      } else {
        path = pkg;
      }

      const timeout = 1000 * 60 * 3;
      const installCommand = `npm install --ignore-scripts${prodOnly ? ' --only=prod' : ''}`;
      if (docker) {
        await dockerizedCommand(installCommand, path, timeout);
      } else {
        await p(exec)(installCommand, { cwd: path, timeout: timeout });
      }
    } catch (e) {
      if (continueOnError) {
        return path;
      }
      logger.error(`npm install failed for ${pkg.toString()}. Failed with error ${e}`);
      throw e;
    }

    return path;
  }

  /**
   * Returns the diff of all files in the two folders path1 and path2
   */
  static async diffContent(path1: string, path2: string): Promise<string> {
    return new Promise(function (resolve) {
      exec(`diff -r ${path1} ${path2}`, { maxBuffer: 10000 * 1024 }, (_, stdout) => {
        logger.debug(`computed diff between ${path1} and ${path2} as ${stdout.substring(0, 200)}...`);
        resolve(stdout);
      });
    });
  }

  static async getGitURL(pkg: Package | string): Promise<string> {
    const pkgName = pkg instanceof Package ? pkg.name : pkg;
    const repositoryURL = await getRepositoryURL(pkgName);
    if (!repositoryURL) throw new Error('Could not find git repository');
    // @ts-ignore
    return (await p(request)(repositoryURL)).request.href; // hack for getting the URL after redirects made by github
  }

  static async getPackageJsonObj(packagePath: string): Promise<any> {
    const packageJsonPath = resolve(packagePath, 'package.json');
    return await this.getJsonObject(packageJsonPath);
  }

  public static async getJsonObject(jsonFilePath: string) {
    const packageJsonCnt = await p(fs.readFile)(jsonFilePath, 'utf-8');
    const packageJsonObj = JSON.parse(packageJsonCnt);
    return packageJsonObj;
  }

  static async findGitTag(gitURL: string, version: string): Promise<string> {
    const stdout = (await p(exec)(`git ls-remote --tags ${gitURL}`, { cwd: StaticConfiguration.clientCloneFolder }))
      .stdout;
    const linesMatchingVersion = stdout.split('\n').filter((l) => l.includes(version));
    if (linesMatchingVersion.length == 0) {
      throw new Error('Tag not found');
    }
    return linesMatchingVersion[0].substring(linesMatchingVersion[0].lastIndexOf('/') + 1);
  }

  static getGitRepoPath(pkgName: string): string {
    return resolve(StaticConfiguration.clientCloneFolder, pkgName);
  }

  /**
   * returns a path to the cloned git repository.
   * Throws an exception if the clone fails.
   * @param gitURL
   * @param pkg
   */
  static async cloneGitRepository(gitURL: string, pkg: Package): Promise<string> {
    await createDirectoryIfMissing(StaticConfiguration.clientCloneFolder);
    const match = gitURL.match(/https:\/\/(.+)/);
    if (match) {
      // insert dummy username and password to force an immediate failure of the clone if the repository requires authentication.
      gitURL = `https://user:pass@${match[1]}`;
    }
    const dest = this.getGitRepoPath(pkg.name);
    const gitCloneCommand = `git clone ${gitURL} ${dest}`;
    logger.info(`Running '${gitCloneCommand}' for package ${pkg}`);
    try {
      await (await gitMain).clone(gitURL, dest);
      //  await p(exec)(gitCloneCommand, {
      //    cwd: StaticConfiguration.clientCloneFolder,
      //    timeout: 180000,
      //    killSignal: 'SIGKILL',
      //  });
    } catch (e) {
      logger.debug(`handleUpdate for ${pkg} failed with ${e}`);
      throw e;
    }
    return dest;
  }

  static async npmInstallAndBuild(gitDir: string, docker?: boolean): Promise<ExecReturn> {
    const timeout = 3 * 60 * 1000;
    if (docker) {
      await this.npmInstall(gitDir, docker);
      return dockerizedCommand('npm run-script build', gitDir, timeout);
    }
    return new Promise(function (resolve) {
      exec(
        `npm install`,
        { cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL' },
        (error, stdout: string, stderr: string) => {
          p(exec)('npm run-script build', { cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL' })
            .catch((_) => undefined)
            .finally(() => resolve({ exit: error?.code || 0, signal: error?.signal, stdout: stdout, stderr: stderr }));
        }
      );
    });
  }

  /**
   * @param gitDir
   */
  static async runTest(gitDir: string, docker?: boolean, explicitTestCommand?: string): Promise<ExecReturn> {
    const timeout = 1000 * 60 * 3;
    const command = explicitTestCommand || 'npm test';
    if (docker) {
      return dockerizedCommand(command, gitDir, timeout);
    }
    return new Promise(function (resolve) {
      exec(command, { cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        resolve({ exit: error?.code || 0, signal: error?.signal, stdout: stdout, stderr: stderr });
      });
    });
    // return [res.stdout, res.stderr];
  }

  static async prepareClient(client: Client) {
    await createDirectoryIfMissing(StaticConfiguration.clientCloneFolder);
    const clientPath = resolve(StaticConfiguration.clientCloneFolder, client.name);
    if (!(await fileExists(clientPath))) {
      await (await gitMain).clone(client.repo.gitURL, clientPath);
    }
    const clientGit = gitP(clientPath);
    await clientGit.checkout(client.repo.gitCommit);

    if (!(await fileExists(resolve(clientPath, 'node_modules')))) {
      // assume client is installed if node_modules exists.
      await dockerizedCommand('npm install', clientPath, 1000 * 60 * 10);
    }
    return clientPath;
  }

  static async getNumberTransitiveDependencies(clientPath: string) {
    return parseInt((await p(exec)(`npm ls --only=prod | wc -l`, { cwd: clientPath })).stdout) - 2;
  }

  static estimateNpmModuleFromFile(fileLocation: string) {
    const match = fileLocation.match(/(.*node_modules\/[^\/]+)/);
    return match ? relative(process.cwd(), match[1]) : basename(fileLocation);
  }

  static async getAllPackageJavaScriptFiles(clientPath: string): Promise<string[]> {
    return asyncFilter(await readDir(clientPath, true), async (f) => {
      if (f.endsWith('.js') || f.endsWith('.mjs')) {
        return true;
      }
      if (!f.includes('.') && !(await isDirectory(f))) {
        try {
          await parseFileWithAcorn(f);
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    });
  }
}
type ExecReturn = {
  exit: number;
  signal?: string;
  stdout: string;
  stderr: string;
};
