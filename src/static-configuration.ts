import { normalize, resolve } from 'path';
import { REGISTER_INSTANCE } from 'ts-node';

export const isInTest = typeof global.it === 'function';
export class StaticConfiguration {
  public static projectHome = normalize(resolve(__dirname, isInTest ? '../' : '../../'));
  public static outPath: string = resolve(StaticConfiguration.projectHome, 'out');
  public static packageModelOut: string = resolve(StaticConfiguration.projectHome, 'out-package-model');
  public static resPath: string = resolve(StaticConfiguration.projectHome, 'res');
  public static packageModelRes: string = resolve(StaticConfiguration.resPath, 'package-models');
  public static sampleClientFolder: string = resolve(StaticConfiguration.resPath, 'sample-packages');
  public static libraryLoadClientFolder: string = resolve(StaticConfiguration.resPath, 'library-load-benchmarks');
  public static nodeprofJar: string = resolve(StaticConfiguration.resPath, 'nodeprof.jar');
  public static jalangiAnalysis: string = resolve(StaticConfiguration.resPath, 'jalangi.js');
  public static outCallGraphPath: string = resolve(StaticConfiguration.outPath, 'call-graphs');
  public static dynamicCallGraphPath: string = resolve(StaticConfiguration.resPath, 'dynamic-call-graphs');
  public static distFolder: string = resolve(StaticConfiguration.projectHome, 'dist');
  public static compileOutputFolder: string = StaticConfiguration.isRunningTests()
    ? StaticConfiguration.distFolder
    : StaticConfiguration.projectHome;
  public static nodeProfAnalysisFolder = resolve(StaticConfiguration.compileOutputFolder, 'src', 'node-prof-analyses');
  public static mainModuleIdentifier = 'MAIN_MODULE';
  private static moduleWhiteListFolder = resolve(
    StaticConfiguration.compileOutputFolder,
    'src',
    'module-whitelist-checker'
  );
  public static whitelistCheckerCommonJS = resolve(StaticConfiguration.moduleWhiteListFolder, 'common-js-hook.js');
  public static whitelistCheckerES6 = resolve(
    StaticConfiguration.projectHome,
    'src',
    'module-whitelist-checker',
    'es6-module-hook.mjs'
  );
  public static whiteListUtilCompiled = resolve(StaticConfiguration.distFolder, 'module-whitelist-checker', 'util.js');
  static clientCloneFolder = resolve(StaticConfiguration.outPath, 'client-clone');
  static dockerFolder = resolve(StaticConfiguration.resPath, 'docker');
  public static githubRepoClientsWithSucceedingTestsFolder = resolve(
    StaticConfiguration.resPath,
    'github-repo-clients-with-succeeding-tests'
  );
  public static githubRepoClientsWithSucceedingTestsFolderWithCommitHashes = resolve(
    StaticConfiguration.resPath,
    'github-repo-clients-with-succeeding-tests-with-commit-hashes'
  );
  public static clientListsFolder = resolve(StaticConfiguration.resPath, 'client-lists');
  static fetchPath = resolve(StaticConfiguration.outPath, 'client-fetch');
  static vulnerabilityPatternsFile = resolve(
    StaticConfiguration.resPath,
    'vulnerabilities',
    'vulnerability-patterns.json'
  );
  static benignWarningsFolder = resolve(StaticConfiguration.resPath, 'benign-dead-module-eliminator-warnings');
  static jsCallGraphOutFolder = resolve(StaticConfiguration.outPath, 'js-callgraph-results');
  static benchmarkInputs = resolve(StaticConfiguration.resPath, 'benchmark-inputs.json');
  static benchmarkResources = resolve(StaticConfiguration.resPath, 'benchmark-resources');
  /**
   * returns true if running the mocha tests
   */
  public static isRunningTests(): boolean {
    // Checks if ts-node is enabled (only the case for tests)
    return typeof process[REGISTER_INSTANCE] === 'object';
  }
}
