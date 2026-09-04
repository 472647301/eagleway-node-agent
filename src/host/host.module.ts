import { Global, Module } from '@nestjs/common'
import { HostInspectorService } from './host-inspector.service'
import { PrivilegedHelperService } from './privileged-helper.service'
import { ProcessRunnerService } from './process-runner.service'

@Global()
@Module({
  providers: [
    ProcessRunnerService,
    HostInspectorService,
    PrivilegedHelperService
  ],
  exports: [ProcessRunnerService, HostInspectorService, PrivilegedHelperService]
})
export class HostModule {}
