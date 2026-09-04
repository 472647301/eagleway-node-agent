import { Module } from '@nestjs/common'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import { TrojanAssignmentsService } from './trojan-assignments.service'
import { TrojanController } from './trojan.controller'
import { TrojanGoClient } from './trojan-go.client'
import { TrojanProvisioningService } from './trojan-provisioning.service'
import { TrojanService } from './trojan.service'

@Module({
  controllers: [TrojanController],
  providers: [
    IpAllowlistGuard,
    TrojanGoClient,
    TrojanAssignmentsService,
    TrojanProvisioningService,
    TrojanService
  ],
  exports: [TrojanAssignmentsService, TrojanGoClient]
})
export class TrojanModule {}
