export interface GlobPattern {
  matches(path: string, wildcardNum: number): GlobMatch[];
  toString(): string;
}

export class GlobStar implements GlobPattern {
  readonly pattern: GlobPattern;
  constructor(pattern: GlobPattern) {
    this.pattern = pattern;
  }

  public matches(path: string, wildcardNum: number): GlobMatch[] {
    if (!path.startsWith('/')) return [];
    const results: GlobMatch[] = [];
    let currentPath = path;
    let slashIndex: number;
    let stringMatched = '';
    while ((slashIndex = currentPath.indexOf('/')) !== -1) {
      const restPath = currentPath.substring(slashIndex + 1);
      stringMatched += currentPath.substring(0, slashIndex + 1);
      this.pattern.matches(restPath, wildcardNum + 1).forEach((m) => {
        const wildcardMatches = m.getWildcardMatches();
        wildcardMatches['#' + wildcardNum] = stringMatched;
        results.push(new GlobMatch(stringMatched + m.stringMatched, wildcardMatches));
      });
      currentPath = restPath;
    }
    return results;
  }

  public toString(): string {
    return `/**/${this.pattern}`;
  }
}

export class Star implements GlobPattern {
  readonly pattern: GlobPattern;
  constructor(pattern: GlobPattern) {
    this.pattern = pattern;
  }

  public matches(path: string, wildcardNum: number): GlobMatch[] {
    const results: GlobMatch[] = [];
    let potentialMatchLength = path.indexOf('/') !== -1 ? path.indexOf('/') : path.length;
    for (let i = 0; i <= potentialMatchLength; i++) {
      const matches = this.pattern.matches(path.substring(i), wildcardNum + 1);
      matches.forEach((m) => {
        const wildcardMatches = m.getWildcardMatches();
        wildcardMatches['#' + wildcardNum] = path.substring(0, i);
        results.push(new GlobMatch(path.substring(0, i) + m.stringMatched, wildcardMatches));
      });
    }
    return results;
  }

  public toString(): string {
    return `*${this.pattern}`;
  }
}

export class GlobDisjunction implements GlobPattern {
  readonly patterns: GlobPattern[];
  readonly rest: GlobPattern;
  constructor(patterns: GlobPattern[], rest: GlobPattern) {
    this.patterns = patterns;
    this.rest = rest;
  }

  public matches(path: string, wildcardNum: number): GlobMatch[] {
    const results: GlobMatch[] = [];
    let globResults = this.patterns.map((p) => p.matches(path, -1)).reduce((acc, val) => acc.concat(val), []);
    for (let i = 0; i < globResults.length; i++) {
      const globResult = globResults[i];
      const restPath = path.substring(globResult.stringMatched.length);
      let matches = this.rest.matches(restPath, wildcardNum + 1);
      matches.forEach((m) => {
        const wildcardMatches = m.getWildcardMatches();
        wildcardMatches['#' + wildcardNum] = globResult.stringMatched;
        results.push(new GlobMatch(globResult.stringMatched + m.stringMatched, wildcardMatches));
      });
    }
    return results;
  }

  public toString(): string {
    return `{${this.patterns.join(',')}}${this.rest}`;
  }
}

export class GlobConstant implements GlobPattern {
  readonly constant: string;
  readonly globPattern: GlobPattern;
  constructor(constant: string, globPattern: GlobPattern) {
    this.constant = constant;
    this.globPattern = globPattern;
  }

  public matches(path: string, wildcardNum: number): GlobMatch[] {
    if (!path.startsWith(this.constant)) return [];
    let globResults = this.globPattern.matches(path.substring(this.constant.length), wildcardNum);
    return globResults.map(
      (globResult) => new GlobMatch(this.constant + globResult.stringMatched, globResult.getWildcardMatches())
    );
  }

  public toString(): string {
    return `${this.constant}${this.globPattern}`;
  }
}

export class GlobEnd implements GlobPattern {
  public matches(path: string, wildcardNum: number): GlobMatch[] {
    if (wildcardNum !== -1 && path !== '') return [];
    else return [new GlobMatch('', {})];
  }

  public toString(): string {
    return '';
  }
}

export function parseGlobPattern(pattern: string): GlobPattern {
  if (pattern.length === 0) return new GlobEnd();
  const nextSpecialCharacter = getNextSpecialCharacter(pattern);
  if (!nextSpecialCharacter) return new GlobConstant(pattern, new GlobEnd());
  const specialCharacterIndex = pattern.indexOf(nextSpecialCharacter);
  let specialCharacterPattern: GlobPattern;
  if (nextSpecialCharacter === GLOB_STAR) {
    const restPattern = parseGlobPattern(pattern.substring(specialCharacterIndex + GLOB_STAR.length));
    specialCharacterPattern = new GlobStar(restPattern);
  } else if (nextSpecialCharacter === STAR) {
    const restPattern = parseGlobPattern(pattern.substring(specialCharacterIndex + STAR.length));
    specialCharacterPattern = new Star(restPattern);
  } else {
    const disjunctionPatterns = pattern
      .substring(specialCharacterIndex + STAR.length, pattern.indexOf('}'))
      .split(',')
      .map((str) => parseGlobPattern(str.trim()));
    const restPattern = parseGlobPattern(pattern.substring(pattern.indexOf('}') + 1));
    specialCharacterPattern = new GlobDisjunction(disjunctionPatterns, restPattern);
  }
  const startsWithSpecialCharacter = pattern.indexOf(nextSpecialCharacter) === 0;
  return startsWithSpecialCharacter
    ? specialCharacterPattern
    : new GlobConstant(pattern.substring(0, specialCharacterIndex), specialCharacterPattern);
}

export function globMatch(path: string, globPattern: GlobPattern): boolean {
  return globPattern.matches(path, 1).length > 0;
}

type GlobCharacter = '/**/' | '*' | '{';
const GLOB_STAR = '/**/';
const STAR = '*';
const CURLY = '{';

function getNextSpecialCharacter(pattern: string): GlobCharacter | undefined {
  const globStarIndex = pattern.indexOf(GLOB_STAR);
  const starIndex = pattern.indexOf(STAR);
  const curlyIndex = pattern.indexOf(CURLY);
  if (globStarIndex !== -1 && starIndex !== -1 && curlyIndex !== -1) {
    if (globStarIndex < starIndex && globStarIndex < curlyIndex) return GLOB_STAR;
    return starIndex < curlyIndex ? STAR : CURLY;
  }
  if (globStarIndex !== -1 && starIndex !== -1) return globStarIndex < starIndex ? GLOB_STAR : STAR;
  if (globStarIndex !== -1 && curlyIndex !== -1) return globStarIndex < curlyIndex ? GLOB_STAR : CURLY;
  if (starIndex !== -1 && curlyIndex !== -1) return starIndex < curlyIndex ? STAR : CURLY;
  if (globStarIndex !== -1) return GLOB_STAR;
  if (starIndex !== -1) return STAR;
  if (curlyIndex !== -1) return CURLY;
  return undefined;
}

export class GlobMatch {
  readonly stringMatched: string;
  private wildcardMatches: any; //object from #n to string part matched by it
  constructor(stringMatched: string, wildcardMatches: any) {
    this.stringMatched = stringMatched;
    this.wildcardMatches = wildcardMatches;
  }

  public getWildcardMatches() {
    return Object.assign({}, this.wildcardMatches);
  }
}
