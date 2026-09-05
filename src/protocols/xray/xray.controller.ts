import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { success } from '@/common/api/api-response'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import {
  NodeRequestDto,
  ProtocolControlDto,
  ProtocolUserSyncDto,
  ProtocolUserUpdateDto
} from './xray.dto'
import { XrayService } from './xray.service'

@ApiTags('protocols')
@UseGuards(IpAllowlistGuard)
@Controller(':protocol')
export class XrayController {
  constructor(private readonly service: XrayService) {}

  @Post('install')
  @HttpCode(HttpStatus.ACCEPTED)
  async install(
    @Param('protocol') protocol: string,
    @Body() body: ProtocolControlDto
  ) {
    return success(await this.service.install(protocol, body))
  }

  @Post('uninstall')
  @HttpCode(HttpStatus.ACCEPTED)
  async uninstall(
    @Param('protocol') protocol: string,
    @Body() body: NodeRequestDto
  ) {
    return success(await this.service.uninstall(protocol, body))
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('protocol') protocol: string,
    @Body() body: NodeRequestDto
  ) {
    return success(await this.service.start(protocol, body))
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(
    @Param('protocol') protocol: string,
    @Body() body: NodeRequestDto
  ) {
    return success(await this.service.stop(protocol, body))
  }

  @Post('user/sync')
  @HttpCode(HttpStatus.OK)
  async syncUsers(
    @Param('protocol') protocol: string,
    @Body() body: ProtocolUserSyncDto
  ) {
    return success(await this.service.syncUsers(protocol, body))
  }

  @Post('user/update')
  @HttpCode(HttpStatus.OK)
  async updateUsers(
    @Param('protocol') protocol: string,
    @Body() body: ProtocolUserUpdateDto
  ) {
    return success(await this.service.updateUsers(protocol, body))
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(
    @Param('protocol') protocol: string,
    @Body() body: NodeRequestDto
  ) {
    return success(await this.service.status(protocol, body))
  }

  @Post('traffic')
  @HttpCode(HttpStatus.OK)
  async traffic(
    @Param('protocol') protocol: string,
    @Body() body: NodeRequestDto
  ) {
    return success(await this.service.traffic(protocol, body))
  }
}
