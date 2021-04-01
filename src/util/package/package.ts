import { promisify as p } from 'util';
import { none, Option } from 'ts-option';
import { readFile } from 'fs';

export class Package {
  public resolvedGitCommit: Option<string> = none;
  public resolvedGitHubRepo: Option<string> = none;
  constructor(public name: string, public version: string) {}

  //@override
  toString(): string {
    return `${this.name}@${this.version}`;
  }

  toJsonAble(): any {
    const res: { [index: string]: string } = {
      name: this.name,
      version: this.version,
    };
    if (this.resolvedGitCommit.isDefined) {
      res['commit'] = this.resolvedGitCommit.get;
    }

    if (this.resolvedGitHubRepo.isDefined) {
      res['repo'] = this.resolvedGitHubRepo.get;
    }
    return res;
  }

  getNpmPackCompatName(): string {
    return this.name.replace('/', '-').replace('@', '');
  }

  /**
   * Transforms a 'pkgName@version' string to a Package
   */
  static fromAtString(atStr: string): Package {
    let idxOfAt = atStr.indexOf('@');
    if (idxOfAt == 0) {
      //Handle clients whose name starts with @, e.g., @resin/odata-to-abstract-sql
      idxOfAt = atStr.indexOf('@', 1);
    }
    return new Package(atStr.substring(0, idxOfAt), atStr.substring(idxOfAt + 1));
  }

  static async parseClientFile(file: string): Promise<Package[]> {
    const contents = await p(readFile)(file, 'utf-8');
    const json: any[] = JSON.parse(contents);
    return json.map((pkg) => new Package(pkg.packageName, pkg.packageVersion));
  }
}
