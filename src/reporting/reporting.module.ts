import { Module } from '@nestjs/common'
import { TrojanModule } from '@/protocols/trojan/trojan.module'
import { TrafficReporterService } from './traffic-reporter.service'

@Module({
  imports: [TrojanModule],
  providers: [TrafficReporterService]
})
export class ReportingModule {}
