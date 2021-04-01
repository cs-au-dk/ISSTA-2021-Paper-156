import { createLogger } from '../logging';
import { exec } from 'child_process';
import { promisify as p } from 'util';
import { readFile } from 'fs';
import { find } from 'lodash';
import { StaticConfiguration } from '../static-configuration';
import { satisfies } from 'semver';
import { ModelGenerator } from '../usage-model-generator/model-generator';
import { Client } from '../util/package/client';
import { PackageOperations } from '../util/package/package-operations';
import {
  AccessPathPattern,
  CallAccessPathPattern,
  CallPattern,
  DisjunctionAccessPathPattern,
  ImportPathPattern,
  parsePattern,
  Pattern,
  PropertyPathPattern,
} from './pattern-language';
import { FunctionCreation, ModuleMainPath } from '../usage-model-generator/access-path';
import {
  buildCallGraphsForDependencies,
  CallGraph,
  extendCallGraphWithMain,
  getPackageModelFile,
  joinCallGraphs,
  PropertyReadsOnLibraryObjectStrategies,
  SimpleCallGraph,
} from '../usage-model-generator/compute-call-graph';
import { fileExists } from '../util/file';

let logger = createLogger(`vulnerability-scanner`, 'info');
export class VulnerabilityScanner {
  private clientFolder: Promise<string>;
  private cg: CallGraph | undefined = undefined;
  private fromMainCG: SimpleCallGraph | undefined = undefined;

  constructor(client: string | Client, private clientMain?: string, debug?: boolean) {
    logger = createLogger('vulnerability-scanner', debug ? 'debug' : 'info');
    if (typeof client === 'string') {
      this.clientFolder = Promise.resolve(client);
    } else {
      this.clientFolder = new Promise((res) => {
        PackageOperations.prepareClient(client).then((f) => res(f));
      });
    }
  }

  async runScanner(
    modular = false,
    fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies
  ): Promise<ScannerResult> {
    logger.info(`looking for vulnerabilities in client ${await this.clientFolder}`);
    const depP = VulnerabilityScanner.getTransitiveDependencies(await this.clientFolder);
    const vulnerabilityPatterns: VulnerabilityPattern[] = JSON.parse(
      await p(readFile)(StaticConfiguration.vulnerabilityPatternsFile, 'utf-8')
    );
    const clientTransitiveDependencies = await depP;

    const mayPotentiallyMatch: VulnerabilityPattern[] = [];
    for (const vp of vulnerabilityPatterns) {
      const match = find(
        clientTransitiveDependencies,
        (dep) => dep.name === vp.library && satisfies(dep.version, `${vp.versionMin} - ${vp.versionMax}`)
      );
      if (match) {
        mayPotentiallyMatch.push(vp);
      }
    }

    const clientMain = this.clientMain || require.resolve(await this.clientFolder);
    let cgConstructionStartTime = new Date().getTime();
    if (modular) {
      const cgDependencyStart = new Date().getTime();
      const cgsDependencies: CallGraph[] = await buildCallGraphsForDependencies(
        await this.clientFolder,
        fieldBasedStrategy
      );
      console.log('CGDependenciesTime: ' + (new Date().getTime() - cgDependencyStart));
      const cgJoinStart = new Date().getTime();
      cgConstructionStartTime = new Date().getTime();
      const cgDependencies = joinCallGraphs(cgsDependencies);
      console.log('CGJoin: ' + (new Date().getTime() - cgJoinStart));
      const cgExtendStart = new Date().getTime();
      this.cg = await extendCallGraphWithMain(await this.clientFolder, clientMain, cgDependencies);
      console.log('CGExtend: ' + (new Date().getTime() - cgExtendStart));
    } else {
      this.cg = await ModelGenerator.buildCallGraphFromMain(
        await this.clientFolder,
        [clientMain],
        fieldBasedStrategy,
        []
      );
      await this.cg.resolveUnresolvedNodes();
    }
    const cgConstructionTime = new Date().getTime() - cgConstructionStartTime;
    const filteringStartTime = new Date().getTime();
    this.fromMainCG = this.cg.filterReachableEdgesFromLoadOfModule(clientMain);
    const cgFilteringTime = new Date().getTime() - filteringStartTime;
    let vulnerableFunctionsUsed: (FunctionCreation | ModuleMainPath)[] = [];
    const vulnerableAdvisoriesFound: Set<number> = new Set();
    for (const vp of mayPotentiallyMatch) {
      const vulnerableLibraryFile = require.resolve(vp.library, { paths: [await this.clientFolder] });
      const matchingPkgModelFile = await getPackageModelFile(vulnerableLibraryFile);
      let vulnerableFunDefs: (FunctionCreation | ModuleMainPath)[] = [];
      if (await fileExists(matchingPkgModelFile)) {
        const pattern = parsePattern(vp.pattern);
        const apPatterns = getAPPatterns(pattern);
        for (let apPattern of apPatterns) {
          const usageModel = this.cg.getUsageModel(vulnerableLibraryFile);
          if (pattern instanceof CallPattern && apPattern instanceof ImportPathPattern) {
            // look for usage of main in vulnerableLibraryFile
            const exportAccPaths = usageModel?.fieldBasedSummary.get('exports');
            if (exportAccPaths) vulnerableFunDefs.push(...this.cg.getApsForResolvedCallGraphNodes(exportAccPaths));
          } else if (pattern instanceof CallPattern && apPattern instanceof PropertyPathPattern) {
            // look for usage of propNames in vulnerableLibraryFile
            for (const pName of apPattern.propNames) {
              const propAccPaths = usageModel?.fieldBasedSummary.get(pName);
              if (propAccPaths) vulnerableFunDefs.push(...this.cg.getApsForResolvedCallGraphNodes(propAccPaths));
            }
          } else if (pattern instanceof CallPattern && apPattern instanceof CallAccessPathPattern) {
            const exportAccPaths = usageModel?.fieldBasedSummary.get('exports');
            if (exportAccPaths) {
              const callees = this.cg.getApsForResolvedCallGraphNodes(exportAccPaths);
              callees.forEach((ap) => {
                const returns = usageModel?.functionReturnSummaries.get(ap);
                if (returns) vulnerableFunDefs.push(...this.cg!.getApsForResolvedCallGraphNodes(returns));
              });
            }
          } else {
            throw new Error(`Unsupported pattern: ${apPattern}`);
          }
        }
      }

      const usedFunctions = (await this.fromMainCG).getAllAccPathsFromNodes();
      for (const vf of vulnerableFunDefs) {
        if (usedFunctions.has(vf)) {
          logger.warn(`usage of vulnerable function ${vf} detected in client await ${this.clientFolder}`);
          logger.warn('StackTrace: ' + this.fromMainCG.getStackTracesToFunction(vf, 10).join('\n'));
          vulnerableFunctionsUsed.push(vf);
          vulnerableAdvisoriesFound.add(vp.id);
        }
      }
    }
    const numberFunctionsReachable = this.fromMainCG.getNumberFunctionsReachable();
    const numberModulesReachable = this.fromMainCG.getNumberModulesReachable();
    const numberPackagesReachable = this.fromMainCG.getNumberPackagesReachable();
    return {
      alarms: vulnerableAdvisoriesFound,
      cgConstructionTime,
      cgFilteringTime,
      numberFunctionsReachable,
      numberModulesReachable,
      numberPackagesReachable,
    };
  }

  public static async getTransitiveDependencies(folder: string, prodOnly: boolean = false): Promise<Dependency[]> {
    try {
      const retrieveDependenciesCmd = `npm ls --json --all ${prodOnly ? '--only=prod' : ''}`;
      logger.debug(`running: (cd ${folder} && ${retrieveDependenciesCmd})`);
      const stdout = await new Promise<string>(async (res) => {
        exec(retrieveDependenciesCmd, { cwd: await folder }, (_err, stdout) => {
          // fail later since the npm ls command may produce valid output on a non-zero exit code.
          // for example, if there are unmet peer dependencies
          res(stdout);
        });
      });
      const depObj = JSON.parse(stdout);
      const res: Dependency[] = [];

      const processDepObj = (o: any) => {
        const deps = Object.getOwnPropertyNames(o);
        for (const dep of deps) {
          res.push({ name: dep, version: o[dep].version });
          if (o[dep].dependencies) {
            processDepObj(o[dep].dependencies);
          }
        }
      };
      if (depObj.dependencies) {
        processDepObj(depObj.dependencies);
      }
      return res;
    } catch (e) {
      logger.error(`unable to retrieve transitive dependencies for client in ${folder}`);
      throw e;
    }
  }

  getCallGraph(): CallGraph {
    if (this.cg) return this.cg;
    else throw new Error(`The scanner must be run before the call graph can be retrieved`);
  }

  getCallGraphFromMain() {
    if (this.fromMainCG) return this.fromMainCG;
    else throw new Error(`The scanner must be run before the call graph can be retrieved`);
  }
}

interface Dependency {
  name: string;
  version: string;
}

interface VulnerabilityPattern {
  library: string;
  versionMin: string;
  versionMax: string;
  pattern: string;
  id: number;
}

interface ScannerResult {
  alarms: Set<number>;
  cgConstructionTime: number;
  cgFilteringTime: number;
  numberFunctionsReachable: number;
  numberModulesReachable: number;
  numberPackagesReachable: number;
}

function getAPPatterns(pattern: Pattern): AccessPathPattern[] {
  if (pattern instanceof CallPattern) {
    const apPattern = pattern.accessPathPattern;
    return apPattern instanceof DisjunctionAccessPathPattern ? apPattern.accessPathPatterns : [apPattern];
  }
  throw new Error(`Currently unsupported pattern: ${pattern}`);
}
