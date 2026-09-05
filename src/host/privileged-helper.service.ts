import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { ProcessRunnerService } from './process-runner.service'

export type HelperAction =
  'xray-install' | 'xray-uninstall' | 'xray-start' | 'xray-stop'

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
    await this.processes.run(executable, args, {
      timeoutMs: this.config.operationTimeoutSeconds * 1000,
      maxOutputBytes: 262_144
    })
  }
}
