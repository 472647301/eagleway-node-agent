import { Module } from '@nestjs/common'
import { XrayModule } from '@/protocols/xray/xray.module'
import { TrafficReporterService } from './traffic-reporter.service'

@Module({
  imports: [XrayModule],
  providers: [TrafficReporterService]
})
export class ReportingModule {}
