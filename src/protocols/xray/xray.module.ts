import { Module } from '@nestjs/common'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import { XrayAssignmentsService } from './xray-assignments.service'
import { XrayClient } from './xray.client'
import { XrayController } from './xray.controller'
import { XrayProvisioningService } from './xray-provisioning.service'
import { XrayService } from './xray.service'

@Module({
  controllers: [XrayController],
  providers: [
    IpAllowlistGuard,
    XrayClient,
    XrayAssignmentsService,
    XrayProvisioningService,
    XrayService
  ],
  exports: [XrayClient, XrayService]
})
export class XrayModule {}
