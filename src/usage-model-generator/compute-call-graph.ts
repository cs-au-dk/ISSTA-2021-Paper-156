import { UsageModel } from './usage-model';
import {
  AccessPath,
  ArgumentsAccessPath,
  CallAccessPath,
  FunctionCreation,
  ImportAccessPath,
  MODULE_NOT_FOUND_STRING,
  ModuleMainPath,
  ParameterAccessPath,
  PropAccessPath,
  StringLiteralAccessPath,
  StringPrefixAccessPath,
  StringSuffixAccessPath,
  ThisAccessPath,
  UnknownAccessPath,
} from './access-path';
import { BUILT_IN, ModelGenerator } from './model-generator';
import * as path from 'path';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'path';
import { applySeries } from '../util/promise';
import {
  addAllToMapSetWithStringEquality,
  addMapSetToMapMapSet,
  addToMapSet,
  addToMapSetWithStringEquality,
  joinMaps,
  joinMapSets,
  joinSets,
  MapWithToStringEquality,
  setUnion,
  SetWithToStringEquality,
  setWithToStringEqualityUnion,
} from '../util/collections';
import { ImportDeclaration, SimpleCallExpression, SourceLocation } from 'estree';
import { StaticConfiguration } from '../static-configuration';
import graphviz from 'graphviz';
import { createDirectoryIfMissing, fileExists } from '../util/file';
import * as fs from 'fs';
import { parseFileWithAcorn } from '../util/parsing';
import { isExpressionStatement, isRequireCall, isSimpleLiteral } from '../util/ast-utils';
import { promisify as p } from 'util';
import { createHash } from 'crypto';
import { ancestor } from 'acorn-walk';
import { createLogger } from '../logging';
import { DependencyTree } from '../util/dependency-tree';
import { PackageOperations } from '../util/package/package-operations';

const logger = createLogger('simple-call-graph', 'info');
const USE_MORE_FINE_GRAINED_FIELD_BASED = true;
export class SimpleCallGraph {
  constructor(
    protected nodes: SetWithToStringEquality<SimpleCallGraphNode>,
    protected edges_: SetWithToStringEquality<CallGraphEdge>,
    protected edgeToTargets_: MapWithToStringEquality<CallGraphEdge, SetWithToStringEquality<SimpleCallGraphNode>>,
    protected sourceSLToEdgeMap_: Map<string, Set<CallGraphEdge>>,
    protected usageModels: Map<string, UsageModel>,
    protected dependencyTree: DependencyTree
  ) {}
  async toPNG(outputFile: string) {
    await writeCGAsDot(
      outputFile,
      this.nodes,
      new SetWithToStringEquality(),
      this.edges,
      this.edgeToTargets,
      new SetWithToStringEquality()
    );
  }
  get sourceSLToEdgeMap() {
    return this.sourceSLToEdgeMap_;
  }

  get edges() {
    return this.edges_;
  }

  get edgeToTargets() {
    return this.edgeToTargets_;
  }

  // getAllAccPathsFromEdges(): SetWithToStringEquality<AccessPath> {
  //   return new SetWithToStringEquality([...this.edges].map((e) => e.callerAccPath));
  // }

  getAllAccPathsFromNodes(): SetWithToStringEquality<FunctionCreation | ModuleMainPath> {
    return new SetWithToStringEquality(
      [...this.nodes].filter((n) => n instanceof ResolvedCallGraphNode).map((n) => (n as ResolvedCallGraphNode).node)
    );
  }

  getAllModulesLoaded(): SetWithToStringEquality<ModuleMainPath> {
    return new SetWithToStringEquality(
      [...this.getAllAccPathsFromNodes()].filter((ap) => ap instanceof ModuleMainPath)
    ) as SetWithToStringEquality<ModuleMainPath>;
  }

  getAllModulesUsed(): SetWithToStringEquality<FunctionCreation | ModuleMainPath> {
    const getModulesUsedFromAccPath = (f: FunctionCreation | ImportAccessPath) => {
      const fileLocation = f instanceof FunctionCreation ? f.file : f.fileLocation;
      const usages = this.usageModels.get(resolve(fileLocation))?.functionUsageSummaries.get(f);
      if (usages) {
        return ([...usages]
          .filter((usage) => usage.getRootElement() instanceof ImportAccessPath)
          .map((usage) => new ModuleMainPath((usage.getRootElement() as ImportAccessPath).fileLocation)) as (
          | ModuleMainPath
          | FunctionCreation
        )[]).concat([f instanceof FunctionCreation ? f : new ModuleMainPath(f.fileLocation)]);
      } else {
        console.log(`unable to find usage model for file ${fileLocation}`);
        return [f instanceof FunctionCreation ? f : new ModuleMainPath(f.fileLocation)];
        //throw new Error(`unable to find usage model for file ${f.file}`);
      }
    };
    const mainModulesToAddUsagesFrom: Set<string> = new Set();
    const res = new SetWithToStringEquality(
      ([...this.getAllAccPathsFromNodes()].filter((ap) => ap instanceof FunctionCreation) as FunctionCreation[])
        .map((f) => {
          mainModulesToAddUsagesFrom.add(f.file);
          return getModulesUsedFromAccPath.call(this, f);
        })
        .reduce((prevVal, newVal) => prevVal.concat(newVal))
    ) as SetWithToStringEquality<FunctionCreation | ModuleMainPath>;
    mainModulesToAddUsagesFrom.forEach((f) => {
      [...this.usageModels.get(resolve(f))?.functionUsageSummaries.keys()]
        .filter((ap) => ap instanceof ImportAccessPath)
        .forEach((ap) => getModulesUsedFromAccPath(ap).forEach((a) => res.add(a)));
    });
    return res;
  }

  async getFileLocationsForAllUsedModulesAndModulesLoadedWithoutBeingStored(): Promise<Set<string>> {
    return new Set(
      [...(await this.getAllModulesUsedAndLoadedWithoutStored())]
        .concat([...(await this.getAllNonFunctionalModulesLoaded())])
        .filter((ap) => {
          // filter away BUILT_IN and internal modules, e.g., <path>, <fs> etc.
          const file = ap instanceof ModuleMainPath ? ap.fileLocation : ap.file;
          // we use the hack that no separator (/) appears in the filename of built-ins.
          return file.includes('/');
        })
        .map((ap) => resolve(ap instanceof ModuleMainPath ? ap.fileLocation : ap.file))
    );
  }

  async getAllNonFunctionalModulesLoaded(): Promise<SetWithToStringEquality<FunctionCreation | ModuleMainPath>> {
    const modulesLoaded = this.getAllModulesLoaded();
    const res: SetWithToStringEquality<FunctionCreation | ModuleMainPath> = new SetWithToStringEquality();
    await applySeries([...modulesLoaded], async (moduleNode) => {
      if (await fileExists(moduleNode.fileLocation)) {
        const packageModelFile = await getPackageModelFile(moduleNode.fileLocation);
        if (await fileExists(packageModelFile)) {
          const pkgModelCnt: any = JSON.parse(await p(fs.readFile)(packageModelFile, { encoding: 'utf-8' }));
          const mainModuleEntry = pkgModelCnt[StaticConfiguration.mainModuleIdentifier];
          if (mainModuleEntry) {
            if (
              !(
                typeof mainModuleEntry === 'object' ||
                (typeof mainModuleEntry === 'string' && mainModuleEntry === 'object')
              )
            ) {
              res.add(moduleNode);
              return;
            }
          }
        }
      }
    });
    return res;
  }

  async getAllModulesUsedAndLoadedWithoutStored(): Promise<SetWithToStringEquality<FunctionCreation | ModuleMainPath>> {
    const res: SetWithToStringEquality<FunctionCreation | ModuleMainPath> = new SetWithToStringEquality();
    const modulesLoaded = this.getAllModulesLoaded();
    const modulesUsed = this.getAllModulesUsed();
    modulesUsed.forEach((mu) => res.add(mu));
    await applySeries([...modulesLoaded], async (moduleNode) => {
      const n = new ResolvedCallGraphNode(moduleNode);
      const edgesWithNAsTarget = [...this.edges].filter((e) =>
        [...this.edgeToTargets.get(e)].some((target) => n.toString() === target.toString())
      );
      const filesWithPotentialSideEffectImports = new Set(edgesWithNAsTarget.map((e) => e.callFile));
      await applySeries([...filesWithPotentialSideEffectImports], async (f) => {
        const program = await parseFileWithAcorn(f);
        ancestor(program, {
          ImportDeclaration: function (node: ImportDeclaration) {
            if (
              node.specifiers.length === 0 &&
              node.source.value === 'string' &&
              require.resolve(node.source.value, { paths: [dirname(f)] }) === moduleNode.fileLocation
            )
              res.add(moduleNode);
          },
          CallExpression: function (n: SimpleCallExpression, ancestors: any[]) {
            if (!n.loc) return;
            if (
              isRequireCall(n, new Set()) &&
              isSimpleLiteral(n.arguments[0]) &&
              typeof n.arguments[0].value === 'string' &&
              (() => {
                try {
                  return require.resolve(n.arguments[0].value, { paths: [dirname(f)] }) === moduleNode.fileLocation;
                } catch (e) {
                  // ignore if module cannot be resolved.
                  logger.warn(`ignoring unresolvable module ${n.arguments[0].value}`);
                  return false;
                }
              })() &&
              isExpressionStatement(ancestors[ancestors.length - 1])
            )
              res.add(moduleNode);
          },
        });
      });
    });
    return res;
  }

  getStackTracesToFunction(
    vf: FunctionCreation | ModuleMainPath,
    depth: number
  ): (FunctionCreation | ModuleMainPath)[] {
    const stack = [vf];
    const edgesArray = [...this.edges];
    for (let i = 0; i < depth; i++) {
      const edge = edgesArray.find((e) =>
        [...this.edgeToTargets.get(e)].some((target) => target.toString() === stack[stack.length - 1].toString())
      );
      if (!edge) break;
      if (!(edge.source instanceof ResolvedCallGraphNode)) throw new Error('What to do in this case');
      stack.push(edge.source.node);
    }
    return stack;
  }

  getNumberFunctionsReachable() {
    return [...this.nodes].filter((n) => n instanceof ResolvedCallGraphNode && n.node instanceof FunctionCreation)
      .length;
  }

  getNumberModulesReachable() {
    return this.getReachableModules().size;
  }

  private getReachableModules() {
    return new Set(
      [...this.nodes]
        .filter((n) => n instanceof ResolvedCallGraphNode)
        .map((n) => n as ResolvedCallGraphNode)
        .map((n) =>
          n.node instanceof FunctionCreation ? n.node.file : `./${relative(process.cwd(), n.node.fileLocation)}`
        )
        .filter((file) => file.startsWith('./out'))
    );
  }

  getNumberPackagesReachable() {
    const reachablePackages = new Set(
      [...this.getReachableModules()].map((file) => this.dependencyTree.getEstimatedNpmModule(file))
    );
    return reachablePackages.size - 1; // Subtract the application
  }

  public getNodes(): SetWithToStringEquality<SimpleCallGraphNode> {
    return this.nodes;
  }
}

export class CallGraph {
  protected usageModels: Map<string, UsageModel>;
  protected modulesToIgnore: string[];
  protected nodes: MapWithToStringEquality<NodeAccessPath, CallGraphNode>;
  protected intermediaryNodes: MapWithToStringEquality<NodeAccessPath, CallGraphNode>;
  protected edges_: SetWithToStringEquality<CallGraphEdge>;
  protected intermediaryEdges: SetWithToStringEquality<CallGraphEdge>;
  protected sourceSLToEdgeMap_: Map<string, SetWithToStringEquality<CallGraphEdge>>;
  protected rho: MapWithToStringEquality<NodeAccessPath, SetWithToStringEquality<CallGraphNode>>;
  protected sourceToEdgeMap: MapWithToStringEquality<CallGraphNode, SetWithToStringEquality<CallGraphEdge>>;
  protected targetToEdgeMap: MapWithToStringEquality<CallGraphNode, SetWithToStringEquality<CallGraphEdge>>;
  protected urTargetsToUrSourcesTransitively: MapWithToStringEquality<
    UnresolvedCallGraphNode,
    SetWithToStringEquality<UnresolvedCallGraphNode>
  >;
  protected urSourcesToUrTargetsTransitively: MapWithToStringEquality<
    UnresolvedCallGraphNode,
    SetWithToStringEquality<UnresolvedCallGraphNode>
  >;
  protected intermediaryTargetToEdge: MapWithToStringEquality<CallGraphNode, SetWithToStringEquality<CallGraphEdge>>;
  protected fieldBasedInfo: Map<string, SetWithToStringEquality<AccessPath>>;
  protected fieldBasedInfoWithWildcards: Map<string, SetWithToStringEquality<AccessPath>>;
  protected preciserFieldBasedInfo: Map<string, Map<string, SetWithToStringEquality<AccessPath>>>;
  protected fieldBasedInfoForLibraries: Map<string, Map<string, SetWithToStringEquality<AccessPath>>>;
  protected getterInfo: Map<string, SetWithToStringEquality<AccessPath>>;
  protected dependencyTree: DependencyTree;
  protected mainDir: string;
  protected funCreationToParamNodes: MapWithToStringEquality<
    FunctionCreation,
    SetWithToStringEquality<UnresolvedCallGraphNode>
  >;
  protected fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies;
  protected eventListenerSummary: Map<String, SetWithToStringEquality<AccessPath>>;

  protected edgeToTargets_: MapWithToStringEquality<CallGraphEdge, SetWithToStringEquality<SimpleCallGraphNode>>;

  constructor(
    mainDir: string,
    fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies,
    additionalModulesToIgnore?: string[]
  ) {
    this.usageModels = new Map();
    this.nodes = new MapWithToStringEquality();
    this.intermediaryNodes = new MapWithToStringEquality();
    this.edges_ = new SetWithToStringEquality();
    this.intermediaryEdges = new SetWithToStringEquality();
    this.sourceSLToEdgeMap_ = new Map();
    this.rho = new MapWithToStringEquality();
    this.sourceToEdgeMap = new MapWithToStringEquality();
    this.targetToEdgeMap = new MapWithToStringEquality();
    this.edgeToTargets_ = new MapWithToStringEquality();
    this.urTargetsToUrSourcesTransitively = new MapWithToStringEquality();
    this.urSourcesToUrTargetsTransitively = new MapWithToStringEquality();
    this.intermediaryTargetToEdge = new MapWithToStringEquality();
    this.fieldBasedInfo = new Map();
    this.fieldBasedInfoWithWildcards = new Map();
    this.getterInfo = new Map();
    this.dependencyTree = new DependencyTree(mainDir);
    this.preciserFieldBasedInfo = new Map();
    this.fieldBasedInfoForLibraries = new Map();
    this.mainDir = mainDir;
    this.funCreationToParamNodes = new MapWithToStringEquality();
    this.fieldBasedStrategy = fieldBasedStrategy;
    this.eventListenerSummary = new Map();

    this.modulesToIgnore = ['RegExp', 'Array', 'Function', 'Object', ...(additionalModulesToIgnore || [])];
  }

  public copy(): CallGraph {
    const newCG = new CallGraph(this.mainDir, this.fieldBasedStrategy);
    newCG.usageModels = this.usageModels;
    newCG.nodes = this.nodes;
    newCG.edges_ = this.edges_;
    newCG.targetToEdgeMap = this.targetToEdgeMap;
    newCG.urTargetsToUrSourcesTransitively = this.urTargetsToUrSourcesTransitively;
    newCG.urSourcesToUrTargetsTransitively = this.urSourcesToUrTargetsTransitively;
    newCG.sourceToEdgeMap = this.sourceToEdgeMap;
    newCG.modulesToIgnore = this.modulesToIgnore;
    newCG.sourceSLToEdgeMap_ = this.sourceSLToEdgeMap_;
    newCG.intermediaryTargetToEdge = this.intermediaryTargetToEdge;
    newCG.fieldBasedInfo = this.fieldBasedInfo;
    newCG.getterInfo = this.getterInfo;
    return newCG;
  }

  public async computeFieldBasedInfoFromUsageModels() {
    const res: Map<string, Map<string, SetWithToStringEquality<AccessPath>>> = new Map(); // Map from module name to set of access paths to use for field based
    this.usageModels.forEach((usageModel, file) => {
      this.dependencyTree.getModulesWithDistance1(file).forEach((module: string) => {
        addMapSetToMapMapSet(res, module, usageModel.fieldBasedSummary);
      });
    });
    this.preciserFieldBasedInfo = res;
    const fieldBasedInfoForLibraries: Map<string, Map<string, SetWithToStringEquality<AccessPath>>> = new Map(); // Map from module name to set of access paths to use for field based
    this.usageModels.forEach((usageModel, file) => {
      this.dependencyTree.getModulesInSubtree(file).forEach((module: string) => {
        addMapSetToMapMapSet(fieldBasedInfoForLibraries, module, usageModel.fieldBasedSummary);
      });
    });
    this.fieldBasedInfoForLibraries = fieldBasedInfoForLibraries;
  }

  public filterReachableEdgesFromLoadOfModule(absFilePath: string) {
    const dir = normalize(resolve(absFilePath, relative(absFilePath, process.cwd())));
    const relFilepath = `./${relative(process.cwd(), absFilePath)}`;
    const mainNode = this.lookupSimpleNode(new ImportAccessPath(relFilepath, dir, DummyLocation));
    const newNodes: SetWithToStringEquality<SimpleCallGraphNode> = new SetWithToStringEquality();
    const newEdges: SetWithToStringEquality<CallGraphEdge> = new SetWithToStringEquality();
    const worklist: CallGraphEdge[] = [];
    newNodes.add(mainNode);
    this.sourceToEdgeMap.get(mainNode)?.forEach((e) => worklist.push(e));
    if (!this.sourceToEdgeMap.has(mainNode)) throw new Error('Could not find mainNode');
    return this.filterCallGraphBasedOnInitialWorklist(worklist, newEdges, new MapWithToStringEquality(), newNodes);
  }

  public async filterReachableBasedOnAllUsages(absFilePaths: string[]): Promise<SimpleCallGraph> {
    const newNodes: SetWithToStringEquality<SimpleCallGraphNode> = new SetWithToStringEquality();
    const newEdges: SetWithToStringEquality<CallGraphEdge> = new SetWithToStringEquality();
    const worklist: CallGraphEdge[] = [];
    await applySeries(absFilePaths, async (absFilePath) => {
      const dir = normalize(resolve(absFilePath, relative(absFilePath, process.cwd())));
      const relFilepath = `./${relative(process.cwd(), absFilePath)}`;
      const usageModel = this.usageModels.get(absFilePath);
      if (!usageModel) throw new Error('Could not find usageModel');
      [...usageModel.exportsSummary.values()].forEach((exportPaths) => {
        [...exportPaths]
          .filter((exportPath) => !(exportPath instanceof ImportAccessPath && exportPath.fileLocation === BUILT_IN))
          .forEach((exportPath) => {
            const newNode = this.lookupSimpleNode(exportPath);
            this.sourceToEdgeMap.get(newNode)?.forEach((e) => worklist.push(e));
            newNodes.add(newNode);
          });
      });
      const mainNode = this.lookupSimpleNode(new ImportAccessPath(relFilepath, dir, DummyLocation));
      newNodes.add(mainNode);
      this.sourceToEdgeMap.get(mainNode)?.forEach((e) => worklist.push(e));
    });
    return this.filterCallGraphBasedOnInitialWorklist(worklist, newEdges, new MapWithToStringEquality(), newNodes);
  }

  private filterCallGraphBasedOnInitialWorklist(
    worklist: CallGraphEdge[],
    newEdges: SetWithToStringEquality<CallGraphEdge>,
    newEdgeToTargets: MapWithToStringEquality<CallGraphEdge, SetWithToStringEquality<SimpleCallGraphNode>>,
    newNodes: SetWithToStringEquality<SimpleCallGraphNode>
  ): SimpleCallGraph {
    while (worklist.length > 0) {
      const elem: CallGraphEdge = worklist.shift() as CallGraphEdge;
      if (newEdges.has(elem)) continue;
      if (!this.edges.has(elem))
        // Can happen due to edges that has not been deleted properly from sourceToEdgeMap
        continue;
      newEdges.add(elem);
      this.edgeToTargets.get(elem)?.forEach((target) => {
        if (!isSimpleCallGraphNode(target)) {
          throw new Error(`expected ${target} to point to simple call graph node`);
        }
        addToMapSetWithStringEquality(newEdgeToTargets, elem, target);
        if (newNodes.has(target)) return;
        newNodes.add(target);
        const edgesFromTarget = this.sourceToEdgeMap.get(target);
        if (!edgesFromTarget) return;
        worklist.push(...edgesFromTarget);
      });
    }
    const newSourceSLToEdgeMap: Map<string, Set<CallGraphEdge>> = new Map();
    newEdges.forEach((e) =>
      addToMapSet(newSourceSLToEdgeMap, inFileSourceLocationToStringOnlyLines(e.callSourceLocation), e)
    );
    return new SimpleCallGraph(
      newNodes,
      newEdges,
      newEdgeToTargets,
      newSourceSLToEdgeMap,
      this.usageModels,
      this.dependencyTree
    );
  }

  async computeAndAddUsageModel(importAccessPath: ImportAccessPath): Promise<boolean> {
    if (this.shouldNotComputeUsageModel(importAccessPath)) {
      return false;
    }
    const usageModel = await ModelGenerator.computeUsageModelFromImportAccessPath(
      importAccessPath,
      this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_DYNAMIC_ANALYSIS
    );
    this.usageModels.set(importAccessPath.fileLocation, usageModel);
    usageModel.fieldBasedSummary.forEach((accPaths, propName) =>
      addAllToMapSetWithStringEquality(this.fieldBasedInfo, propName, accPaths)
    );
    usageModel.fieldBasedSummaryWithWildcards.forEach((accPaths, propName) =>
      addAllToMapSetWithStringEquality(this.fieldBasedInfoWithWildcards, propName, accPaths)
    );
    usageModel.gettersSummary.forEach((accPaths, propName) =>
      addAllToMapSetWithStringEquality(this.getterInfo, propName, accPaths)
    );
    usageModel.eventListenerSummary.forEach((accPaths, propName) =>
      addAllToMapSetWithStringEquality(this.eventListenerSummary, propName, accPaths)
    );
    await this.processUsageModel(usageModel);
    return true;
  }

  private shouldNotComputeUsageModel(path: ModuleMainPath | ImportAccessPath) {
    return (
      (path instanceof ImportAccessPath && this.modulesToIgnore.includes(path.importPath)) ||
      (path instanceof ModuleMainPath && this.modulesToIgnore.includes(path.estimatedModule)) ||
      path.fileLocation === BUILT_IN ||
      path.fileLocation === MODULE_NOT_FOUND_STRING ||
      !isAbsolute(path.fileLocation) ||
      path.fileLocation.endsWith('.json')
    );
  }

  async processUsageModel(usageModel: UsageModel) {
    await applySeries(usageModel.functionUsageSummaries.entries(), async ([entry, usages]) => {
      const sourceNode = this.lookupNode(entry) as ResolvedCallGraphNode;
      await applySeries([...usages], async (usage) => {
        if (usage instanceof ImportAccessPath || usage instanceof CallAccessPath || usage instanceof PropAccessPath) {
          const targets = await this.getNodesFromAccPaths(usage);
          addAllToMapSetWithStringEquality(
            this.rho,
            usage instanceof PropAccessPath
              ? new GetterAccessPath(usage)
              : this.toNodeAccessPath(usage instanceof CallAccessPath ? usage.callee : usage),
            new SetWithToStringEquality([...targets].filter((target) => target instanceof ResolvedCallGraphNode))
          );
          targets.forEach((target) => {
            this.createEdge(sourceNode, usage, target);
          });
        }
      });
    });
  }

  public lookupNode(accPath: AccessPath): CallGraphNode {
    const nodeAccPath = this.toNodeAccessPath(accPath);
    if (!this.nodes.has(nodeAccPath)) {
      if (
        nodeAccPath instanceof FunctionCreation ||
        (nodeAccPath instanceof ModuleMainPath && nodeAccPath.fileLocation !== BUILT_IN)
      ) {
        this.createResolvedNode(nodeAccPath);
      } else {
        this.createUnresolvedNode(nodeAccPath);
        return this.intermediaryNodes.get(nodeAccPath) as CallGraphNode;
      }
    }
    return this.nodes.get(nodeAccPath) as CallGraphNode;
  }

  public lookupSimpleNode(accPath: AccessPath): SimpleCallGraphNode {
    const node = this.lookupNode(accPath);
    if (isSimpleCallGraphNode(node)) {
      return node;
    }
    throw new Error(`Unexpectedly received non-simple callgraph node ${node} when looking up ${accPath}`);
  }

  public lookupNodes(accPaths: Set<FunctionCreation | ImportAccessPath>): Set<CallGraphNode> {
    return new Set([...accPaths].map((accPath) => this.lookupNode(accPath)));
  }

  public async getNodesFromAccPaths(
    accPath: ImportAccessPath | CallAccessPath | PropAccessPath
  ): Promise<Set<CallGraphNode>> {
    if (accPath instanceof ImportAccessPath) {
      if (!this.usageModels.has(accPath.fileLocation)) await this.computeAndAddUsageModel(accPath);
      return new Set([this.lookupNode(accPath)]);
    } else if (accPath instanceof PropAccessPath)
      return new Set([this.createUnresolvedNode(new GetterAccessPath(accPath))]);
    // (accPath instanceof CallAccessPath)
    else return await this.getCalleeNode(accPath.callee);
  }

  public async getCalleeNode(accPath: AccessPath): Promise<Set<CallGraphNode>> {
    if (accPath instanceof ImportAccessPath && !this.usageModels.has(accPath.fileLocation)) {
      await this.computeAndAddUsageModel(accPath);
    } else if (accPath instanceof PropAccessPath) {
      const rootElement = accPath.getRootElement();
      if (
        rootElement instanceof ImportAccessPath &&
        accPath.isPropReadOnModuleSequence() &&
        rootElement.fileLocation !== BUILT_IN &&
        !this.usageModels.has(rootElement.fileLocation)
      ) {
        await this.computeAndAddUsageModel(rootElement);
      }
    }
    return this.getCalleeNodeWithoutCreatingUsageModels(accPath);
  }

  public getCalleeNodeWithoutCreatingUsageModels(accPath: AccessPath): Set<CallGraphNode> {
    if (accPath instanceof FunctionCreation) {
      return new Set([this.lookupNode(accPath)]);
    } else if (accPath instanceof ImportAccessPath) {
      if (this.shouldNotComputeUsageModel(accPath)) return new Set([this.lookupNode(accPath)]);
      if (!this.usageModels.has(accPath.fileLocation)) {
        throw new Error(`Missing um for: ${accPath.fileLocation}`);
      }
      const um = this.usageModels.get(accPath.fileLocation) as UsageModel;
      let funCreationElements;
      if (this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_DYNAMIC_ANALYSIS) {
        funCreationElements = um.exportsSummary.get(StaticConfiguration.mainModuleIdentifier);
      } else if (um.fieldBasedSummary.has('exports')) {
        return setUnion(
          [...um.fieldBasedSummary.get('exports')].map((ap) => this.getCalleeNodeWithoutCreatingUsageModels(ap))
        );
      }
      if (!funCreationElements) {
        if (this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_DYNAMIC_ANALYSIS)
          throw new Error(`Missing ${StaticConfiguration.mainModuleIdentifier} exports information for: ${accPath}`);
        else return new Set(); // The static analysis could not find the mainModule object.
      }
      return this.lookupNodes(funCreationElements);
    } else if (accPath instanceof PropAccessPath) {
      const rootElement = accPath.getRootElement();
      if (
        rootElement instanceof ImportAccessPath &&
        accPath.isPropReadOnModuleSequence() &&
        rootElement.fileLocation !== BUILT_IN &&
        this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_DYNAMIC_ANALYSIS
      ) {
        if (!this.usageModels.has(rootElement.fileLocation)) {
          if (this.shouldNotComputeUsageModel(rootElement)) return new Set([this.createUnresolvedNode(accPath)]);
          throw new Error(`Missing um for: ${accPath}`);
        }
        const um = this.usageModels.get(rootElement.fileLocation) as UsageModel;
        const funCreationElements = um.exportsSummary.get(accPath.getExportsSummaryAccessPath());
        if (!funCreationElements) {
          return new Set([this.createUnresolvedNode(accPath)]); // default to field based
        }
        return this.lookupNodes(funCreationElements);
      } else {
        return new Set([this.createUnresolvedNode(accPath)]);
      }
    } else if (accPath instanceof CallAccessPath) {
      const nodes: Set<CallGraphNode> = new Set();
      if (
        accPath.callee instanceof PropAccessPath &&
        accPath.callee.prop === 'assign' &&
        accPath.callee.receiver instanceof ImportAccessPath &&
        accPath.callee.receiver.importPath === 'Object' &&
        accPath.args.length > 0
      )
        accPath.args[0].forEach((argAP) =>
          this.getCalleeNodeWithoutCreatingUsageModels(argAP).forEach((n) => nodes.add(n))
        );
      if (accPath.callee instanceof PropAccessPath && accPath.callee.prop === 'bind')
        this.getCalleeNodeWithoutCreatingUsageModels(accPath.callee.receiver).forEach((n) => nodes.add(n));
      nodes.add(this.createUnresolvedNode(accPath));
      return nodes;
    } else if (accPath instanceof ParameterAccessPath) {
      return new Set([this.createUnresolvedNode(accPath)]);
    } else if (accPath instanceof UnknownAccessPath) return new Set([this.createUnknownNode(accPath)]);
    else if (accPath instanceof ThisAccessPath) return new Set([this.createUnresolvedNode(accPath)]);
    else if (
      accPath instanceof ArgumentsAccessPath ||
      accPath instanceof StringLiteralAccessPath ||
      accPath instanceof StringPrefixAccessPath ||
      accPath instanceof StringSuffixAccessPath
    )
      return new Set();
    throw new Error(`Unsupported access path: ${accPath}`);
  }

  public createResolvedNode(nodeAccPath: FunctionCreation | ModuleMainPath) {
    const resolvedCallGraphNode =
      nodeAccPath instanceof ModuleMainPath && this.modulesToIgnore.includes(nodeAccPath.estimatedModule)
        ? new IgnoredModuleCallGraphNode(nodeAccPath.estimatedModule)
        : new ResolvedCallGraphNode(nodeAccPath);
    this.nodes.set(nodeAccPath, resolvedCallGraphNode);
    addToMapSetWithStringEquality(this.rho, nodeAccPath, resolvedCallGraphNode);
    return resolvedCallGraphNode;
  }

  public createUnresolvedNode(accPath: AccessPath | NodeAccessPath) {
    if (!isNodeAccessPath(accPath)) accPath = this.toNodeAccessPath(accPath);
    if (this.intermediaryNodes.has(accPath)) return this.intermediaryNodes.get(accPath) as UnresolvedCallGraphNode;
    const unresolvedCallGraphNode = new UnresolvedCallGraphNode(accPath);
    if (accPath instanceof ParameterAccessPath)
      addToMapSetWithStringEquality(this.funCreationToParamNodes, accPath.declNodeAccPath, unresolvedCallGraphNode);
    this.addToWorklist(unresolvedCallGraphNode);
    this.intermediaryNodes.set(accPath, unresolvedCallGraphNode);
    return unresolvedCallGraphNode;
  }

  public createUnknownNode(accPath: UnknownAccessPath) {
    const unknownCallGraphNode = new UnknownCallGraphNode(accPath);
    this.nodes.set(accPath, unknownCallGraphNode);
    return unknownCallGraphNode;
  }

  private propagateIntermediaryEdge(e: CallGraphEdge, target: CallGraphNode, requireReprocessing = false) {
    if (target instanceof UnresolvedCallGraphNode) this.createIntermediaryEdge(e, target, requireReprocessing);
    else this.createRealEdge(e, target);
  }

  public createEdge(
    source: ResolvedCallGraphNode,
    callerAccPath: CallAccessPath | ImportAccessPath | PropAccessPath,
    target: CallGraphNode
  ) {
    if (!callerAccPath.sourceLocation || !callerAccPath.fileName)
      throw new Error('Missing source location or file name for call edge');

    const args = callerAccPath instanceof CallAccessPath ? callerAccPath.args : [];
    const argsToString = callerAccPath instanceof CallAccessPath ? callerAccPath.argsToString : '';
    const callGraphEdge = new CallGraphEdge(
      source,
      this.toNodeAccessPath(callerAccPath),
      args,
      argsToString,
      callerAccPath.sourceLocation,
      callerAccPath.fileName
    );
    if (target instanceof UnresolvedCallGraphNode) this.createIntermediaryEdge(callGraphEdge, target);
    else this.createRealEdge(callGraphEdge, target);
  }

  public createIntermediaryEdge(edge: CallGraphEdge, target: UnresolvedCallGraphNode, requireReprocessing = false) {
    if (this.intermediaryTargetToEdge.get(target)?.has(edge)) return;
    if (requireReprocessing) this.addToWorklist(target);
    addToMapSetWithStringEquality(this.intermediaryTargetToEdge, target, edge);
  }
  public createRealEdge(edge: CallGraphEdge, target: SimpleCallGraphNode) {
    if (this.edgeToTargets.get(edge)?.has(target)) return;
    if (this.resolvingOrHasResolvedSomeUnresolvedNodes) this.addToWorklist(edge, target);
    addToMapSetWithStringEquality(this.edgeToTargets_, edge, target);
    addToMapSetWithStringEquality(this.targetToEdgeMap, target, edge);
    addToMapSetWithStringEquality(this.sourceToEdgeMap, edge.source, edge);
    addToMapSet(this.sourceSLToEdgeMap_, inFileSourceLocationToStringOnlyLines(edge.callSourceLocation), edge);
    this.edges.add(edge);
  }

  public removeEdge(_edge: CallGraphEdge) {
    throw new Error('Currently not supported');
    // const source = edge.source;
    // const target = edge.target;
    // this.targetToEdgeMap.get(target)?.delete(edge);
    // this.sourceToEdgeMap.get(source)?.delete(edge);
    // this.edges.delete(edge);
    //
    // if (source instanceof ResolvedCallGraphNode) {
    //   this.sourceSLToEdgeMap_.get(source.sourceLocationString(true))?.delete(edge);
    // }
  }

  get sourceSLToEdgeMap() {
    return this.sourceSLToEdgeMap_;
  }

  get edges() {
    return this.edges_;
  }

  get edgeToTargets() {
    return this.edgeToTargets_;
  }

  public async toPNG(outputFile: string) {
    await writeCGAsDot(
      outputFile,
      new SetWithToStringEquality([...this.nodes.values()]),
      new SetWithToStringEquality([...this.intermediaryNodes.values()]),
      this.edges,
      this.edgeToTargets,
      this.intermediaryEdges
    );
  }

  async resolveUnresolvedNodesWithoutWorklist() {
    let previousNumberEdges;
    let previousNumberIntermediaryEdges;
    do {
      previousNumberEdges = this.edges.size;
      previousNumberIntermediaryEdges = this.intermediaryEdges.size;
      this.resolveUnresolvedNodesIteration();
    } while (previousNumberEdges != this.edges.size || previousNumberIntermediaryEdges !== this.intermediaryEdges.size);
  }

  private resolvingOrHasResolvedSomeUnresolvedNodes = false;
  private currentWorklistItems: Set<string> = new Set();
  private worklistItemsProcessed = 0;
  private worklist: WorkItem[] = [];
  async resolveUnresolvedNodes() {
    this.resolvingOrHasResolvedSomeUnresolvedNodes = true;
    while (this.worklist.length > 0) {
      const workItem = this.worklist.shift() as WorkItem;
      this.currentWorklistItems.delete(workItem.toString());
      this.processWorkItem(workItem);
      this.worklistItemsProcessed++;
      if (this.worklistItemsProcessed % 100 === 0) {
        console.log('Processed ' + this.worklistItemsProcessed + '. Left: ' + this.worklist.length);
      }
    }
    console.log('Done');
  }

  addNodesToBeRecomputedAfterGraphJoin() {
    this.intermediaryNodes.entries().forEach(([_k, un]) => {
      if (!(un instanceof UnresolvedCallGraphNode)) return;
      if (
        !(
          un.accessPath instanceof NodePropAccessPath ||
          un.accessPath instanceof GetterAccessPath ||
          (un.accessPath instanceof ModuleMainPath && un.accessPath.fileLocation === BUILT_IN)
        )
      )
        return;
      this.worklist.push(un);
    });
  }

  private processWorkItem(workItem: WorkItem) {
    if (workItem instanceof UnresolvedCallGraphNode) {
      const edges = this.intermediaryTargetToEdge.get(workItem);
      if (!edges) return;
      if (workItem.accessPath instanceof ParameterAccessPath) {
        this.resolveTargetWithEdges(workItem, edges);
      } else {
        this.resolveTargetWithEdges(workItem, edges);
      }
    } else if (workItem instanceof CallGraphEdge) {
      throw new Error('WorkItem cannot be a call edge anymore');
      // if (workItem.target instanceof ResolvedCallGraphNode && workItem.target.node instanceof FunctionCreation) {
      //   this.funCreationToParamNodes.get(workItem.target.node)?.forEach((target) => {
      //     const edges = this.intermediaryTargetToEdge.get(target);
      //     if (!edges) return;
      //     this.resolveTargetWithEdges(
      //       target,
      //       edges,
      //       new SetWithToStringEquality<CallGraphEdge>([workItem])
      //     );
      //   });
      // }
    } else if (workItem instanceof ResolvedCallGraphNode && workItem.node instanceof FunctionCreation) {
      this.funCreationToParamNodes.get(workItem.node)?.forEach((target) => {
        const edges = this.intermediaryTargetToEdge.get(target);
        if (!edges) return;
        this.resolveTargetWithEdges(target, edges);
      });
    }
  }
  private addEdgesToTheCorrespondingNodes(
    accessPaths: SetWithToStringEquality<AccessPath>,
    edges: SetWithToStringEquality<CallGraphEdge>,
    target: UnresolvedCallGraphNode
  ) {
    let processUrSourcesToTargets = false;
    accessPaths.forEach((ap) => {
      this.getCalleeNodeWithoutCreatingUsageModelsUsingCache(ap).forEach((n) => {
        if (n instanceof UnresolvedCallGraphNode) {
          if (!this.urSourcesToUrTargetsTransitively.get(target)?.has(n)) {
            addToMapSetWithStringEquality(this.urSourcesToUrTargetsTransitively, target, n);
            if (this.urSourcesToUrTargetsTransitively.get(n))
              addAllToMapSetWithStringEquality(
                this.urSourcesToUrTargetsTransitively,
                target,
                this.urSourcesToUrTargetsTransitively.get(n) as SetWithToStringEquality<UnresolvedCallGraphNode>
              );
            processUrSourcesToTargets = true;
            if (this.rho.has(n.accessPath)) {
              addAllToMapSetWithStringEquality(
                this.rho,
                target.accessPath,
                this.rho.get(n.accessPath) as SetWithToStringEquality<CallGraphNode>
              );
              this.urTargetsToUrSourcesTransitively.get(target)?.forEach((us) => {
                addAllToMapSetWithStringEquality(
                  this.rho,
                  us.accessPath,
                  this.rho.get(n.accessPath) as SetWithToStringEquality<CallGraphNode>
                );
              });
            }
            processUrSourcesToTargets = true;
          }
        } else if (n instanceof ResolvedCallGraphNode) {
          if (!this.rho.has(target.accessPath) || !this.rho.get(target.accessPath)?.has(n)) {
            addToMapSetWithStringEquality(this.rho, target.accessPath, n);
          }
          this.urTargetsToUrSourcesTransitively.get(target)?.forEach((us) => {
            if (!this.rho.get(us.accessPath)?.has(n)) addToMapSetWithStringEquality(this.rho, us.accessPath, n);
          });
        }
      });
    });
    if (processUrSourcesToTargets)
      this.urSourcesToUrTargetsTransitively
        .get(target)
        ?.forEach((t) => addToMapSetWithStringEquality(this.urTargetsToUrSourcesTransitively, t, target));
    edges.forEach((e) => this.rho.get(target.accessPath)?.forEach((n2) => this.propagateIntermediaryEdge(e, n2)));
    this.urSourcesToUrTargetsTransitively
      .get(target)
      ?.forEach((t) => addAllToMapSetWithStringEquality(this.intermediaryTargetToEdge, t, edges));
  }

  private addToWorklist(item: WorkItem, target?: SimpleCallGraphNode) {
    const itemToAdd = item instanceof CallGraphEdge ? target : item;
    if (!(itemToAdd instanceof ResolvedCallGraphNode || itemToAdd instanceof UnresolvedCallGraphNode)) return;
    const str = itemToAdd.toString();
    if (this.currentWorklistItems.has(str)) return;
    this.worklist.push(itemToAdd);
    this.currentWorklistItems.add(str);
    if (
      item instanceof CallGraphEdge &&
      item.source instanceof ResolvedCallGraphNode &&
      target instanceof ResolvedCallGraphNode
    ) {
      // when adding an edge with access path ap, also add all unresolved call graph nodes that rely on the returns from the call
      const unresolvedReturnNodeForCallee = this.intermediaryNodes.get(item.nodeCallerAccPath);
      if (
        unresolvedReturnNodeForCallee instanceof UnresolvedCallGraphNode &&
        !this.rho.get(item.nodeCallerAccPath)?.has(target) &&
        unresolvedReturnNodeForCallee.accessPath instanceof NodeCallAccessPath
      ) {
        const newWorklistItem = unresolvedReturnNodeForCallee;
        const str2 = newWorklistItem.toString();
        if (this.currentWorklistItems.has(str2)) return;
        this.worklist.push(newWorklistItem);
        this.currentWorklistItems.add(str2);
      }
    }
  }

  private resolveUnresolvedNodesIteration() {
    this.intermediaryTargetToEdge.forEach((edges, target) => {
      this.resolveTargetWithEdges(target, edges);
    });
  }

  private resolveTargetWithEdges(target: CallGraphNode, edges: SetWithToStringEquality<CallGraphEdge>) {
    if (!(target instanceof UnresolvedCallGraphNode)) return;
    let nodeAccPaths: SetWithToStringEquality<AccessPath> = new SetWithToStringEquality();
    if (target.accessPath instanceof NodeCallAccessPath) {
      const nodesToGetReturnsFrom = this.rho.get(target.accessPath.callee);
      nodesToGetReturnsFrom?.forEach((cgn: CallGraphNode) => {
        if (!(cgn instanceof ResolvedCallGraphNode)) return;
        let file = cgn.node instanceof FunctionCreation ? cgn.node.file : cgn.node.fileRelativeToCwd;
        if (!isAbsolute(file)) {
          file = resolve(process.cwd(), file);
        }
        if (!this.usageModels.has(file)) {
          if (cgn.node instanceof ModuleMainPath && this.shouldNotComputeUsageModel(cgn.node)) return;
          throw new Error('We should not generate new usage models: ' + file);
        }
        const um = this.usageModels.get(file) as UsageModel;
        const returns = um.functionReturnSummaries.get(cgn.node);
        returns?.forEach((r) => nodeAccPaths.add(r));
      });
    } else if (target.accessPath instanceof ParameterAccessPath) {
      const callEdges = this.targetToEdgeMap.get(this.lookupNode(target.accessPath.declNodeAccPath));
      if (!callEdges) return;
      const paramNumber = (target.accessPath as ParameterAccessPath).paramNumber;
      callEdges.forEach((e1) => {
        if (!(paramNumber < e1.args.length)) return;
        else e1.args[paramNumber].forEach((e) => nodeAccPaths.add(e));
      });
    } else if (target.accessPath instanceof NodePropAccessPath) {
      const prop = (target.accessPath as NodePropAccessPath).prop;
      if (
        this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_FIELD_BASED_FROM_LIBRARY &&
        target.accessPath.library
      ) {
        nodeAccPaths =
          this.readFromFieldBasedInfo(this.fieldBasedInfoForLibraries.get(target.accessPath.library), prop) ||
          new SetWithToStringEquality<AccessPath>();
      } else if (!USE_MORE_FINE_GRAINED_FIELD_BASED) {
        nodeAccPaths =
          this.readFromFieldBasedInfo(this.fieldBasedInfo, prop) || new SetWithToStringEquality<AccessPath>();
      } else {
        nodeAccPaths =
          this.readFromFieldBasedInfo(
            this.preciserFieldBasedInfo.get(
              this.dependencyTree.getEstimatedNpmModule(target.accessPath.moduleReadFrom)
            ),
            prop
          ) || new SetWithToStringEquality<AccessPath>();
      }
      this.handleBuiltinMethodCalls(edges, prop);
    } else if (target.accessPath instanceof ModuleMainPath && target.accessPath.fileLocation === BUILT_IN) {
      this.handleBuiltinFunctionCalls(edges, target.accessPath);
      return;
    } else if (target.accessPath instanceof GetterAccessPath) {
      const prop = (target.accessPath as GetterAccessPath).prop;
      nodeAccPaths = this.getterInfo.get(prop) || new SetWithToStringEquality<AccessPath>();
    }
    this.addEdgesToTheCorrespondingNodes(nodeAccPaths, edges, target);
  }

  private readFromFieldBasedInfo(
    fieldBasedInfo: Map<string, SetWithToStringEquality<AccessPath>> | undefined,
    prop: string
  ) {
    if (!fieldBasedInfo) return;
    if (prop.startsWith('.*')) {
      const propNameSuffix = prop.substring(2);
      return setWithToStringEqualityUnion(
        [...fieldBasedInfo.entries()].filter(([k, _v]) => k.endsWith(propNameSuffix)).map(([_k, v]) => v)
      );
    } else if (prop.endsWith('.*')) {
      const propNamePrefix = prop.substring(0, prop.length - 2);
      return setWithToStringEqualityUnion(
        [...fieldBasedInfo.entries()].filter(([k, _v]) => k.startsWith(propNamePrefix)).map(([_k, v]) => v)
      );
    } else {
      const res: SetWithToStringEquality<AccessPath> = new SetWithToStringEquality();
      fieldBasedInfo.get(prop)?.forEach((ap) => res.add(ap));
      this.fieldBasedInfoWithWildcards.forEach((aps, name) => {
        if (
          (name.startsWith('.*') && prop.endsWith(name.substring(2))) ||
          (name.endsWith('.*') && prop.startsWith(name.substring(0, name.length - 2)))
        ) {
          aps.forEach((ap) => res.add(ap));
        }
      });
      return res;
    }
  }

  private handleBuiltinFunctionCalls(edges: SetWithToStringEquality<CallGraphEdge>, ap: ModuleMainPath) {
    if (ap.estimatedModule === 'Promise') {
      edges.forEach((e) => {
        if (e.args.length < 1) return;
        this.createBuiltinEdge(e.args[0], e.ignoreArguments());
      });
    }
  }

  private createBuiltinEdge(targetAccPaths: SetWithToStringEquality<AccessPath>, edge: CallGraphEdge) {
    targetAccPaths.forEach((ap) => {
      this.getCalleeNodeWithoutCreatingUsageModelsUsingCache(ap).forEach((n) => {
        this.propagateIntermediaryEdge(edge, n, true);
      });
    });
  }

  private handleBuiltinMethodCalls(
    edges: SetWithToStringEquality<CallGraphEdge>,
    prop: string
  ): SetWithToStringEquality<AccessPath> {
    const res = new SetWithToStringEquality<AccessPath>();
    if (['forEach', 'filter', 'map', 'reduce', 'some', 'every', 'catch', 'then', 'sort', 'find'].includes(prop)) {
      edges.forEach((e) => {
        if (e.args.length < 1) return;
        this.createBuiltinEdge(e.args[0], e.ignoreArguments());
      });
    }
    if (['readFile', 'replace'].includes(prop)) {
      edges.forEach((e) => {
        if (e.args.length < 2) return;
        this.createBuiltinEdge(e.args[1], e.ignoreArguments());
      });
    }
    if (['call'].includes(prop)) {
      edges.forEach((e) => e.args.forEach((arg) => this.createBuiltinEdge(arg, e.ignoreArguments())));
    }
    if (prop === 'emit') {
      edges.forEach((e) => {
        e.args[0]?.forEach((arg) => {
          if (
            !(
              arg instanceof StringLiteralAccessPath ||
              arg instanceof StringPrefixAccessPath ||
              arg instanceof StringSuffixAccessPath
            )
          )
            return;
          if (e.args.length < 1) return;
          [...this.eventListenerSummary.entries()].forEach(([k, v]) => {
            let matches = false;
            if (arg instanceof StringLiteralAccessPath) {
              if (k.startsWith('.*')) matches = arg.value.endsWith(k.substring(2));
              else if (k.endsWith('.*')) matches = arg.value.startsWith(k.substring(0, k.length - 2));
              else matches = arg.value === k;
            } else if (arg instanceof StringPrefixAccessPath) {
              if (k.startsWith('.*')) {
                matches = false; // Unknown start with unknown end will always match
              } else if (k.endsWith('.*')) {
                const shortestPrefixLength = Math.min(k.length - 2, arg.prefix.length);
                matches = k.substring(0, shortestPrefixLength) === arg.prefix.substring(0, shortestPrefixLength);
              } else matches = k.startsWith(arg.prefix);
            } else if (arg instanceof StringSuffixAccessPath) {
              if (k.startsWith('.*')) {
                const shortestSuffixLength = Math.min(k.length - 2, arg.suffix.length);
                matches =
                  k.substring(k.length - shortestSuffixLength) ===
                  arg.suffix.substring(arg.suffix.length - shortestSuffixLength);
              } else if (k.endsWith('.*')) {
                matches = false; // Unknown start with unknown end will always match
              } else matches = k.endsWith(arg.suffix);
            }
            if (matches) this.createBuiltinEdge(v, e.removeFirstArg());
          });
        });
      });
    }
    return res;
  }

  getUsageModel(vulnerableLibraryFile: string) {
    return this.usageModels.get(vulnerableLibraryFile);
  }
  private cache: Map<string, Set<CallGraphNode>> = new Map();
  private getCalleeNodeWithoutCreatingUsageModelsUsingCache(ap: AccessPath) {
    if (this.cache.has(ap.toString())) return this.cache.get(ap.toString()) as Set<CallGraphNode>;
    const res = this.getCalleeNodeWithoutCreatingUsageModels(ap);
    this.cache.set(ap.toString(), res);
    return res;
  }

  addCg(cg: CallGraph) {
    joinMaps(this.usageModels, cg.usageModels);
    joinMaps(this.nodes, cg.nodes);
    joinMaps(this.intermediaryNodes, cg.intermediaryNodes);
    joinSets(this.edges_, cg.edges_);
    joinSets(this.intermediaryEdges, cg.intermediaryEdges);
    joinMapSets(this.sourceSLToEdgeMap_, cg.sourceSLToEdgeMap_);
    joinMapSets(this.rho, cg.rho);
    joinMapSets(this.sourceToEdgeMap, cg.sourceToEdgeMap);
    joinMapSets(this.targetToEdgeMap, cg.targetToEdgeMap);
    joinMapSets(this.edgeToTargets_, cg.edgeToTargets_);
    joinMapSets(this.urTargetsToUrSourcesTransitively, cg.urTargetsToUrSourcesTransitively);
    joinMapSets(this.urSourcesToUrTargetsTransitively, cg.urSourcesToUrTargetsTransitively);
    joinMapSets(this.intermediaryTargetToEdge, cg.intermediaryTargetToEdge);
    joinMapSets(this.fieldBasedInfo, cg.fieldBasedInfo);
    joinMapSets(this.fieldBasedInfoWithWildcards, cg.fieldBasedInfoWithWildcards);
    joinMapSets(this.getterInfo, cg.getterInfo);
    joinMapSets(this.funCreationToParamNodes, cg.funCreationToParamNodes);
    joinMapSets(this.eventListenerSummary, cg.eventListenerSummary);
    this.resolvingOrHasResolvedSomeUnresolvedNodes =
      this.resolvingOrHasResolvedSomeUnresolvedNodes || cg.resolvingOrHasResolvedSomeUnresolvedNodes;
  }

  private nodeAccPathCache: Map<string, NodeAccessPath> = new Map();
  public toNodeAccessPath(accessPath: AccessPath): NodeAccessPath {
    const key = accessPath.toString();
    if (!this.nodeAccPathCache.has(key)) {
      const res = this.actualToNodeAccessPath(accessPath);
      this.nodeAccPathCache.set(key, res);
    }
    return this.nodeAccPathCache.get(key) as NodeAccessPath;
  }

  private actualToNodeAccessPath(accessPath: AccessPath): NodeAccessPath {
    if (accessPath instanceof CallAccessPath) return new NodeCallAccessPath(this.toNodeAccessPath(accessPath.callee));
    if (accessPath instanceof PropAccessPath) {
      let library: string | undefined;
      if (this.fieldBasedStrategy === PropertyReadsOnLibraryObjectStrategies.USE_FIELD_BASED_FROM_LIBRARY) {
        const rootElement = accessPath.getRootElement();
        if (
          rootElement instanceof ImportAccessPath &&
          accessPath.isPropReadOnModuleSequence() &&
          rootElement.fileLocation !== BUILT_IN
        )
          library = this.dependencyTree.getEstimatedNpmModule(rootElement.fileLocation);
      }
      return new NodePropAccessPath(
        accessPath,
        this.dependencyTree.getEstimatedNpmModule(accessPath.fileName),
        library
      );
    }
    if (accessPath instanceof ImportAccessPath)
      return new ModuleMainPath(
        accessPath.fileLocation,
        accessPath.fileLocation === BUILT_IN ? accessPath.importPath : undefined
      );
    if (
      accessPath instanceof FunctionCreation ||
      accessPath instanceof ParameterAccessPath ||
      accessPath instanceof ThisAccessPath ||
      accessPath instanceof GetterAccessPath ||
      accessPath instanceof StringLiteralAccessPath
    )
      return accessPath;
    if (accessPath instanceof UnknownAccessPath) return accessPath;
    throw new Error('Unsupported access path: ' + accessPath);
  }

  async init() {
    await this.dependencyTree.init();
  }

  getApsForResolvedCallGraphNodes(apsToResolve: SetWithToStringEquality<AccessPath>) {
    const res = new SetWithToStringEquality();
    apsToResolve.forEach((ap) => this.rho.get(ap)?.forEach((cgn) => res.add(cgn)));
    return [...res]
      .filter((cgn) => cgn instanceof ResolvedCallGraphNode)
      .map((cgn) => (cgn as ResolvedCallGraphNode).node);
  }
}

export async function buildCallGraphFromMain(
  dir: string,
  mainFiles: string[],
  fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies,
  modulesToIgnore?: string[]
): Promise<CallGraph> {
  const cg = new CallGraph(dir, fieldBasedStrategy, modulesToIgnore);
  await cg.init();
  await applySeries(
    mainFiles,
    async (main) => await cg.computeAndAddUsageModel(new ImportAccessPath(main, dir, DummyLocation))
  );
  await cg.computeFieldBasedInfoFromUsageModels();
  return cg;
}

export async function buildCallGraphsForDependencies(
  dir: string,
  fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies
): Promise<CallGraph[]> {
  const packageJsonObj = await PackageOperations.getJsonObject(resolve(dir, 'package.json'));
  const res: CallGraph[] = [];
  await applySeries(Object.keys(packageJsonObj.dependencies), async (d) => {
    if (d === 'handlebars' && dir.includes('toucht@0.0.1')) return;
    if (dir.includes('spotify-terminal@0.1.2') && d !== 'commander') return;
    const mainFile = require.resolve(d, { paths: [dir] });
    const relMainFile = `./${relative(dir, mainFile)}`;
    const cg = await buildCallGraphFromMain(dir, [relMainFile], fieldBasedStrategy);
    await cg.resolveUnresolvedNodes();
    res.push(cg);
  });
  return res;
}

export function joinCallGraphs(callgraphs: CallGraph[]) {
  const resCg = callgraphs[0];
  callgraphs.slice(1).forEach((cg) => {
    resCg.addCg(cg);
  });
  return resCg;
}

export async function extendCallGraphWithMain(dir: string, main: string, cg: CallGraph) {
  await cg.computeAndAddUsageModel(new ImportAccessPath(main, dir, DummyLocation));
  await cg.computeFieldBasedInfoFromUsageModels();
  cg.addNodesToBeRecomputedAfterGraphJoin();
  await cg.resolveUnresolvedNodes();
  return cg;
}

export type SimpleCallGraphNode = ResolvedCallGraphNode | IgnoredModuleCallGraphNode | UnknownCallGraphNode;

export type CallGraphNode = SimpleCallGraphNode | UnresolvedCallGraphNode;

function isSimpleCallGraphNode(n: CallGraphNode): n is SimpleCallGraphNode {
  return (
    n instanceof ResolvedCallGraphNode || n instanceof IgnoredModuleCallGraphNode || n instanceof UnknownCallGraphNode
  );
}

export class ResolvedCallGraphNode {
  readonly node: FunctionCreation | ModuleMainPath;
  readonly stringRepresentation: string;
  constructor(functionCreation: FunctionCreation | ModuleMainPath) {
    this.node = functionCreation;
    this.stringRepresentation = this.computeToString();
  }

  private computeToString() {
    return `${this.node}`;
  }

  toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `${this.node.prettyString()}`;
  }

  sourceLocationString(linesOnly?: boolean): string {
    if (this.node instanceof FunctionCreation) {
      let sourceLocation: SourceLocation;
      sourceLocation = this.node.sourceLocation;
      if (linesOnly) {
        return inFileSourceLocationToStringOnlyLines(sourceLocation);
      }
      return inFileSourceLocationToString(sourceLocation);
    } else {
      return this.node.fileLocation;
    }
  }
}

export class IgnoredModuleCallGraphNode {
  readonly stringRepresentation: string;

  constructor(private readonly fileLocation: string) {
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.fileLocation}`;
  }
  toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `${path.basename(this.fileLocation)}`;
  }

  sourceLocationString(): string {
    return '0:0:0:0';
  }
}

export class UnresolvedCallGraphNode {
  readonly accessPath: NodeAccessPath;
  readonly stringRepresentation: string;
  constructor(accessPath: NodeAccessPath) {
    if (accessPath instanceof CallAccessPath && accessPath.args.length > 0)
      throw new Error('Should not use arguments for node');
    this.accessPath = accessPath;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.accessPath}`;
  }
  toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return this.accessPath.prettyString();
  }
}

export class UnknownCallGraphNode {
  readonly accessPath: UnknownAccessPath;
  readonly stringRepresentation: string;
  constructor(accessPath: UnknownAccessPath) {
    this.accessPath = accessPath;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.accessPath}`;
  }
  toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return this.accessPath.prettyString();
  }
}

/*
 * returns sourceFile:beginLine:beginColumn:endLine:endColumn
 */
export function sourceLocationToString(l: SourceLocation) {
  return `${l.source?.replace(process.cwd(), '.')}:${l.start.line}:${l.start.column}:${l.end.line}:${l.end.column}`;
}

/*
 * returns beginLine:beginColumn:endLine:endColumn
 */
export function inFileSourceLocationToString(sourceLocation: SourceLocation) {
  return `${sourceLocation.start.line}:${sourceLocation.start.column}:${sourceLocation.end.line}:${sourceLocation.end.column}`;
}

/**
 * returns beginLine:endLine
 */
export function inFileSourceLocationToStringOnlyLines(sourceLocation: SourceLocation) {
  return `${sourceLocation.start.line}:${sourceLocation.end.line}`;
}

type NodeAccessPath =
  | NodeCallAccessPath
  | FunctionCreation
  | ImportAccessPath
  | ParameterAccessPath
  | NodePropAccessPath
  | ThisAccessPath
  | UnknownAccessPath
  | GetterAccessPath;

class NodeCallAccessPath {
  readonly callee: NodeAccessPath;
  constructor(accessPath: NodeAccessPath) {
    this.callee = accessPath;
  }

  toString(): string {
    return `${this.callee.toString()}()`;
  }

  prettyString(): string {
    return `${this.callee.prettyString()}()`;
  }
}

class NodePropAccessPath {
  readonly prop: string;
  readonly moduleReadFrom: string;
  readonly library: string | undefined;
  constructor(propAccessPath: PropAccessPath, module: string, library: string | undefined) {
    this.prop = propAccessPath.prop;
    this.moduleReadFrom = module;
    this.library = library;
  }

  toString(): string {
    return `PROP<${this.moduleReadFrom}:${(this.library ? this.library + '...' : '') + this.prop}>`;
  }

  prettyString(): string {
    return this.toString();
  }
}

class GetterAccessPath {
  readonly prop: string;
  constructor(propAccessPath: PropAccessPath) {
    this.prop = propAccessPath.prop;
  }
  toString(): string {
    return `GETTER<${this.prop}>`;
  }

  prettyString(): string {
    return this.toString();
  }
}

function isNodeAccessPath(accessPath: AccessPath | NodeAccessPath): accessPath is NodeAccessPath {
  return (
    accessPath instanceof NodeCallAccessPath ||
    accessPath instanceof NodePropAccessPath ||
    accessPath instanceof ModuleMainPath ||
    accessPath instanceof FunctionCreation ||
    accessPath instanceof ParameterAccessPath ||
    accessPath instanceof ThisAccessPath ||
    accessPath instanceof UnknownAccessPath
  );
}

export class CallGraphEdge {
  readonly source: ResolvedCallGraphNode;
  readonly nodeCallerAccPath: NodeAccessPath;
  readonly args: SetWithToStringEquality<AccessPath>[];
  readonly argsToString: string;
  readonly callSourceLocation: SourceLocation;
  readonly callFile: string;
  readonly stringRepresentation: string;
  constructor(
    source: ResolvedCallGraphNode,
    callerAccPath: NodeAccessPath,
    args: SetWithToStringEquality<AccessPath>[],
    argsToString: string,
    callSourceLocation: SourceLocation,
    callFile: string
  ) {
    this.source = source;
    this.nodeCallerAccPath = callerAccPath;
    this.args = args;
    this.argsToString = argsToString;
    this.callSourceLocation = callSourceLocation;
    this.callFile = callFile;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.source} --${this.nodeCallerAccPath}:${this.argsToString} from ${
      this.callFile
    }:${inFileSourceLocationToString(this.callSourceLocation)}`;
  }
  toString() {
    return this.stringRepresentation;
  }

  ignoreArguments() {
    return this.args.length === 0
      ? this
      : new CallGraphEdge(this.source, this.nodeCallerAccPath, [], '', this.callSourceLocation, this.callFile);
  }

  removeFirstArg() {
    return new CallGraphEdge(
      this.source,
      this.nodeCallerAccPath,
      this.args.slice(1),
      computeArgsString(this.args.slice(1)),
      this.callSourceLocation,
      this.callFile
    );
  }
}

// Is used for module load access paths.
export const DummyLocation = {
  start: {
    line: 0,
    column: 0,
  },
  end: {
    line: 0,
    column: 0,
  },
};

export async function writeCGAsDot(
  outputFile: string,
  nodes: SetWithToStringEquality<CallGraphNode>,
  intermediaryNodes: SetWithToStringEquality<CallGraphNode>,
  edges: SetWithToStringEquality<CallGraphEdge>,
  edgeToTargets: MapWithToStringEquality<CallGraphEdge, SetWithToStringEquality<SimpleCallGraphNode>>,
  intermediaryEdges: SetWithToStringEquality<CallGraphEdge>
) {
  const g = graphviz.digraph('G');

  const map: MapWithToStringEquality<CallGraphNode, graphviz.Node> = new MapWithToStringEquality();

  nodes.forEach((n) => {
    let node;
    if (n instanceof ResolvedCallGraphNode) node = g.addNode(n.node.prettyString());
    else if (n instanceof IgnoredModuleCallGraphNode)
      node = g.addNode(n.prettyString(), { color: 'palegreen', style: 'filled' });
    else node = g.addNode(n.accessPath.prettyString(), { color: 'lightblue', style: 'filled' });
    map.set(n, node);
  });
  edges.forEach((e) => {
    edgeToTargets.get(e)?.forEach((target) => {
      g.addEdge(map.get(e.source) as graphviz.Node, map.get(target) as graphviz.Node, {
        label: `${e.nodeCallerAccPath.prettyString()}\n${path.basename(e.callFile)}:${inFileSourceLocationToString(
          e.callSourceLocation
        )}`,
        //label: `${e.callerAccPath.prettyString()}\n${e.callFile}:${inFileSourceLocationToString(e.callSourceLocation)}`,
      });
    });
  });
  intermediaryNodes.forEach((n) => {
    const node = g.addNode(n.prettyString(), { shape: 'box', color: 'lightblue', style: 'filled' });
    map.set(n, node);
  });
  intermediaryEdges.forEach((e) => {
    edgeToTargets.get(e)?.forEach((target) => {
      g.addEdge(map.get(e.source) as graphviz.Node, map.get(target) as graphviz.Node, {
        label: `${e.nodeCallerAccPath.prettyString()}\n${path.basename(e.callFile)}:${inFileSourceLocationToString(
          e.callSourceLocation
        )}`,
        style: 'dashed',
      });
    });
  });

  const dotOutputFilename = outputFile.replace('png', 'dot');
  console.log(`Printing cg to: ${dotOutputFilename}`);
  const dot = g.to_dot();
  await createDirectoryIfMissing(dirname(outputFile));
  fs.writeFile(dotOutputFilename, dot, (err) => {
    if (err) throw err;
    console.log('Finished writing ' + dotOutputFilename);
  });

  console.log('Number nodes: ' + nodes.size);
  console.log('Number edges: ' + edges.size);

  const printPNG = false;
  if (printPNG) g.output('png', outputFile);

  const sourceTargetStrings: Set<string> = new Set();
  edges.forEach((e) => edgeToTargets.get(e)?.forEach((target) => sourceTargetStrings.add(`${e.source}->${target}`)));
  console.log(`Number edges without duplicates due to different access paths: ${sourceTargetStrings.size}`);
}

export async function getPackageModelFile(file: string) {
  const hash = createHash('sha1');
  const contents = await p(fs.readFile)(file, 'utf-8');
  hash.update(contents);
  return resolve(StaticConfiguration.packageModelOut, `${hash.digest('hex')}-${basename(file)}.json`);
}

type WorkItem =
  | CallGraphEdge
  | [ResolvedCallGraphNode, UnresolvedCallGraphNode]
  | UnresolvedCallGraphNode
  | ResolvedCallGraphNode;

export enum PropertyReadsOnLibraryObjectStrategies {
  USE_DYNAMIC_ANALYSIS,
  USE_FIELD_BASED_FROM_LIBRARY,
  USE_NORMAL_PROPERTY_READ,
}

export function computeArgsString(args: SetWithToStringEquality<AccessPath>[]) {
  return args.map((accPaths) => [...accPaths].join(', ')).join(';');
}
