import { Module } from '@nestjs/common'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import { LogController } from './log.controller'
import { LogReaderService } from './log-reader.service'

@Module({
  controllers: [LogController],
  providers: [IpAllowlistGuard, LogReaderService]
})
export class LogModule {}
