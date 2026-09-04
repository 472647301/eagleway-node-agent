import { Module } from '@nestjs/common'
import { HealthController } from './health/health.controller'
import { StateModule } from './state/state.module'
import { OperationsModule } from './operations/operations.module'
import { AgentConfigModule } from './config/config.module'
import { HostModule } from './host/host.module'
import { TrojanModule } from './protocols/trojan/trojan.module'
import { ReportingModule } from './reporting/reporting.module'
import { LogModule } from './logs/log.module'

@Module({
  imports: [
    AgentConfigModule,
    StateModule,
    OperationsModule,
    HostModule,
    TrojanModule,
    ReportingModule,
    LogModule
  ],
  controllers: [HealthController],
  providers: []
})
export class AppModule {}
