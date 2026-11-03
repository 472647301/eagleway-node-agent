import { Module } from '@nestjs/common'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import { LogController } from './log.controller'
import { LogReaderService } from './log-reader.service'
import { LogRotationService } from './log-rotation.service'

@Module({
  controllers: [LogController],
  providers: [IpAllowlistGuard, LogReaderService, LogRotationService]
})
export class LogModule {}
