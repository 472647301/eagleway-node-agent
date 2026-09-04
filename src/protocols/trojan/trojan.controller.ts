import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { success } from '@/common/api/api-response'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import {
  NodeRequestDto,
  TrojanControlDto,
  TrojanUserSyncDto,
  TrojanUserUpdateDto
} from './trojan.dto'
import { TrojanService } from './trojan.service'

@ApiTags('trojan')
@UseGuards(IpAllowlistGuard)
@Controller('trojan')
export class TrojanController {
  constructor(private readonly service: TrojanService) {}

  @Post('install')
  @HttpCode(HttpStatus.ACCEPTED)
  async install(@Body() body: TrojanControlDto) {
    return success(await this.service.install(body))
  }

  @Post('uninstall')
  @HttpCode(HttpStatus.ACCEPTED)
  async uninstall(@Body() body: NodeRequestDto) {
    return success(await this.service.uninstall(body))
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() body: NodeRequestDto) {
    return success(await this.service.start(body))
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(@Body() body: NodeRequestDto) {
    return success(await this.service.stop(body))
  }

  @Post('user/sync')
  @HttpCode(HttpStatus.OK)
  async syncUsers(@Body() body: TrojanUserSyncDto) {
    return success(await this.service.syncUsers(body))
  }

  @Post('user/update')
  @HttpCode(HttpStatus.OK)
  async updateUsers(@Body() body: TrojanUserUpdateDto) {
    return success(await this.service.updateUsers(body))
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(@Body() body: NodeRequestDto) {
    return success(await this.service.status(body))
  }

  @Post('traffic')
  @HttpCode(HttpStatus.OK)
  async traffic(@Body() body: NodeRequestDto) {
    return success(await this.service.traffic(body))
  }
}
