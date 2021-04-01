import { readDir } from '../util/file';
import { parseFileWithAcorn } from '../util/parsing';
import { CallExpression, ImportDeclaration } from 'estree';
import {
  isArrowFunctionExpression,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isSimpleLiteral,
} from '../util/ast-utils';
//import { createLogger } from '../logging';
import { ancestor } from 'acorn-walk';
import { PackageOperations } from '../util/package/package-operations';

export async function findAllJSFilesRecursively(path: string): Promise<string[]> {
  return await readDir(path, true, ['.js', '.es'], undefined, undefined, true);
}

interface ModuleLoadSummary {
  moduleLoads: number;
  topLevelModuleLoads: number;
  imports: number;
}

export async function getModuleLoadSummaryForFolder(folder: string): Promise<ModuleLoadSummary> {
  const files = await PackageOperations.getAllPackageJavaScriptFiles(folder);
  const aggSummary = (await Promise.all(files.map((f) => getModuleLoadSummary(f)))).reduce((agg, cur) => {
    return {
      moduleLoads: agg.moduleLoads + cur.moduleLoads,
      topLevelModuleLoads: agg.topLevelModuleLoads + cur.topLevelModuleLoads,
      imports: agg.imports + cur.imports,
    };
  });
  return aggSummary;
}

export async function getModuleLoadSummary(file: string): Promise<ModuleLoadSummary> {
  const ast = await parseFileWithAcorn(file);
  let imports = 0;
  let totalRequires = 0;
  let topLevelRequires = 0;

  ancestor(ast, {
    ImportDeclaration: function (_: ImportDeclaration) {
      imports++;
    },
    CallExpression: function (node: CallExpression, ancestors: import('estree').Node[]) {
      if (node.arguments.length === 1 && isSimpleLiteral(node.arguments[0])) {
        if (
          (isIdentifier(node.callee) && node.callee.name === 'require') /* require(....) */ ||
          (isMemberExpression(node.callee) /* a.x.require('...');  We 'guess' that this is also a require call*/ &&
            isIdentifier(node.callee.property) &&
            node.callee.property.name === 'require')
        ) {
          if (!ancestors.find((ancestor) => isFunctionExpression(ancestor) || isArrowFunctionExpression(ancestor))) {
            topLevelRequires++;
          }
          totalRequires++;
        }
      }
    },
  });
  return {
    moduleLoads: imports + totalRequires,
    topLevelModuleLoads: imports + topLevelRequires,
    imports,
  };
}
