import { fileExists, readDir } from '../util/file';
import { dirname } from 'path';
import { flatten } from 'lodash';
import { parseFileWithAcorn } from '../util/parsing';
import { CallExpression, ExportNamedDeclaration, ImportDeclaration } from 'estree';
import { isIdentifier, isMemberExpression, isSimpleLiteral } from '../util/ast-utils';
import { createLogger } from '../logging';
import { simple } from 'acorn-walk';
const isBuiltIn = require('is-builtin-module');

const logger = createLogger(`resolver`, 'info');

export async function findAllJSFilesRecursively(path: string): Promise<string[]> {
  return await readDir(path, true, ['.js', '.es'], undefined, undefined, true);
}

export async function findAllTransitivelyLoadedModules(modulePath: string): Promise<string[]> {
  const hasSeen = new Set();

  const resolveTransitive = async (modulePathTrans: string) => {
    const moduleLoadStrings = await getModuleLoadStrings(modulePathTrans);
    const nonBuiltInModuleLoadStrings = moduleLoadStrings.filter((str) => !isBuiltIn(str));
    const moduleDir = dirname(modulePathTrans);

    // resolve the modules to file paths
    const resolvedModules = nonBuiltInModuleLoadStrings
      .map((moduleLoadString) => {
        try {
          const modulePathTrans = require.resolve(moduleLoadString, { paths: [moduleDir] });
          // @ts-ignore
          if (!hasSeen.has(modulePathTrans)) {
            // @ts-ignore
            hasSeen.add(modulePathTrans);
            return modulePathTrans;
          }
        } catch (e) {
          logger.error(`unable to resolve load of module ${moduleLoadString} from file ${modulePathTrans}`);
          return undefined;
        }
      })
      .filter((x) => !!x) as string[];

    // resolve transitive modules
    const transitiveResolvedModules: string[][] = (
      await Promise.all(
        resolvedModules.map(async (resolvedModule) => {
          if (await fileExists(resolvedModule)) {
            return await resolveTransitive(resolvedModule);
          }
        })
      )
    ).filter((x) => !!x) as string[][];
    return resolvedModules /*.map((m) => relative(cwd, m))*/
      .concat(flatten(transitiveResolvedModules));
  };
  return [modulePath].concat(await resolveTransitive(modulePath));
}

export async function getModuleLoadStrings(file: string): Promise<string[]> {
  try {
    if (file.endsWith('.json')) {
      return [];
    }
    const ast = await parseFileWithAcorn(file);
    const res: string[] = [];
    simple(ast, {
      ImportDeclaration: function (node: ImportDeclaration) {
        if (isSimpleLiteral(node.source)) {
          if (typeof node.source.value !== 'string') {
            logger.error(`found non-string import value ${node.source.value} in ${file}`);
          } else {
            res.push(node.source.value);
          }
        } else {
          // node.source is a regexp how do we handle this?
          logger.error(`cannot handle regexp import ${node.source.raw} seen in ${file}`);
        }
      },
      CallExpression: function (node: CallExpression) {
        if (node.arguments.length === 1 && isSimpleLiteral(node.arguments[0])) {
          if (
            (isIdentifier(node.callee) && node.callee.name === 'require') /* require(....) */ ||
            (isMemberExpression(node.callee) /* a.x.require('...');  We 'guess' that this is also a require call*/ &&
              isIdentifier(node.callee.property) &&
              node.callee.property.name === 'require')
          ) {
            if (typeof node.arguments[0].value !== 'string') {
              logger.error(`found require call with non-string argument ${node.arguments[0].value} in ${file}`);
            } else {
              res.push(node.arguments[0].value);
            }
          }
        }
      },
      ExportNamedDeclaration(node: ExportNamedDeclaration): any {
        if (node.source) {
          // e.g., export {foo} from 'bar';
          if (isSimpleLiteral(node.source) && typeof node.source.value === 'string') {
            res.push(node.source.value);
          } else {
            logger.error(
              `found export named declaration with non-literal or non-string source ${node.source} in ${file}`
            );
          }
        }
      },
    });
    return res;
  } catch (e) {
    logger.error(`unable to extract module load strings for ${file}, failed with error ${e}`);
    return [];
  }
}
