import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { StateStoreService } from '@/state/state-store.service'
import { XrayClient } from '@/protocols/xray/xray.client'
import { XrayService } from '@/protocols/xray/xray.service'

@Injectable()
export class TrafficReporterService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TrafficReporterService.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private consecutiveFailures = 0
  private nextAllowedAt = 0

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly state: StateStoreService,
    private readonly xray: XrayService,
    private readonly client: XrayClient
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.reportingEnabled) return
    const interval = this.config.reportIntervalSeconds * 1000
    this.timer = setInterval(() => void this.trigger(), interval)
    this.timer.unref()
    const initial = setTimeout(
      () => void this.trigger(),
      Math.min(5000, interval)
    )
    initial.unref()
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async trigger(): Promise<void> {
    if (
      this.running ||
      Date.now() < this.nextAllowedAt ||
      !this.config.centerApiUrl ||
      !this.client.isInstalled()
    ) {
      return
    }
    this.running = true
    try {
      if (!(await this.client.isActive())) return
      const protocol = this.xray.getInstalledProtocol()
      if (!protocol) return
      const report = await this.xray.trafficReport(protocol)
      const response = await fetch(
        `${this.config.centerApiUrl}/api/v1/node/traffic-report`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(report),
          redirect: 'error',
          signal: AbortSignal.timeout(20_000)
        }
      )
      if (response.status !== 204) {
        throw new Error(`Unexpected center response status: ${response.status}`)
      }
      this.consecutiveFailures = 0
      this.nextAllowedAt = 0
      this.state.markReportSuccess(report.reportedAt)
      this.logger.log({
        event: 'traffic.report_succeeded',
        reportedAt: report.reportedAt,
        users: report.users.length
      })
    } catch (error) {
      this.consecutiveFailures += 1
      const delaySeconds = Math.min(
        this.config.reportIntervalSeconds,
        2 ** Math.min(this.consecutiveFailures, 8)
      )
      this.nextAllowedAt = Date.now() + delaySeconds * 1000
      this.state.markReportFailure(new Date(this.nextAllowedAt).toISOString())
      this.logger.error({
        event: 'traffic.report_failed',
        consecutiveFailures: this.consecutiveFailures,
        errorType: error instanceof Error ? error.name : typeof error
      })
    } finally {
      this.running = false
    }
  }
}
