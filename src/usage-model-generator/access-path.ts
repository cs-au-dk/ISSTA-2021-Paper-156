import { SourceLocation } from 'estree';
import { SetWithToStringEquality } from '../util/collections';
import { relative } from 'path';
import * as path from 'path';
import { PackageOperations } from '../util/package/package-operations';
import { computeArgsString, sourceLocationToString } from './compute-call-graph';
export interface AccessPath {
  toString: () => string;
  prettyString: () => string;
  getRootElement: () => ImportAccessPath | UnknownAccessPath | FunctionCreation | ThisAccessPath;
}
export class UnknownAccessPath implements AccessPath {
  public toString() {
    return 'U';
  }

  prettyString(): string {
    return this.toString();
  }

  getRootElement() {
    return this;
  }
}
export const unknownAccessPathInstance = new UnknownAccessPath();
export const MODULE_NOT_FOUND_STRING = 'MODULE_NOT_FOUND';
export class ImportAccessPath implements AccessPath {
  readonly importPath: string;
  //@ts-ignore
  readonly fileLocation: string;
  readonly sourceLocation: SourceLocation;
  readonly fileName: string | undefined;
  readonly stringRepresentation: string;
  readonly fileRelativetoCwd: string;
  constructor(importPath: string, filePathImportedFrom: string, sourceLocation: SourceLocation, fileName?: string) {
    this.importPath = importPath;
    this.sourceLocation = sourceLocation;
    this.fileName = fileName;
    if (filePathImportedFrom === 'BUILT_IN') {
      this.fileLocation = filePathImportedFrom;
      this.fileRelativetoCwd = filePathImportedFrom;
    } else {
      try {
        this.fileLocation = require.resolve(importPath, {
          paths: [fileName?.endsWith(importPath + '.js') ? fileName : filePathImportedFrom],
        });
      } catch (e) {
        this.fileLocation = MODULE_NOT_FOUND_STRING;
        this.fileRelativetoCwd = MODULE_NOT_FOUND_STRING;
      }
      this.fileRelativetoCwd = relative(process.cwd(), this.fileLocation);
    }
    this.stringRepresentation = this.computetoString();
  }
  private computetoString() {
    return `<${this.fileRelativetoCwd}:${this.sourceLocation.start.line}:${this.sourceLocation.start.column}:${this.sourceLocation.end.line}:${this.sourceLocation.end.column}>`;
  }
  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `<${path.basename(this.fileRelativetoCwd)}>`;
  }

  getRootElement() {
    return this;
  }
}
export function createImportAccessPath(
  importPath: string,
  filePathImportedFrom: string,
  sourceLocation: SourceLocation,
  fileName?: string
) {
  if (importPath === '✖') return new UnknownAccessPath();
  return new ImportAccessPath(importPath, filePathImportedFrom, sourceLocation, fileName);
}

export class PropAccessPath implements AccessPath {
  readonly receiver: AccessPath;
  readonly prop: string;
  readonly stringRepresentation: string;
  readonly sourceLocation: SourceLocation;
  readonly fileName: string;
  readonly dirName: string;
  constructor(receiver: AccessPath, prop: string, sourceLocation: SourceLocation, fileName: string, dirName: string) {
    this.receiver = receiver;
    this.prop = prop;
    this.sourceLocation = sourceLocation;
    this.fileName = fileName;
    this.stringRepresentation = this.computeToString();
    this.dirName = dirName;
  }
  private computeToString() {
    return `${this.dirName}:${this.fileName}:${sourceLocationToString(this.sourceLocation)}:${this.receiver}.${
      this.prop
    }`;
  }
  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `${this.receiver.prettyString()}.${this.prop}`;
  }

  isPropReadOnModuleSequence(): boolean {
    return (
      this.receiver instanceof ImportAccessPath ||
      (this.receiver instanceof PropAccessPath && this.receiver.isPropReadOnModuleSequence())
    );
  }

  getExportsSummaryAccessPath(): string {
    if (this.receiver instanceof ImportAccessPath) {
      return this.prop;
    } else if (this.receiver instanceof PropAccessPath) {
      return `${this.receiver.getExportsSummaryAccessPath()}.${this.prop}`;
    } else {
      throw new Error(
        `getExportsSummaryCalled on access path ${this.toString()}, which is not propReadOnModuleSequence`
      );
    }
  }

  getRootElement() {
    return this.receiver.getRootElement();
  }
}
export class CallAccessPath implements AccessPath {
  readonly callee: AccessPath;
  readonly args: SetWithToStringEquality<AccessPath>[];
  readonly argsToString: string;
  readonly sourceLocation: SourceLocation;
  readonly fileName: string;
  readonly stringRepresentation: string;
  readonly unknownArguments: boolean;
  constructor(
    callee: AccessPath,
    args: SetWithToStringEquality<AccessPath>[],
    sourceLocation: SourceLocation,
    fileName: string,
    unknownArguments?: boolean
  ) {
    this.callee = callee;
    this.args = args;
    this.argsToString = computeArgsString(this.args);
    this.sourceLocation = sourceLocation;
    this.fileName = fileName;
    this.unknownArguments = !!unknownArguments;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.callee}(${this.argsToString}):${this.fileName}:${this.sourceLocation.start.line}:${this.sourceLocation.start.column}`;
  }

  public nonArgsToString() {
    return `${this.callee.prettyString()}()`;
  }

  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return this.nonArgsToString();
  }

  getRootElement() {
    return this.callee.getRootElement();
  }
}

export class ThisAccessPath implements AccessPath {
  readonly stringRepresentation: string;
  constructor() {
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `this`;
  }
  public toString() {
    return this.stringRepresentation;
  }
  prettyString(): string {
    return this.toString();
  }
  getRootElement() {
    return this;
  }
}

export class ModuleMainPath implements AccessPath {
  readonly stringRepresentation: string;
  readonly fileRelativeToCwd: string;
  readonly estimatedModule: string;
  constructor(public readonly fileLocation: string, public readonly builtinName?: string) {
    if (builtinName) {
      this.fileRelativeToCwd = builtinName;
      this.stringRepresentation = this.computetoString();
      this.estimatedModule = builtinName;
      return;
    }
    this.fileRelativeToCwd = relative(process.cwd(), this.fileLocation);
    this.stringRepresentation = this.computetoString();
    this.estimatedModule = PackageOperations.estimateNpmModuleFromFile(fileLocation);
  }
  private computetoString() {
    return `<${this.fileRelativeToCwd}>`;
  }
  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `<${path.basename(this.fileRelativeToCwd)}>`;
  }

  getRootElement() {
    return this;
  }
}

export class FunctionCreation implements AccessPath {
  readonly sourceLocation: SourceLocation;
  readonly file: string;
  readonly stringRepresentation: string;
  constructor(creationNode: SourceLocation, file: string) {
    this.sourceLocation = creationNode;
    this.file = file;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `FunctionCreation:${this.file}:${(this.sourceLocation as SourceLocation).start.line}:${
      (this.sourceLocation as SourceLocation).start.column
    }`;
  }
  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `FunctionCreation:${path.basename(this.file)}:${(this.sourceLocation as SourceLocation).start.line}:${
      (this.sourceLocation as SourceLocation).start.column
    }`;
  }

  getRootElement() {
    return this;
  }
}

export class ParameterAccessPath implements AccessPath {
  readonly declNodeAccPath: FunctionCreation;
  readonly paramNumber: number;
  readonly stringRepresentation: string;
  constructor(declNodeAccPath: FunctionCreation, paramNumber: number) {
    this.declNodeAccPath = declNodeAccPath;
    this.paramNumber = paramNumber;
    this.stringRepresentation = this.computeToString();
  }
  private computeToString() {
    return `${this.declNodeAccPath}:arg${this.paramNumber}`;
  }
  public toString() {
    return this.stringRepresentation;
  }

  prettyString(): string {
    return `${this.declNodeAccPath.prettyString()}:arg${this.paramNumber}`;
  }

  getRootElement() {
    return this.declNodeAccPath;
  }
}

export class ArgumentsAccessPath implements AccessPath {
  readonly functionCreation: FunctionCreation;
  readonly stringRepresentation: string;
  constructor(functionCreation: FunctionCreation) {
    this.functionCreation = functionCreation;
    this.stringRepresentation = `Arguments<${functionCreation.toString()}>`;
  }

  getRootElement() {
    return this.functionCreation;
  }

  toString() {
    return this.stringRepresentation;
  }

  prettyString() {
    return this.stringRepresentation;
  }
}

export class StringLiteralAccessPath implements AccessPath {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }

  toString() {
    return this.value;
  }

  getRootElement(): ImportAccessPath | UnknownAccessPath | FunctionCreation | ThisAccessPath | StringLiteralAccessPath {
    return this;
  }

  prettyString(): string {
    return this.value;
  }
}

export class StringPrefixAccessPath implements AccessPath {
  readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }

  toString() {
    return `PREFIX(${this.prefix})`;
  }

  getRootElement(): ImportAccessPath | UnknownAccessPath | FunctionCreation | ThisAccessPath | StringLiteralAccessPath {
    return this;
  }

  prettyString(): string {
    return this.prefix;
  }
}

export class StringSuffixAccessPath implements AccessPath {
  readonly suffix: string;
  constructor(suffix: string) {
    this.suffix = suffix;
  }

  toString() {
    return `SUFFIX(${this.suffix})`;
  }

  getRootElement(): ImportAccessPath | UnknownAccessPath | FunctionCreation | ThisAccessPath | StringLiteralAccessPath {
    return this;
  }

  prettyString(): string {
    return this.suffix;
  }
}
