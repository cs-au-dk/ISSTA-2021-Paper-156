import { exec } from 'child_process';
import { promisify as p } from 'util';
import { addToMapSet } from './collections';
import { PackageOperations } from './package/package-operations';

export class DependencyTree {
  readonly mainDir: string;
  private parentMap: Map<string, Set<string>>;
  private childrenMap: Map<string, Set<string>>;
  private mainModule: string | undefined;
  constructor(mainDir: string) {
    this.mainDir = mainDir;
    this.parentMap = new Map();
    this.childrenMap = new Map();
  }

  async init() {
    const res = (await p(exec)('npm ls --all --only=prod', { cwd: this.mainDir })).stdout;
    const requireStack: string[] = [];

    const [firstLine, ...restLines] = res.split('\n');
    const mainModule = firstLine.split('@')[0];
    this.mainModule = mainModule;
    requireStack.push(mainModule);
    let lastIndex = 2;
    restLines.forEach((line) => {
      if (line.trim() === '') return;
      const matchIndex = /[a-zA-Z]/i.exec(line)?.index;
      if (!matchIndex) {
        throw Error('There should be a match index');
      }
      const module = line.substring(matchIndex).split('@')[0];
      while (matchIndex - 2 < lastIndex) {
        requireStack.pop();
        lastIndex = lastIndex - 2;
      }
      lastIndex = matchIndex;
      const parentDir =
        mainModule === requireStack[requireStack.length - 1] ? this.mainDir : requireStack[requireStack.length - 1];
      try {
        const moduleName = this.getEstimatedNpmModule(require.resolve(module, { paths: [parentDir] }));
        addToMapSet(this.childrenMap, requireStack[requireStack.length - 1], moduleName);
        addToMapSet(this.parentMap, moduleName, requireStack[requireStack.length - 1]);
        requireStack.push(moduleName);
      } catch (e) {
        requireStack.push('ERROR');
      }
    });
  }

  getModulesWithDistance1(file: string): string[] {
    const estimatedNpmModule = file.includes('node_modules')
      ? PackageOperations.estimateNpmModuleFromFile(file)
      : (this.mainModule as string);
    const res = [estimatedNpmModule];
    if (this.parentMap.has(estimatedNpmModule))
      (this.parentMap.get(estimatedNpmModule) as Set<string>).forEach((e) => res.push(e));
    if (this.childrenMap.has(estimatedNpmModule))
      (this.childrenMap.get(estimatedNpmModule) as Set<string>).forEach((e) => res.push(e));
    return res;
  }

  getModulesInSubtree(file: string): string[] {
    const estimatedNpmModule = file.includes('node_modules')
      ? PackageOperations.estimateNpmModuleFromFile(file)
      : (this.mainModule as string);
    const res: string[] = [];
    const wl = [estimatedNpmModule];
    while (wl.length > 0) {
      const item = wl.pop() as string;
      if (res.includes(item)) continue;
      res.push(item);
      if (this.childrenMap.has(item)) (this.childrenMap.get(item) as Set<string>).forEach((e) => wl.push(e));
    }
    return res;
  }

  getEstimatedNpmModule(file: string) {
    return file.includes('node_modules')
      ? PackageOperations.estimateNpmModuleFromFile(file)
      : (this.mainModule as string);
  }
}
