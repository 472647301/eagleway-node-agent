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
import { LogPageDto } from './log.dto'
import { LogReaderService } from './log-reader.service'

@ApiTags('log')
@UseGuards(IpAllowlistGuard)
@Controller('log')
export class LogController {
  constructor(private readonly logs: LogReaderService) {}

  @Post('files')
  @HttpCode(HttpStatus.OK)
  files() {
    return success(this.logs.files())
  }

  @Post('pages')
  @HttpCode(HttpStatus.OK)
  pages(@Body() body: LogPageDto) {
    return success(this.logs.page(body))
  }
}
