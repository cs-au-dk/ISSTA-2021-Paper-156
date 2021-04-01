import {
  ArrayExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  AssignmentPattern,
  BaseFunction,
  CallExpression,
  ClassDeclaration,
  Directive,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  ImportDeclaration,
  MemberExpression,
  MethodDefinition,
  ModuleDeclaration,
  NewExpression,
  Node,
  ObjectExpression,
  ObjectPattern,
  Pattern as AstPattern,
  Program,
  Property,
  ReturnStatement,
  SourceLocation,
  Statement,
  VariableDeclaration,
} from 'estree';
import {
  isAnyCreateFunctionNode,
  isArrayExpression,
  isArrowFunctionExpression,
  isAssignmentExpression,
  isAssignmentPattern,
  isBinaryExpression,
  isBlockStatement,
  isCallExpression,
  isClassDeclaration,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportDefaultSpecifier,
  isImportNamespaceSpecifier,
  isImportSpecifier,
  isLogicalExpression,
  isMemberExpression,
  isModuleImport,
  isObjectExpression,
  isObjectPattern,
  isParenthesizedExpression,
  isProgram,
  isProperty,
  isRequireCall,
  isSimpleLiteral,
  isSpreadElement,
  isThisExpression,
  isVariableDeclaration,
} from '../util/ast-utils';
import {
  addAllToMapSetWithStringEquality,
  addToMapSet,
  MapWithToStringEquality,
  SetWithToStringEquality,
  setWithToStringEqualityUnion,
} from '../util/collections';
import {
  AccessPath,
  ArgumentsAccessPath,
  CallAccessPath,
  createImportAccessPath,
  FunctionCreation,
  ImportAccessPath,
  ParameterAccessPath,
  PropAccessPath,
  StringLiteralAccessPath,
  StringPrefixAccessPath,
  StringSuffixAccessPath,
  ThisAccessPath,
  unknownAccessPathInstance,
} from './access-path';
import { parseFileWithAcorn } from '../util/parsing';
import { PackageModel, UsageModel } from './usage-model';
import { dirname, normalize, relative, resolve } from 'path';
import {
  buildCallGraphFromMain,
  DummyLocation,
  getPackageModelFile,
  PropertyReadsOnLibraryObjectStrategies,
} from './compute-call-graph';
import { existsSync, readFile } from 'fs';
import { promisify as p } from 'util';
import { createDirectoryIfMissing } from '../util/file';
import { runAnalysis } from '../node-prof-analyses/analysis';
import { recursive, simple } from 'acorn-walk';

export class ModelGenerator {
  readonly module: Program;
  readonly fileName: string;
  readonly dir: string;
  private unknownRequires: Set<ImportAccessPath>;
  private declarationAnalysisResults: Map<Identifier, Node> | undefined;
  private declaredVariableNames: Set<string>;
  private aliasAnalysisResults: Map<Node | string, Set<Node>> | undefined;
  private fieldBasedWithWildcards: Map<string, Set<Node>>;
  private computeAccessPathsResults: Map<Node, SetWithToStringEquality<AccessPath>> | undefined;
  private moduleNameToVariableMap: Map<string, string> | undefined;
  private functionUsageSummary:
    | MapWithToStringEquality<FunctionCreation | ImportAccessPath, SetWithToStringEquality<AccessPath>>
    | undefined;
  private functionReturnSummary:
    | MapWithToStringEquality<FunctionCreation | ImportAccessPath, SetWithToStringEquality<AccessPath>>
    | undefined;
  private treatRelativeRequiresAsUnknown: boolean;
  private requireAliases: Set<string>;

  constructor(dir: string, fileName: string, module: Program, treatRelativeRequiresAsUnknown = false) {
    this.dir = dir;
    this.fileName = fileName;
    this.module = module;
    this.unknownRequires = new Set();
    this.declaredVariableNames = new Set();
    this.treatRelativeRequiresAsUnknown = treatRelativeRequiresAsUnknown;
    this.requireAliases = new Set();
    this.fieldBasedWithWildcards = new Map();
  }

  public static async createTapirFromFileName(dir: string, fileName: string) {
    return new ModelGenerator(dir, fileName, await parseFileWithAcorn(fileName), false);
  }

  public getDeclAnalysisResults(): Map<Identifier, Node> {
    if (!this.declarationAnalysisResults) throw new Error('The declaration analysis has not been run yet.');
    return this.declarationAnalysisResults;
  }

  public getModuleNameToVariableMap(): Map<string, string> {
    if (!this.moduleNameToVariableMap) throw new Error('The declaration analysis has not been run yet.');
    return this.moduleNameToVariableMap;
  }

  public getDeclaredVariableNames(): Set<string> {
    return this.declaredVariableNames;
  }

  public getAliasAnalysisResults(): Map<Node | string, Set<Node>> {
    if (!this.aliasAnalysisResults) throw new Error('The alias analysis has not been run yet.');
    return this.aliasAnalysisResults;
  }

  public getComputeAccessPathsResults(): Map<Node, SetWithToStringEquality<AccessPath>> {
    if (!this.computeAccessPathsResults) throw new Error('The compute access paths phase has not been run yet.');
    return this.computeAccessPathsResults;
  }

  public getFunctionUsageSummaryResults(): MapWithToStringEquality<
    FunctionCreation | ImportAccessPath,
    SetWithToStringEquality<AccessPath>
  > {
    if (!this.functionUsageSummary) throw new Error('The compute function summaries phase has not been run yet.');
    return this.functionUsageSummary;
  }

  public getFunctionReturnSummaryResults(): MapWithToStringEquality<
    FunctionCreation | ImportAccessPath,
    SetWithToStringEquality<AccessPath>
  > {
    if (!this.functionReturnSummary) throw new Error('The compute function summaries phase has not been run yet.');
    return this.functionReturnSummary;
  }

  public getUnknownRequires(): Set<ImportAccessPath> {
    if (!this.computeAccessPathsResults) throw new Error('The compute access paths phase has not been run yet.');
    return this.unknownRequires;
  }

  public declarationAnalysis(): Map<Identifier, Node> {
    const res: Map<Identifier, Node> = new Map();
    const moduleNameToVariable: Map<string, string> = new Map();
    const tapir = this;

    function handleParams(params: AstPattern[], node: Node, state: Map<string, Node>) {
      state.set('arguments', node);
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        const paramInfo = { declNode: node, paramNumber: i };
        if (isIdentifier(p)) {
          tapir.declaredVariableNames.add(p.name);
          // @ts-ignore
          p.PARAM_INFO = paramInfo;
          state.set(p.name, p);
        } else if (isObjectPattern(p)) {
          p.properties.forEach((prop) => {
            // @ts-ignore
            if (isIdentifier(prop.key)) {
              // @ts-ignore
              tapir.declaredVariableNames.add(prop.key.name);
              // @ts-ignore
              prop.PARAM_INFO = paramInfo;
              // @ts-ignore
              state.set(prop.key.name, prop);
            }
          });
        } else if (isAssignmentPattern(p)) {
          const left = (p as AssignmentPattern).left;
          if (isIdentifier(left)) {
            tapir.declaredVariableNames.add(left.name);
            // @ts-ignore
            left.PARAM_INFO = paramInfo;
            state.set(left.name, left);
          }
        }
      }
    }

    function addFunAndVarDeclsToState(body: (Directive | Statement | ModuleDeclaration)[], state: Map<string, Node>) {
      body
        .filter(isFunctionDeclaration)
        .filter((n) => (n as FunctionDeclaration).id)
        .forEach((n) => state.set((n.id as Identifier).name, n));
      body.filter(isVariableDeclaration).forEach((varDecl) => {
        (varDecl as VariableDeclaration).declarations.forEach((declarator) => {
          const id = declarator.id;
          if (isIdentifier(id)) {
            state.set(id.name, declarator);
          }
          if (isObjectPattern(id))
            // @ts-ignore
            id.properties.filter((p) => isIdentifier(p.value)).forEach((p) => state.set(p.value.name, p));
        });
      });
      body
        .filter(isClassDeclaration)
        .filter((n) => isIdentifier(n.id))
        .forEach((n) => state.set((n.id as Identifier).name, n));
    }
    const state = new Map();
    addFunAndVarDeclsToState(this.module.body, state);
    recursive(this.module, state, {
      ImportDeclaration: (node: ImportDeclaration, state: Map<string, Node>) => {
        node.specifiers.forEach((spec) => {
          tapir.declaredVariableNames.add(spec.local.name);
          state.set(spec.local.name, spec);
          // @ts-ignore
          spec.SOURCE = node.source.value;
        });
        node.specifiers
          .filter((spec) => isImportDefaultSpecifier(spec) || isImportNamespaceSpecifier(spec))
          .forEach((spec) => {
            // @ts-ignore
            moduleNameToVariable.set(node.source.value, spec.local.name);
          });
      },
      VariableDeclaration: (node: VariableDeclaration, state: Map<string, Node>, c: any) => {
        node.declarations
          .filter((decl) => isIdentifier(decl.id))
          .forEach((decl) => {
            tapir.declaredVariableNames.add((decl.id as Identifier).name);
            state.set((decl.id as Identifier).name, decl);
            if (isIdentifier(decl.init) && decl.init.name === 'require')
              tapir.requireAliases.add((decl.id as Identifier).name);
          });
        node.declarations
          .filter((decl) => isObjectPattern(decl.id))
          .forEach((decl) =>
            (decl.id as ObjectPattern).properties.forEach((p) => {
              // @ts-ignore
              if (isIdentifier(p.value)) {
                // @ts-ignore
                tapir.declaredVariableNames.add(p.value.name);
                // @ts-ignore
                state.set(p.value.name, p);
                // @ts-ignore
                p.INIT_EXP = decl.init;
              }
            })
          );
        node.declarations
          .filter((decl) => isIdentifier(decl.id))
          .filter((decl) => isRequireCall(decl.init, tapir.requireAliases))
          .forEach((decl) => {
            // @ts-ignore
            moduleNameToVariable.set(decl.init.arguments[0].value as string, decl.id.name);
          });
        node.declarations.filter((decl) => !!decl.init).forEach((decl) => c(decl.init, state));
      },
      FunctionDeclaration: (node: FunctionDeclaration, state: Map<string, Node>, c: any) => {
        const newState = new Map(state);
        handleParams(node.params, node, newState);
        addFunAndVarDeclsToState(node.body.body, newState);
        c(node.body, newState);
      },
      FunctionExpression: (node: FunctionExpression, state: Map<string, Node>, c: any) => {
        const newState = new Map(state);
        if (isIdentifier(node.id)) newState.set(node.id.name, node);
        handleParams(node.params, node, newState);
        addFunAndVarDeclsToState(node.body.body, newState);
        c(node.body, newState);
      },
      ArrowFunctionExpression: (node: ArrowFunctionExpression, state: Map<string, Node>, c: any) => {
        const newState = new Map(state);
        handleParams(node.params, node, newState);
        if (isBlockStatement(node.body)) addFunAndVarDeclsToState(node.body.body, newState);
        c(node.body, newState);
      },
      Identifier: (node: Identifier, state: Map<string, Node>) => {
        if (!state.has(node.name)) {
          return;
        }
        res.set(node, state.get(node.name) as Node);
      },
      AssignmentExpression: (node: AssignmentExpression, state: Map<string, Node>, c: any) => {
        if (isIdentifier(node.left) && !state.has(node.left.name)) {
          state.set(node.left.name, node);
          res.set(node.left, node);
        } else if (isIdentifier(node.left) && state.has(node.left.name)) {
          res.set(node.left, state.get(node.left.name) as Node);
        } else if (
          isMemberExpression(node.left) &&
          isIdentifier(node.left.object) &&
          state.has(node.left.object.name)
        ) {
          res.set(node.left.object, state.get(node.left.object.name) as Node);
        }
        if (isRequireCall(node.right, tapir.requireAliases) && isIdentifier(node.left))
          // @ts-ignore
          moduleNameToVariable.set(node.right.arguments[0].value as string, node.left.name);
        c(node.left, state);
        c(node.right, state);
      },
      ClassDeclaration: (node: ClassDeclaration, state: Map<string, Node>, c: any) => {
        if (!isIdentifier(node.id)) return;
        node.body.body
          .filter((md) => !md.computed && isIdentifier(md.key))
          .forEach((md) => {
            state.set((md.key as Identifier).name, md);
          });
        c(node.body, state);
      },
    });
    this.declarationAnalysisResults = res;
    this.moduleNameToVariableMap = moduleNameToVariable;
    return res;
  }

  public aliasAnalysis(): Map<Node | string, Set<Node>> {
    if (!this.declarationAnalysisResults) this.declarationAnalysis();
    const res: Map<Node | string, Set<Node>> = new Map();
    const tapir = this;
    simple(this.module, {
      ImportDeclaration: (node: ImportDeclaration) => {
        node.specifiers.forEach((spec) => addToMapSet(res, spec, spec));
      },
      VariableDeclaration: (node: VariableDeclaration) => {
        node.declarations
          .filter((decl) => isIdentifier(decl.id))
          .filter((decl) => !!decl.init)
          .forEach((decl) => addToMapSet(res, decl, decl.init));
        node.declarations
          .filter((decl) => isObjectPattern(decl.id))
          .filter((decl) => !!decl.init)
          .forEach((decl) => (decl.id as ObjectPattern).properties.forEach((p) => addToMapSet(res, p, p)));
      },
      AssignmentExpression: (node: AssignmentExpression) => {
        if (isIdentifier(node.left) && tapir.getDeclAnalysisResults().has(node.left)) {
          addToMapSet(res, tapir.getDeclAnalysisResults().get(node.left), node.right);
        } else if (isMemberExpression(node.left)) {
          if (!node.left.computed && isIdentifier(node.left.property) && typeof node.left.property.name === 'string')
            addToMapSet(res, node.left.property.name, node.right);
          else if (node.left.computed) {
            if (isSimpleLiteral(node.left.property) && typeof node.left.property.value === 'string')
              addToMapSet(res, node.left.property.value, node.right);
            else if (isBinaryExpression(node.left.property) && node.left.property.operator === '+') {
              if (isSimpleLiteral(node.left.property.left) && typeof node.left.property.left.value === 'string') {
                addToMapSet(tapir.fieldBasedWithWildcards, `${node.left.property.left.value}.*`, node.right);
              } else if (
                isSimpleLiteral(node.left.property.right) &&
                typeof node.left.property.right.value === 'string'
              )
                addToMapSet(tapir.fieldBasedWithWildcards, `.*${node.left.property.right.value}`, node.right);
            }
          }
        }
      },
      ObjectExpression: (exp: ObjectExpression) => {
        // @ts-ignore
        exp.properties
          .filter((prop) => isProperty(prop) && isIdentifier(prop.key))
          .forEach((prop) => addToMapSet(res, ((prop as Property).key as Identifier).name, (prop as Property).value));
      },
      MethodDefinition: (exp: MethodDefinition) => {
        if (isIdentifier(exp.key)) addToMapSet(res, exp.key.name, exp.value);
      },
      ClassDeclaration: (exp: ClassDeclaration) => {
        if (!isIdentifier(exp.id)) return;
        const constructor = exp.body.body.find((md) => isIdentifier(md.key) && md.key.name === 'constructor');
        if (!constructor) return;
        addToMapSet(res, exp.id.name, constructor.value);
      },
    });
    this.aliasAnalysisResults = res;
    return res;
  }

  public computeAccessPathsPhase(): Map<Node, SetWithToStringEquality<AccessPath>> {
    if (!this.aliasAnalysisResults) this.aliasAnalysis();
    const res: Map<Node, SetWithToStringEquality<AccessPath>> = new Map();
    const tapir = this;

    function defaultVisitor(node: Node) {
      res.set(node, tapir.computeAccessPaths(node, tapir));
    }

    simple(this.module, {
      FunctionDeclaration: defaultVisitor,
      FunctionExpression: defaultVisitor,
      ArrowFunctionExpression: defaultVisitor,
      MemberExpression: (node: MemberExpression) => {
        if (
          node.computed &&
          !(
            isIdentifier(node.object) &&
            node.object.name === 'arguments' &&
            isSimpleLiteral(node.property) &&
            typeof node.property.value === 'number'
          )
        )
          return;
        defaultVisitor(node);
      },
      CallExpression: (node: CallExpression) => {
        let accessPathNode;
        let isImpreciseArguments = node.arguments.some((a) => isSpreadElement(a));
        if (
          isMemberExpression(node.callee) &&
          isIdentifier(node.callee.property) &&
          ['call', 'apply'].includes(node.callee.property.name)
        ) {
          accessPathNode = (node.callee as MemberExpression).object;
          isImpreciseArguments = isImpreciseArguments || node.callee.property.name === 'apply';
        } else if (isRequireCall(node, tapir.requireAliases)) accessPathNode = node;
        else accessPathNode = node.callee;
        let argAccPaths: SetWithToStringEquality<AccessPath>[];
        if (
          isMemberExpression(node.callee) &&
          isIdentifier(node.callee.property) &&
          node.callee.property.name === 'apply'
        )
          argAccPaths = this.computeApplyArguments(node);
        else {
          const isCallToCall =
            isMemberExpression(node.callee) &&
            isIdentifier(node.callee.property) &&
            node.callee.property?.name === 'call';
          argAccPaths = (isCallToCall ? node.arguments.slice(1) : node.arguments).map((arg) =>
            tapir.computeAccessPaths(arg, tapir)
          );
        }
        if (!isRequireCall(node, tapir.requireAliases))
          res.set(
            node,
            new SetWithToStringEquality(
              [...tapir.computeAccessPaths(accessPathNode, tapir)].map(
                (acp) =>
                  new CallAccessPath(acp, argAccPaths, node.loc as SourceLocation, tapir.fileName, isImpreciseArguments)
              )
            )
          );
        else res.set(node, tapir.computeAccessPaths(accessPathNode, tapir));
      },
      NewExpression: (node: NewExpression) => {
        const argAccPaths = node.arguments.map((arg) => tapir.computeAccessPaths(arg, tapir));
        res.set(
          node,
          new SetWithToStringEquality(
            [...tapir.computeAccessPaths(node.callee, tapir)].map(
              (acp) => new CallAccessPath(acp, argAccPaths, node.loc as SourceLocation, tapir.fileName)
            )
          )
        );
      },
      Identifier: defaultVisitor,
      AssignmentExpression: (node: AssignmentExpression) => {
        res.set(node, tapir.computeAccessPaths(node.left, tapir, true));
      },
      ImportDeclaration: (node: ImportDeclaration) => {
        node.specifiers.forEach((spec) => res.set(spec, tapir.computeAccessPaths(spec, tapir)));
        res.set(node, tapir.computeAccessPaths(node, tapir));
      },
      LogicalExpression: defaultVisitor,
      ConditionalExpression: defaultVisitor,
    });
    this.computeAccessPathsResults = res;
    return res;
  }

  public computeAccessPaths(
    node: Node,
    tapir: ModelGenerator,
    _isAssignmentNode?: boolean,
    useFieldBased?: boolean
  ): SetWithToStringEquality<AccessPath> {
    function lookup(x: Node | string, visited: Set<Node | string>): SetWithToStringEquality<AccessPath> {
      const res: SetWithToStringEquality<AccessPath> = new SetWithToStringEquality();
      // @ts-ignore
      if (x.PARAM_INFO) {
        // @ts-ignore
        const { declNode, paramNumber } = x.PARAM_INFO;
        res.add(
          new ParameterAccessPath(new FunctionCreation(declNode.loc || declNode.body.loc, tapir.fileName), paramNumber)
        );
      }
      if (!tapir.getAliasAnalysisResults().has(x)) {
        // @ts-ignore
        if (x.PARAM_INFO) {
          return res;
        }
        return typeof x === 'string'
          ? new SetWithToStringEquality()
          : new SetWithToStringEquality([unknownAccessPathInstance]);
      }
      if (visited.has(x)) return new SetWithToStringEquality();
      if (typeof x === 'string' && (tapir.getAliasAnalysisResults().get(x) as Set<Node>).size > 30)
        return new SetWithToStringEquality([unknownAccessPathInstance]);
      visited.add(x);
      return setWithToStringEqualityUnion(
        [...(tapir.getAliasAnalysisResults().get(x) as Set<Node>)]
          .map((n) => computePaths(n, new Set(visited)))
          .concat(res)
      );
    }

    function computePaths(n: Node, visited: Set<Node | string>): SetWithToStringEquality<AccessPath> {
      let res: SetWithToStringEquality<AccessPath>;
      if (isModuleImport(n, tapir.requireAliases)) {
        res = new SetWithToStringEquality([tapir.getImportAccessPath(n)]);
      } else if (isMemberExpression(n) && computePropNameFromMemberExpression(n)) {
        let propName = computePropNameFromMemberExpression(n) as string;
        res = new SetWithToStringEquality(
          [...computePaths(n.object, new Set(visited))].map(
            (acc) => new PropAccessPath(acc, propName, n.loc as SourceLocation, tapir.fileName, tapir.dir)
          )
        );
        // if (node !== n || !isAssignmentNode)
        if (useFieldBased) [...lookup(propName, visited)].forEach((acc) => res.add(acc));
      } else if (
        isMemberExpression(n) &&
        isIdentifier(n.object) &&
        n.object.name === 'arguments' &&
        isSimpleLiteral(n.property) &&
        typeof n.property.value === 'number'
      ) {
        const funDeclNode = tapir.getDeclAnalysisResults().get(n.object) as BaseFunction;
        const parameterAccessPath = new ParameterAccessPath(
          new FunctionCreation(funDeclNode.loc as SourceLocation, tapir.fileName),
          n.property.value
        );
        res = new SetWithToStringEquality<AccessPath>([parameterAccessPath]);
      } else if (isIdentifier(n)) {
        if (!tapir.getDeclAnalysisResults().has(n)) {
          res = new SetWithToStringEquality([
            Object.keys(globalObjects).includes(n.name)
              ? globalObjects[n.name](n.loc as SourceLocation, tapir.fileName)
              : unknownAccessPathInstance,
          ]);
        } else if (isAnyCreateFunctionNode(tapir.getDeclAnalysisResults().get(n))) {
          const acc = new FunctionCreation(
            (tapir.getDeclAnalysisResults().get(n) as BaseFunction).loc as SourceLocation,
            tapir.fileName
          );
          res = new SetWithToStringEquality([n.name === 'arguments' ? new ArgumentsAccessPath(acc) : acc]);
        } else if (isClassDeclaration(tapir.getDeclAnalysisResults().get(n))) {
          const classDecl: ClassDeclaration = tapir.getDeclAnalysisResults().get(n) as ClassDeclaration;
          const constructor = classDecl.body.body.find((md) => isIdentifier(md.key) && md.key.name === 'constructor');
          res = constructor
            ? computePaths(constructor?.value, visited)
            : new SetWithToStringEquality([unknownAccessPathInstance]);
        } else res = lookup(tapir.getDeclAnalysisResults().get(n) as Node, visited);
      } else if (isCallExpression(n)) {
        const argAccPaths = n.arguments.map((arg) => computePaths(arg, visited));
        const calleeAccPaths = [...computePaths(n.callee, visited)];
        res = new SetWithToStringEquality(
          calleeAccPaths.map((acc) => new CallAccessPath(acc, argAccPaths, n.loc as SourceLocation, tapir.fileName))
        );
        calleeAccPaths
          .filter((callee) => callee instanceof PropAccessPath && callee.prop === 'bind')
          .forEach((callee) => res.add((callee as PropAccessPath).receiver));
      } else if (isProperty(n)) {
        // @ts-ignore
        const accPaths = computePaths(n.INIT_EXP, visited);
        res = new SetWithToStringEquality(
          [...accPaths].map(
            (accPath) =>
              new PropAccessPath(
                accPath,
                (n.key as Identifier).name,
                n.loc as SourceLocation,
                tapir.fileName,
                tapir.dir
              )
          )
        );
      } else if (isArrayExpression(n)) {
        res = new SetWithToStringEquality([globalObjects.Array(n.loc as SourceLocation, tapir.fileName)]);
      } else if (isObjectExpression(n)) {
        res = new SetWithToStringEquality([globalObjects.Object(n.loc as SourceLocation, tapir.fileName)]);
      } else if (isParenthesizedExpression(n)) {
        // @ts-ignore
        res = new SetWithToStringEquality(computePaths(n.expression, visited));
      } else if (isThisExpression(n)) {
        res = new SetWithToStringEquality([new ThisAccessPath()]);
      } else if (isAnyCreateFunctionNode(n)) {
        res = new SetWithToStringEquality([
          new FunctionCreation(n.loc || (n.body.loc as SourceLocation), tapir.fileName),
        ]);
      } else if (isLogicalExpression(n)) {
        res = setWithToStringEqualityUnion([computePaths(n.left, visited), computePaths(n.right, visited)]);
      } else if (isConditionalExpression(n)) {
        res = setWithToStringEqualityUnion([computePaths(n.consequent, visited), computePaths(n.alternate, visited)]);
      } else if (isAssignmentExpression(n)) {
        res = new SetWithToStringEquality(computePaths(n.right, visited));
      } else if (isSimpleLiteral(n) && typeof n.value === 'string') {
        res = new SetWithToStringEquality([new StringLiteralAccessPath(n.value)]);
      } else if (
        isBinaryExpression(n) &&
        n.operator === '+' &&
        isSimpleLiteral(n.left) &&
        typeof n.left.value === 'string'
      ) {
        res = new SetWithToStringEquality([new StringPrefixAccessPath(n.left.value)]);
      } else if (
        isBinaryExpression(n) &&
        n.operator === '+' &&
        isSimpleLiteral(n.right) &&
        typeof n.right.value === 'string'
      ) {
        res = new SetWithToStringEquality([new StringSuffixAccessPath(n.right.value)]);
      } else if (isClassDeclaration(n)) {
        const constructor = n.body.body.find((md) => isIdentifier(md.key) && md.key.name === 'constructor');
        res = constructor
          ? computePaths(constructor, visited)
          : new SetWithToStringEquality([unknownAccessPathInstance]);
      } else {
        res = new SetWithToStringEquality([unknownAccessPathInstance]);
      }
      return res;
    }

    return computePaths(node, new Set());
  }

  private getImportAccessPath(n: Node): AccessPath {
    let importString = undefined;
    if (
      isRequireCall(n, this.requireAliases) &&
      isSimpleLiteral(n.arguments[0]) &&
      typeof n.arguments[0].value === 'string'
    ) {
      importString = n.arguments[0].value;
    } else if (isImportDefaultSpecifier(n) || isImportNamespaceSpecifier(n) || isImportSpecifier(n)) {
      // @ts-ignore
      importString = n.SOURCE;
    } else if (isImportDeclaration(n)) {
      // @ts-ignore
      importString = n.source.value;
    }
    if (!importString || (this.treatRelativeRequiresAsUnknown && importString.startsWith('.')))
      return unknownAccessPathInstance;
    const importAccessPath = createImportAccessPath(
      importString,
      resolve(this.dir, dirname(this.fileName)),
      n.loc as SourceLocation,
      this.fileName
    );
    if (isImportSpecifier(n))
      return new PropAccessPath(importAccessPath, n.local.name, n.loc as SourceLocation, this.fileName, this.dir);
    return importAccessPath;
  }

  public computeFunctionSummaries() {
    if (!this.computeAccessPathsResults) this.computeAccessPathsPhase();
    const functionUsageSummary: MapWithToStringEquality<
      FunctionCreation | ImportAccessPath,
      SetWithToStringEquality<AccessPath>
    > = new MapWithToStringEquality();
    const functionReturnSummary: MapWithToStringEquality<
      FunctionCreation | ImportAccessPath,
      SetWithToStringEquality<AccessPath>
    > = new MapWithToStringEquality();
    const importAccessPath = new ImportAccessPath(this.fileName, this.dir, DummyLocation);
    functionUsageSummary.set(importAccessPath, new SetWithToStringEquality());
    functionReturnSummary.set(importAccessPath, new SetWithToStringEquality());
    const accPathResults = this.getComputeAccessPathsResults();
    const tapir = this;
    function addAccPathsForNodeToMap(
      n: Node,
      map: MapWithToStringEquality<FunctionCreation | ImportAccessPath, SetWithToStringEquality<AccessPath>>,
      state: FunctionCreation | ImportAccessPath
    ) {
      if (accPathResults.has(n))
        addAllToMapSetWithStringEquality(map, state, accPathResults.get(n) as SetWithToStringEquality<AccessPath>);
    }
    function addAccPathsForNodeToBetaFunDecl(n: Node, state: FunctionCreation | ImportAccessPath) {
      addAccPathsForNodeToMap(n, functionUsageSummary, state);
    }
    function addAccPathsForNodeToBetaReturns(n: Node, state: FunctionCreation | ImportAccessPath) {
      addAccPathsForNodeToMap(n, functionReturnSummary, state);
    }
    function computeBetaForBaseFunction(node: BaseFunction, state: FunctionCreation | ImportAccessPath, c: any) {
      const functionCreation = new FunctionCreation(node.loc || (node.body.loc as SourceLocation), tapir.fileName);
      functionUsageSummary.set(functionCreation, new SetWithToStringEquality());
      functionReturnSummary.set(functionCreation, new SetWithToStringEquality());
      if (isArrowFunctionExpression(node) && !isBlockStatement(node.body)) {
        addAccPathsForNodeToBetaReturns(node.body, state);
      }
      c(node.body, functionCreation);
    }

    recursive(this.module, importAccessPath, {
      FunctionDeclaration: computeBetaForBaseFunction,
      FunctionExpression: computeBetaForBaseFunction,
      ArrowFunctionExpression: computeBetaForBaseFunction,
      MemberExpression: function (node: MemberExpression, state: FunctionCreation | ImportAccessPath, c: any) {
        addAccPathsForNodeToBetaFunDecl(node, state);
        c(node.object, state);
        c(node.property, state);
      },
      CallExpression: function (node: CallExpression, state: FunctionCreation | ImportAccessPath, c: any) {
        addAccPathsForNodeToBetaFunDecl(node, state);
        c(node.callee, state);
        node.arguments.forEach((a) => c(a, state));
      },
      NewExpression: function (node: NewExpression, state: FunctionCreation | ImportAccessPath, c: any) {
        addAccPathsForNodeToBetaFunDecl(node, state);
        c(node.callee, state);
        node.arguments.forEach((a) => c(a, state));
      },
      // visitIdentifier: function (this: any, path: any) {
      //     this.traverse(path);
      //     if (isMemberExpression(path.parent.node) && path.node === path.parent.node.property)
      //         return; // Do not mark prop name identifier as a usage. It is properly handled in visitMemberExpression
      //     addAccPathsForNodeToBetaFunDecl(path.node);
      // },
      AssignmentExpression: function (node: AssignmentExpression, state: FunctionCreation | ImportAccessPath, c: any) {
        addAccPathsForNodeToBetaFunDecl(node, state);
        c(node.left, state);
        c(node.right, state);
      },
      ImportDeclaration: function (node: ImportDeclaration, state: FunctionCreation | ImportAccessPath) {
        node.specifiers.forEach((spec) => addAccPathsForNodeToBetaFunDecl(spec, state));
        addAccPathsForNodeToBetaFunDecl(node, state);
      },
      ReturnStatement: function (node: ReturnStatement, state: FunctionCreation | ImportAccessPath, c: any) {
        if (!node.argument) return;
        addAccPathsForNodeToBetaReturns(node.argument as Node, state);
        c(node.argument, state);
      },
    });
    this.functionUsageSummary = functionUsageSummary;
    this.functionReturnSummary = functionReturnSummary;
    return {
      functionUsageSummary: functionUsageSummary,
      functionReturnSummary: functionReturnSummary,
    };
  }

  public computeUnknownRequires(module: Program): Set<ImportAccessPath> {
    const res: Set<ImportAccessPath> = new Set();
    const tapir = this;
    simple(module, {
      CallExpression: function (n: CallExpression) {
        n.arguments
          .filter(isCallExpression)
          .filter((arg) => isRequireCall(arg, tapir.requireAliases))
          .map((n) => n.arguments[0])
          .forEach((requireArg) => {
            if (isSimpleLiteral(requireArg) && typeof requireArg.value === 'string') {
              const accPath = createImportAccessPath(
                requireArg.value,
                resolve(tapir.dir, dirname(tapir.fileName)),
                n.loc as SourceLocation
              );
              if (accPath instanceof ImportAccessPath) res.add(accPath);
            }
          });
      },
    });
    this.unknownRequires = res;
    return res;
  }

  computeUsageModelFromPackageModel(packageModel: PackageModel): UsageModel {
    if (!this.functionUsageSummary) this.computeFunctionSummaries();
    // const functionsWithSummary = [...this.getFunctionUsageSummaryResults().keys()];
    const locationMapper = this.computeLocationMapper();
    const exportsObject: Map<string, Set<FunctionCreation | ImportAccessPath>> = new Map();
    if (packageModel) {
      Object.keys(packageModel).forEach((k) => {
        const model = packageModel[k];
        if (typeof model === 'object') {
          const key = this.getStartLocString(model);
          const funCreationLoc = locationMapper.has(key)
            ? (locationMapper.get(key) as SourceLocation)
            : {
                start: model.start,
                end: model.end,
              };
          addToMapSet(exportsObject, k, new FunctionCreation(funCreationLoc, model.source as string));
          // model is a 'string' here.
        } else if (['string', 'number', 'boolean', 'object', 'undefined', 'symbol', 'regexp'].includes(model)) {
          exportsObject.set(k, new Set());
        } else {
          const builtinName = model.includes('.') ? model.substring(0, model.indexOf('.')) : model;
          if (!globalObjects[builtinName]) throw new Error(`No global object for: ${builtinName}`);
          addToMapSet(exportsObject, k, globalObjects[builtinName](DummyLocation, this.fileName));
        }
      });
    }
    const gettersSummary = this.getGetterSummary();
    const eventListenerSummary = this.getEventListenerSummary();
    const functionUsageSummaries = this.getFunctionUsageSummaryResults();
    const functionReturnSummaries = this.getFunctionReturnSummaryResults();
    const fieldBasedSummary: Map<string, SetWithToStringEquality<AccessPath>> = new Map();
    const accPathResults = this.getComputeAccessPathsResults();
    [...this.aliasAnalysisResults]
      .filter(([key, _accPaths]: [string | Node, Set<Node>]) => typeof key === 'string')
      .forEach(([key, nodes]) =>
        [...nodes]
          .filter((n) => accPathResults.has(n))
          .forEach((n) =>
            addAllToMapSetWithStringEquality(
              fieldBasedSummary,
              key,
              accPathResults.get(n) as SetWithToStringEquality<AccessPath>
            )
          )
      );
    const fieldBasedSummaryWithWildcards: Map<string, SetWithToStringEquality<AccessPath>> = new Map();
    this.fieldBasedWithWildcards.forEach((nodes, key) =>
      [...nodes]
        .filter((n) => accPathResults.has(n))
        .forEach((n) =>
          addAllToMapSetWithStringEquality(
            fieldBasedSummaryWithWildcards,
            key,
            accPathResults.get(n) as SetWithToStringEquality<AccessPath>
          )
        )
    );
    return new UsageModel(
      exportsObject,
      functionUsageSummaries,
      functionReturnSummaries,
      fieldBasedSummary,
      fieldBasedSummaryWithWildcards,
      gettersSummary,
      eventListenerSummary
    );
  }

  private getGetterSummary(): Map<string, SetWithToStringEquality<AccessPath>> {
    const res: Map<string, SetWithToStringEquality<AccessPath>> = new Map();
    const accPathResults = this.computeAccessPathsResults as Map<Node, SetWithToStringEquality<AccessPath>>;
    simple(this.module, {
      CallExpression: (n: CallExpression) => {
        if (!accPathResults?.has(n)) return;
        const isDefinePropertyCall = [...accPathResults.get(n)]
          .map((ap) => (ap as CallAccessPath).callee)
          .some(
            (ap) =>
              ap instanceof PropAccessPath &&
              ap.prop === 'defineProperty' &&
              ap.receiver instanceof ImportAccessPath &&
              ap.receiver.importPath === 'Object'
          );
        if (!isDefinePropertyCall || n.arguments.length !== 3) return;
        if (
          !(isSimpleLiteral(n.arguments[1]) && typeof n.arguments[1].value === 'string') ||
          !isObjectExpression(n.arguments[2])
        )
          return;
        const propName = n.arguments[1].value;
        const obj = n.arguments[2];
        obj.properties.forEach((prop) => {
          const key = (prop as any).key;
          if (!isIdentifier(key)) return;
          const value = (prop as any).value;
          const valueAccPaths = accPathResults.get(value);
          if (!valueAccPaths) return;
          if (key.name === 'get') addAllToMapSetWithStringEquality(res, propName, valueAccPaths);
        });
      },
    });
    return res;
  }

  private getEventListenerSummary(): Map<string, SetWithToStringEquality<AccessPath>> {
    const res: Map<string, SetWithToStringEquality<AccessPath>> = new Map();
    const accPathResults = this.computeAccessPathsResults as Map<Node, SetWithToStringEquality<AccessPath>>;
    simple(this.module, {
      CallExpression: (n: CallExpression) => {
        const isCallToOnMethod =
          isMemberExpression(n.callee) &&
          !n.callee.computed &&
          isIdentifier(n.callee.property) &&
          n.callee.property.name === 'on' &&
          n.arguments.length === 2;
        if (!isCallToOnMethod) return;
        if (
          isSimpleLiteral(n.arguments[0]) &&
          typeof n.arguments[0].value === 'string' &&
          accPathResults.has(n.arguments[1])
        )
          addAllToMapSetWithStringEquality(
            res,
            n.arguments[0].value,
            accPathResults.get(n.arguments[1]) as SetWithToStringEquality<AccessPath>
          );
        else if (isBinaryExpression(n.arguments[0]) && n.arguments[0].operator === '+') {
          let name;
          if (isSimpleLiteral(n.arguments[0].left) && typeof n.arguments[0].left.value === 'string') {
            name = `${n.arguments[0].left.value}.*`;
          } else if (isSimpleLiteral(n.arguments[0].right) && typeof n.arguments[0].right.value === 'string') {
            name = `.*${n.arguments[0].right.value}`;
          }
          if (name)
            addAllToMapSetWithStringEquality(
              res,
              name,
              accPathResults.get(n.arguments[1]) as SetWithToStringEquality<AccessPath>
            );
        }
      },
    });
    return res;
  }

  static async computeUsageModelFromImportAccessPath(
    importAccessPath: ImportAccessPath,
    useDynamicAnalysis: boolean
  ): Promise<UsageModel> {
    //const relImport = relative(StaticConfiguration.projectHome, importAccessPath.fileLocation);
    //if (relImport.startsWith())
    const packageModelPath = await getPackageModelFile(importAccessPath.fileLocation);
    //const packageModelPath = `${importAccessPath.fileLocation
    //  .replace('dependency-graph-npm/out/', 'dependency-graph-npm/out-package-model/')
    //  .replace('dependency-graph-npm/res/', 'dependency-graph-npm/out-package-model/')}-package.model.json`;
    await createDirectoryIfMissing(dirname(packageModelPath));
    const sourceFile = importAccessPath.fileLocation;
    let packageModel;
    if (useDynamicAnalysis) {
      if (!existsSync(packageModelPath)) {
        await runAnalysis('api', sourceFile, packageModelPath, {});
      }
      packageModel = JSON.parse(await p(readFile)(packageModelPath, 'utf-8'));
    }
    const dir = normalize(resolve(sourceFile, relative(sourceFile, process.cwd())));
    const filepath = `./${relative(process.cwd(), sourceFile)}`;
    const tapir = new ModelGenerator(dir, filepath, await parseFileWithAcorn(sourceFile));
    return tapir.computeUsageModelFromPackageModel(packageModel);
  }

  static async computeAllNecessaryUsageModels(
    packageModelLocation: string,
    clientDir: string,
    files: string[]
  ): Promise<Map<string, UsageModel>> {
    const worklist = files;
    const usageModels: Map<string, UsageModel> = new Map();
    while (worklist.length > 0) {
      const file = worklist.pop() as string;
      const packageModelFile = resolve(packageModelLocation, file + '.packageModel.json');
      const packageModel = JSON.parse(await p(readFile)(packageModelFile, 'utf-8'));
      const usageModel = await ModelGenerator.computeUsageModelForFile(packageModel, clientDir, file);
      usageModels.set(file, usageModel);
    }
    usageModels.forEach((usgModel, file) => {
      console.log('Usage model for file:' + file);
      usgModel.writeSummary();
    });
    return usageModels;
  }

  static async buildCallGraphFromMain(
    dir: string,
    mainFiles: string[],
    fieldBasedStrategy: PropertyReadsOnLibraryObjectStrategies,
    modulesToIgnore?: string[]
  ) {
    return await buildCallGraphFromMain(dir, mainFiles, fieldBasedStrategy, modulesToIgnore);
  }

  static async computeUsageModelForFile(packageModel: any, clientDir: string, file: string): Promise<UsageModel> {
    const module = await parseFileWithAcorn(resolve(clientDir, file));
    const tapir = new ModelGenerator(clientDir, file, module);
    return tapir.computeUsageModelFromPackageModel(packageModel);
  }

  private computeApplyArguments(node: CallExpression): SetWithToStringEquality<AccessPath>[] {
    const argArrayNode = node.arguments[1];
    const res: SetWithToStringEquality<AccessPath> = new SetWithToStringEquality();
    if (isCallExpression(argArrayNode)) {
      const argCallee = argArrayNode.callee;
      if (isMemberExpression(argCallee)) {
        if (isArrayExpression(argCallee.object)) {
          this.getAccessPathsFromArrayExpression(argCallee.object).forEach((ap) => res.add(ap));
        }
        if (isIdentifier(argCallee.property) && argCallee.property.name === 'concat') {
          if (isIdentifier(argArrayNode.arguments[0]) && argArrayNode.arguments[0].name === 'args') {
            this.computeAccessPaths(argArrayNode.arguments[0], this, false, true).forEach((ap) => {
              if (
                ap instanceof CallAccessPath &&
                ap.callee.toString().includes('<BUILT_IN') &&
                ap.callee.toString().includes('.prototype.slice.call')
              ) {
                [...ap.args[0]]
                  .filter((a) => a instanceof ArgumentsAccessPath)
                  .map((a) => (a as ArgumentsAccessPath).functionCreation)
                  .forEach((declNode: FunctionCreation) =>
                    [0, 1, 2, 3, 4, 5, 6, 7, 8].forEach((n) => res.add(new ParameterAccessPath(declNode, n)))
                  );
              }
            });
          }
        }
      }
    }
    return [0, 1, 2, 3, 4, 5, 6, 7, 8].map((_) => res);
  }

  private getAccessPathsFromArrayExpression(arrExp: ArrayExpression) {
    return setWithToStringEqualityUnion(arrExp.elements.map((n) => this.computeAccessPaths(n, this, false, true)));
  }

  private computeLocationMapper(): Map<string, SourceLocation> {
    const res: Map<string, SourceLocation> = new Map();
    simple(this.module, {
      ClassDeclaration: (node: ClassDeclaration) => {
        // Map class definition locations to the function expression of the constructor
        const constructor = node.body.body.find((m) => m.kind === 'constructor');
        if (!constructor || !node.loc || !constructor.value.loc) return;
        res.set(this.getStartLocString(node.loc), constructor.value.loc);
      },
    });
    return res;
  }

  private getStartLocString(loc: SourceLocation) {
    return `${loc.start.line}:${loc.start.column}`;
  }
}
export const BUILT_IN = 'BUILT_IN';
const globalObjects: { [key: string]: (sl: SourceLocation, file: string) => ImportAccessPath } = {
  Promise: (sl, file) => new ImportAccessPath('Promise', BUILT_IN, sl, file),
  JSON: (sl, file) => new ImportAccessPath('JSON', BUILT_IN, sl, file),
  console: (sl, file) => new ImportAccessPath('console', BUILT_IN, sl, file),
  Symbol: (sl, file) => new ImportAccessPath('Symbol', BUILT_IN, sl, file),
  global: (sl, file) => new ImportAccessPath('global', BUILT_IN, sl, file),
  globalThis: (sl, file) => new ImportAccessPath('global', BUILT_IN, sl, file),
  Array: (sl, file) => new ImportAccessPath('Array', BUILT_IN, sl, file),
  Error: (sl, file) => new ImportAccessPath('Error', BUILT_IN, sl, file),
  TypeError: (sl, file) => new ImportAccessPath('TypeError', BUILT_IN, sl, file),
  RangeError: (sl, file) => new ImportAccessPath('RangeError', BUILT_IN, sl, file),
  System: (sl, file) => new ImportAccessPath('System', BUILT_IN, sl, file),
  Map: (sl, file) => new ImportAccessPath('Map', BUILT_IN, sl, file),
  WeakMap: (sl, file) => new ImportAccessPath('WeakMap', BUILT_IN, sl, file),
  Set: (sl, file) => new ImportAccessPath('Set', BUILT_IN, sl, file),
  RegExp: (sl, file) => new ImportAccessPath('RegExp', BUILT_IN, sl, file),
  Reflect: (sl, file) => new ImportAccessPath('Reflect', BUILT_IN, sl, file),
  Dict: (sl, file) => new ImportAccessPath('Dict', BUILT_IN, sl, file),
  Object: (sl, file) => new ImportAccessPath('Object', BUILT_IN, sl, file),
  Function: (sl, file) => new ImportAccessPath('Function', BUILT_IN, sl, file),
  Number: (sl, file) => new ImportAccessPath('Number', BUILT_IN, sl, file),
  String: (sl, file) => new ImportAccessPath('String', BUILT_IN, sl, file),
  Boolean: (sl, file) => new ImportAccessPath('Boolean', BUILT_IN, sl, file),
  navigator: (sl, file) => new ImportAccessPath('navigator', BUILT_IN, sl, file),
  window: (sl, file) => new ImportAccessPath('global', BUILT_IN, sl, file),
  Date: (sl, file) => new ImportAccessPath('Date', BUILT_IN, sl, file),
  FormData: (sl, file) => new ImportAccessPath('FormData', BUILT_IN, sl, file),
  DataView: (sl, file) => new ImportAccessPath('DataView', BUILT_IN, sl, file),
  Buffer: (sl, file) => new ImportAccessPath('Buffer', BUILT_IN, sl, file),
  ArrayBuffer: (sl, file) => new ImportAccessPath('ArrayBuffer', BUILT_IN, sl, file),
  require: (sl, file) => new ImportAccessPath('require', BUILT_IN, sl, file),
  exports: (sl, file) => new ImportAccessPath('exports', BUILT_IN, sl, file),
  isNaN: (sl, file) => new ImportAccessPath('isNaN', BUILT_IN, sl, file),
  isFinite: (sl, file) => new ImportAccessPath('isFinite', BUILT_IN, sl, file),
  parseFloat: (sl, file) => new ImportAccessPath('parseFloat', BUILT_IN, sl, file),
  parseInt: (sl, file) => new ImportAccessPath('parseFloat', BUILT_IN, sl, file),
  Math: (sl, file) => new ImportAccessPath('Math', BUILT_IN, sl, file),
  encodeURI: (sl, file) => new ImportAccessPath('encodeURI', BUILT_IN, sl, file),
  encodeURIComponent: (sl, file) => new ImportAccessPath('encodeURIComponent', BUILT_IN, sl, file),
  decodeURI: (sl, file) => new ImportAccessPath('decodeURI', BUILT_IN, sl, file),
  decodeURIComponent: (sl, file) => new ImportAccessPath('decodeURIComponent', BUILT_IN, sl, file),
  eval: (sl, file) => new ImportAccessPath('eval', BUILT_IN, sl, file),
  escape: (sl, file) => new ImportAccessPath('escape', BUILT_IN, sl, file),
  unescape: (sl, file) => new ImportAccessPath('unescape', BUILT_IN, sl, file),
  EvalError: (sl, file) => new ImportAccessPath('EvalError', BUILT_IN, sl, file),
  ReferenceError: (sl, file) => new ImportAccessPath('ReferenceError', BUILT_IN, sl, file),
  SyntaxError: (sl, file) => new ImportAccessPath('SyntaxError', BUILT_IN, sl, file),
  URIError: (sl, file) => new ImportAccessPath('URIError', BUILT_IN, sl, file),
  Uint8Array: (sl, file) => new ImportAccessPath('Uint8Array', BUILT_IN, sl, file),
  util: (sl, file) => new ImportAccessPath('util', BUILT_IN, sl, file),
  stream: (sl, file) => new ImportAccessPath('stream', BUILT_IN, sl, file),
  child_process: (sl, file) => new ImportAccessPath('child_process', BUILT_IN, sl, file),
  setInterval: (sl, file) => new ImportAccessPath('setInterval', BUILT_IN, sl, file),
  setImmediate: (sl, file) => new ImportAccessPath('setImmediate', BUILT_IN, sl, file),
  queueMicrotask: (sl, file) => new ImportAccessPath('queueMicrotask', BUILT_IN, sl, file),
  process: (sl, file) => new ImportAccessPath('process', BUILT_IN, sl, file),
  Polyglot: (sl, file) => new ImportAccessPath('Polyglot', BUILT_IN, sl, file),
  Int8Array: (sl, file) => new ImportAccessPath('Int8Array', BUILT_IN, sl, file),
  Uint8ClampedArray: (sl, file) => new ImportAccessPath('Uint8ClampedArray', BUILT_IN, sl, file),
  Int16Array: (sl, file) => new ImportAccessPath('Int16Array', BUILT_IN, sl, file),
  Uint16Array: (sl, file) => new ImportAccessPath('Uint16Array', BUILT_IN, sl, file),
  Int32Array: (sl, file) => new ImportAccessPath('Int32Array', BUILT_IN, sl, file),
  Uint32Array: (sl, file) => new ImportAccessPath('Uint32Array', BUILT_IN, sl, file),
  Float32Array: (sl, file) => new ImportAccessPath('Float32Array', BUILT_IN, sl, file),
  Float64Array: (sl, file) => new ImportAccessPath('Float64Array', BUILT_IN, sl, file),
  BigInt64Array: (sl, file) => new ImportAccessPath('BigInt64Array', BUILT_IN, sl, file),
  BigUint64Array: (sl, file) => new ImportAccessPath('BigUint64Array', BUILT_IN, sl, file),
  BigInt: (sl, file) => new ImportAccessPath('BigInt', BUILT_IN, sl, file),
  WeakSet: (sl, file) => new ImportAccessPath('WeakSet', BUILT_IN, sl, file),
  Proxy: (sl, file) => new ImportAccessPath('Proxy', BUILT_IN, sl, file),
  SharedArrayBuffer: (sl, file) => new ImportAccessPath('SharedArrayBuffer', BUILT_IN, sl, file),
  Atomics: (sl, file) => new ImportAccessPath('Atomics', BUILT_IN, sl, file),
  Intl: (sl, file) => new ImportAccessPath('Intl', BUILT_IN, sl, file),
  Collator: (sl, file) => new ImportAccessPath('Collator', BUILT_IN, sl, file),
  NumberFormat: (sl, file) => new ImportAccessPath('NumberFormat', BUILT_IN, sl, file),
  DateTimeFormat: (sl, file) => new ImportAccessPath('DateTimeFormat', BUILT_IN, sl, file),
  PluralRules: (sl, file) => new ImportAccessPath('PluralRules', BUILT_IN, sl, file),
  ListFormat: (sl, file) => new ImportAccessPath('ListFormat', BUILT_IN, sl, file),
  RelativeTimeFormat: (sl, file) => new ImportAccessPath('RelativeTimeFormat', BUILT_IN, sl, file),
  Segmenter: (sl, file) => new ImportAccessPath('Segmenter', BUILT_IN, sl, file),
  DisplayNames: (sl, file) => new ImportAccessPath('DisplayNames', BUILT_IN, sl, file),
  Locale: (sl, file) => new ImportAccessPath('Locale', BUILT_IN, sl, file),
  Java: (sl, file) => new ImportAccessPath('Java', BUILT_IN, sl, file),
};

// @ts-ignore
function isLeftHandSideInAssignment(path: any) {
  let currentPath = path;
  while (
    !isProgram(currentPath.parent.node) &&
    !isBlockStatement(currentPath.parent.node) &&
    !(isMemberExpression(currentPath.parent.node) && currentPath.parent.node.object === currentPath.node)
  ) {
    if (isAssignmentExpression(currentPath.parent.node)) return currentPath.parent.node.left === currentPath.node;
    currentPath = currentPath.parent;
  }
  return false;
}

function computePropNameFromMemberExpression(n: MemberExpression) {
  let propName: string | undefined;
  if (!n.computed && isIdentifier(n.property)) propName = (n.property as Identifier).name;
  else if (n.computed && isSimpleLiteral(n.property) && typeof n.property.value === 'string')
    propName = n.property.value;
  else if (n.computed) {
    if (isBinaryExpression(n.property) && n.property.operator === '+') {
      if (isSimpleLiteral(n.property.left) && typeof n.property.left.value === 'string') {
        propName = `${n.property.left.value}.*`;
      } else if (isSimpleLiteral(n.property.right) && typeof n.property.right.value) {
        propName = `.*${n.property.right.value}`;
      }
    }
  }
  return propName;
}
