import { resolve } from 'path';
import { exec } from 'child_process';
import { createLogger } from '../logging';
import { promisify as p } from 'util';
import { StaticConfiguration } from '../static-configuration';

const logger = createLogger('docker', 'info');

export async function dockerizedCommand(
  command: string,
  cwd: string,
  timeoutMS: number,
  extraEnvVariables?: [string, string][]
): Promise<ExecReturn> {
  return new Promise<ExecReturn>(async (res) => {
    const dockerHomeFolder = await getHomeFolderInDockerContainer();
    let envVariablesString = '';
    if (extraEnvVariables) {
      envVariablesString = extraEnvVariables.map(([k, v]) => `--env ${k}='${v}'`).join(' ');
    }
    const dockerCommand: string = `docker run -v ${resolve(cwd)}:${resolve(
      dockerHomeFolder,
      'cwd'
    )} ${envVariablesString} --rm -t torp123/tapir:v1.1 bash -c 'cd cwd && ${command}'`;

    logger.debug(`Running: ${dockerCommand}`);
    exec(dockerCommand, { timeout: timeoutMS }, (error, stdout, stderr) => {
      res({ exit: error?.code || 0, signal: error?.signal, stdout: stdout, stderr: stderr });
    });
  });
}

export async function getHomeFolderInDockerContainer(): Promise<string> {
  // The username in the docker container is equal to the user name of the user owning the build file in the docker
  // folder. So to resolve the home folder of the docker container, we extract the owner of this file.
  const userOwningDockerBuildFile = (
    await p(exec)(`./get-file-user ./build`, { cwd: StaticConfiguration.dockerFolder })
  ).stdout.trim();
  return resolve('/home/', userOwningDockerBuildFile);
}

type ExecReturn = {
  exit: number;
  signal?: string;
  stdout: string;
  stderr: string;
};
