import { ModelGenerator } from './model-generator';
import { AccessPath } from './access-path';
import { SetWithToStringEquality, setWithToStringEqualityUnion } from '../util/collections';
import { promisify as p } from 'util';
import { readFile } from 'fs';
import { isCallExpression, isRequireCall } from '../util/ast-utils';
import { relative } from 'path';
import { Node } from 'estree';

export class UsageModelGenerator {
  readonly codeFile: string;
  readonly packageModelFile: string;
  readonly clientDir: string;
  constructor(clientDir: string, codeFile: string, packageModelFile: string) {
    this.clientDir = clientDir;
    this.codeFile = codeFile;
    this.packageModelFile = packageModelFile;
  }

  public async generateUsageModelUsingTapir() {
    let tapir = await ModelGenerator.createTapirFromFileName(this.clientDir, this.codeFile);
    const computedAccessPathResults: Map<Node, SetWithToStringEquality<AccessPath>> = tapir.computeAccessPathsPhase();
    const allAccPaths: string[] = [
      ...setWithToStringEqualityUnion(
        [...computedAccessPathResults.entries()]
          .filter(([n, _]) => isCallExpression(n) && !isRequireCall(n, new Set()))
          .map(([_, acc]) => acc)
      ),
    ].map((acc) => acc.toString());
    const packageModel = JSON.parse(await p(readFile)(this.packageModelFile, 'utf-8'));
    const resObject: any = {};
    Object.keys(packageModel).forEach((k) => {
      resObject[k] = [...allAccPaths];
      if (packageModel[k].file !== relative(this.clientDir, this.codeFile)) {
        resObject[k].push(`${packageModel[k].file}:${packageModel[k].lineNumber}:${packageModel[k].columnNumber}`);
      }
    });
    return resObject;
  }
}
