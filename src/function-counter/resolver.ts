import { parseFileWithAcorn } from '../util/parsing';
import { simple } from 'acorn-walk';
import { PackageOperations } from '../util/package/package-operations';

//const logger = createLogger(`resolver`, 'info');

export async function getFunctionCountForFolder(folder: string): Promise<number> {
  const files = await PackageOperations.getAllPackageJavaScriptFiles(folder);
  const aggSummary = (await Promise.all(files.map((f) => getFunctionCount(f)))).reduce((agg, cur) => {
    return agg + cur;
  });
  return aggSummary;
}

export async function getFunctionCount(file: string): Promise<number> {
  try {
    const ast = await parseFileWithAcorn(file);
    let functions = 0;

    simple(ast, {
      FunctionExpression: function () {
        functions++;
      },
      FunctionDeclaration: function () {
        functions++;
      },
      ArrowFunctionExpression: function () {
        functions++;
      },
    });
    return functions;
  } catch (e) {
    return 0;
  }
}
