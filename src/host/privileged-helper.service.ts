import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import {
  ProcessExecutionError,
  ProcessRunnerService
} from './process-runner.service'

export type HelperAction =
  | 'xray-install'
  | 'xray-apply-config'
  | 'xray-uninstall'
  | 'xray-start'
  | 'xray-stop'

@Injectable()
export class PrivilegedHelperService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processes: ProcessRunnerService
  ) {}

  async run(action: HelperAction, planPath?: string): Promise<void> {
    const helperArgs = planPath ? [action, planPath] : [action]
    const executable =
      process.getuid?.() === 0 ? this.config.privilegedHelper : '/usr/bin/sudo'
    const args =
      executable === this.config.privilegedHelper
        ? helperArgs
        : [this.config.privilegedHelper, ...helperArgs]
    try {
      await this.processes.run(executable, args, {
        timeoutMs: this.config.operationTimeoutSeconds * 1000,
        maxOutputBytes: 262_144
      })
    } catch (error) {
      if (!(error instanceof ProcessExecutionError)) throw error
      throw new ProcessExecutionError(
        error.executable,
        error.exitCode,
        helperSafeMessage(error.stderr) ?? error.safeMessage,
        error.stdout,
        error.stderr
      )
    }
  }
}

function helperSafeMessage(stderr: string): string | null {
  const message = stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!message) return null
  return message.replace(/[^A-Za-z0-9 .,:()_/@=%+'-]/g, ' ').slice(-500)
}
