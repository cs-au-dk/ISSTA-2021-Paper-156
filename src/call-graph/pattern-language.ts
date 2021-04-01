import { GlobPattern, parseGlobPattern } from './glob';

export interface Pattern {}
export class ImportPattern implements Pattern {
  readonly importPathPattern: ImportPathPattern;
  readonly onlyDefault: boolean;
  constructor(importPathPattern: ImportPathPattern, onlyDefault: boolean) {
    this.importPathPattern = importPathPattern;
    this.onlyDefault = onlyDefault;
  }
  public toString(): string {
    return `import${this.onlyDefault ? 'D' : ''} ${this.importPathPattern.toString(true)}`;
  }
}

export class ReadPropertyPattern implements Pattern {
  readonly propertyPathPattern: PropertyPathPattern;
  readonly notInvoked: boolean; // If true match only read properties that are not syntactically the callee
  constructor(propertyPathPattern: PropertyPathPattern, notInvoked: boolean) {
    this.propertyPathPattern = propertyPathPattern;
    this.notInvoked = notInvoked;
  }
  public toString(): string {
    return `read${this.notInvoked ? 'O' : ''} ${this.propertyPathPattern}`;
  }
}

export class CallPattern implements Pattern {
  readonly accessPathPattern: AccessPathPattern;
  readonly filters: Filter[];
  readonly onlyReturnChanged: boolean;
  constructor(accessPathPattern: AccessPathPattern, filters: Filter[], onlyReturnChanged: boolean) {
    this.accessPathPattern = accessPathPattern;
    this.filters = filters;
    this.onlyReturnChanged = onlyReturnChanged;
  }
  public toString(): string {
    return `call${this.onlyReturnChanged ? 'R' : ''} ${[this.accessPathPattern, ...this.filters].join(' ')}`;
  }
}

export class PropertyPathPattern implements AccessPathPattern {
  readonly receiver: AccessPathPattern;
  readonly propNames: string[];
  constructor(receiver: AccessPathPattern, propNames: string[]) {
    this.receiver = receiver;
    this.propNames = propNames;
  }
  public toString(): string {
    return this.propNames.length === 1
      ? `${this.receiver}.${this.propNames[0]}`
      : `${this.receiver}.{${this.propNames.join(',')}}`;
  }
}

export interface AccessPathPattern {
  //matches: (accPath: AccessPath, unknownRequires: Set<ImportAccessPath>) => MatchResult;
}

export class ImportPathPattern implements AccessPathPattern {
  readonly importPathPattern: GlobPattern;
  constructor(importPathPattern: string) {
    this.importPathPattern = parseGlobPattern(importPathPattern);
  }
  public toString(ignoreAngleBrackets?: boolean): string {
    if (ignoreAngleBrackets) return `${this.importPathPattern}`;
    return `<${this.importPathPattern}>`;
  }
}

export class DisjunctionAccessPathPattern implements AccessPathPattern {
  readonly accessPathPatterns: AccessPathPattern[];
  constructor(accessPathPatterns: AccessPathPattern[]) {
    this.accessPathPatterns = accessPathPatterns;
  }
  public toString(): string {
    return `{${this.accessPathPatterns.map((accPath) => accPath.toString()).join(',')}}`;
  }
}

export class CallAccessPathPattern implements AccessPathPattern {
  readonly accessPathPattern: AccessPathPattern;
  constructor(accessPathPattern: AccessPathPattern) {
    this.accessPathPattern = accessPathPattern;
  }
  public toString(): string {
    return `${this.accessPathPattern}()`;
  }
}

export interface Filter {
  //matches: (args: Node[]) => MatchResult;
}

export class NumArgsFilter implements Filter {
  readonly minArgs: number;
  readonly maxArgs: number;
  constructor(minArgs: number, maxArgs: number) {
    this.minArgs = minArgs;
    this.maxArgs = maxArgs;
  }
  public toString(): string {
    return `[${this.minArgs}, ${this.maxArgs}]`;
  }

  //public matches(args: Node[]): MatchResult {
  //  return getMatchResultFromBoolean(args.length >= this.minArgs && args.length <= this.maxArgs);
  //}
  public getMinArgs() {
    return this.minArgs;
  }
  public getMaxArgs() {
    return this.maxArgs;
  }
}

export function parsePattern(pattern: string): Pattern {
  const [kind, path] = pattern.split(' ');
  if (kind === 'import') {
    return new ImportPattern(new ImportPathPattern(path), false);
  } else if (kind === 'importD') {
    return new ImportPattern(new ImportPathPattern(path), true);
  } else if (kind.startsWith('read')) {
    const propertyPathPattern = parsePropertyPathPattern(path);
    return new ReadPropertyPattern(propertyPathPattern, kind === 'readO');
    //} else if (kind === "write") {
    //  const propertyPathPattern = parsePropertyPathPattern(path);
    //  return new WritePropertyPattern(propertyPathPattern);
  } else if (kind.startsWith('call')) {
    const accessPathPattern = parseAccessPathPattern(path);
    const filters = parseFilters(pattern);
    return new CallPattern(accessPathPattern, filters, kind === 'callR');
  }
  throw new Error(`Invalid pattern kind. Expected import, read, write or call, but got: ${kind}`);
}

function parsePropertyPathPattern(path: string): PropertyPathPattern {
  const indexLastDot = path.lastIndexOf('.');
  if (indexLastDot === -1 || indexLastDot === path.length - 1 || indexLastDot === 0) {
    throw new Error(`Not a valid property path pattern: ${path}`);
  }
  const receiverAccessPath = parseAccessPathPattern(path.substring(0, indexLastDot));
  const propertyString = path.substring(indexLastDot + 1);

  const propNames: string[] =
    propertyString.startsWith('{') && propertyString.endsWith('}')
      ? propertyString
          .substring(1, propertyString.length - 1)
          .split(',')
          .map((str) => str.trim())
      : [propertyString];

  return new PropertyPathPattern(receiverAccessPath, propNames);
}

export function parseAccessPathPattern(path: string): AccessPathPattern {
  if (path.startsWith('<') && path.endsWith('>')) return new ImportPathPattern(path.substring(1, path.length - 1));
  if (path.startsWith('{') && isDisjunctionAccessPathPattern(path))
    return new DisjunctionAccessPathPattern(
      splitConnectiveString(path.substring(1, path.length - 1), ',', '{', '}')
        .map((str) => str.trim())
        .map(parseAccessPathPattern)
    );
  if (path.endsWith('()')) return new CallAccessPathPattern(parseAccessPathPattern(path.substring(0, path.length - 2)));
  try {
    return parsePropertyPathPattern(path);
  } catch (e) {
    throw new Error(`Not a valid AccessPathPattern string: ${path}`);
  }
}

function isConnectiveAccessPath(path: string, splitOperator: string, useCurly: boolean) {
  const startSymbol = useCurly ? '{' : '(';
  const endSymbol = useCurly ? '}' : ')';
  if (!path.startsWith(startSymbol) || !path.endsWith(endSymbol)) return false;
  let hasSeenSplitter = false;
  let parenLevel = 1;
  for (let i = 1; i < path.length - 1; i++) {
    if (path.charAt(i) === startSymbol) parenLevel++;
    else if (path.charAt(i) === splitOperator && parenLevel === 1) hasSeenSplitter = true;
    else if (path.charAt(i) === endSymbol) parenLevel--;
    if (parenLevel === 0) return false;
  }
  return hasSeenSplitter;
}

// @ts-ignore
function isDisjunctionAccessPathPattern(path: string): boolean {
  return isConnectiveAccessPath(path, ',', true);
}

// @ts-ignore
function isExclusionAccessPathPattern(path: string): boolean {
  return isConnectiveAccessPath(path, '\\', false);
}

function splitConnectiveString(
  path: string,
  connectiveOperator: string,
  startSymbol: string,
  endSymbol: string
): string[] {
  const res = [];
  let parenLevel = 0;
  let nextSplitStart = 0;
  for (let i = 0; i < path.length; i++) {
    if (path.charAt(i) === startSymbol) parenLevel++;
    else if (path.charAt(i) === endSymbol) parenLevel--;
    if (parenLevel === 0 && path.charAt(i) === connectiveOperator) {
      res.push(path.substring(nextSplitStart, i));
      nextSplitStart = i + 1;
    }
  }
  res.push(path.substring(nextSplitStart, path.length));
  return res;
}

export function parseFilters(pattern: string): Filter[] {
  return splitConnectiveString(pattern.split(' ').splice(2).join(' '), ' ', '[', ']')
    .map((filterString) => filterString.trim())
    .filter((str) => str)
    .map(parseFilter);
}

function parseFilter(filterString: string): Filter {
  const numArgsMatch = filterString.match('\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]');
  if (numArgsMatch) {
    return new NumArgsFilter(parseInt(numArgsMatch[1]), parseInt(numArgsMatch[2]));
  }
  throw new Error(`Invalid filter: ${filterString}`);
}

export type JSType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'undefined'
  | 'function'
  | 'function1'
  | 'function2'
  | 'function3'
  | 'object'
  | 'array'
  | string;
export const JSTypes = [
  'string',
  'number',
  'boolean',
  'undefined',
  'function',
  'function1',
  'function2',
  'function3',
  'object',
  'array',
];
