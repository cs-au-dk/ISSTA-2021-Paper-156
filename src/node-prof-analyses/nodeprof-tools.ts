import { SourceLocation } from 'estree';

export function getSourceLocation(line: string): SourceLocation {
  // remove params around line
  line = line.substring(1, line.length - 1);
  const match = line.match(/(.*):(\d+):(\d+):(\d+):(\d+)/);
  if (match) {
    const file = match[1];
    const firstLine = Number(match[2]);
    // minus one to match with estree spec
    const firstColumn = Number(match[3]) - 1;
    const secondColumn = Number(match[5]) - 1;
    const offsetLength = 61;
    const offset = firstLine == 1 && firstColumn >= offsetLength ? offsetLength : 0;
    return {
      start: {
        line: firstLine,
        column: firstColumn - offset,
      },
      end: {
        line: Number(match[4]),
        column: secondColumn - offset,
      },
      source: file,
    };
  }
  throw new Error(`unable to match line ${line}`);
}
