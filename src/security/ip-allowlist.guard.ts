import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger
} from '@nestjs/common'
import type { Request } from 'express'
import { BlockList, isIP } from 'node:net'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'

@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly blockList = new BlockList()
  private readonly logger = new Logger(IpAllowlistGuard.name)

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    for (const cidr of config.allowedCidrs) {
      const [address, prefixText] = cidr.split('/')
      const family = isIP(address ?? '') === 6 ? 'ipv6' : 'ipv4'
      this.blockList.addSubnet(address!, Number(prefixText), family)
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const address = normalizeAddress(
      request.ip || request.socket.remoteAddress || ''
    )
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    if (!address || !this.blockList.check(address, family)) {
      this.logger.warn({
        event: 'security.ip_rejected',
        sourceIp: address || 'invalid'
      })
      throw new ForbiddenException('Source IP is not allowed')
    }
    return true
  }
}

export function normalizeAddress(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4) {
    return trimmed.slice(7)
  }
  return isIP(trimmed) ? trimmed : ''
}
