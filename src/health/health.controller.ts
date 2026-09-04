import { Controller, Get } from '@nestjs/common'
import { success } from '@/common/api/api-response'

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return success({ status: 'ok', time: new Date().toISOString() })
  }
}
