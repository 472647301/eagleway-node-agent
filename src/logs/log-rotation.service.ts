import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy
} from '@nestjs/common'
import { CronJob } from 'cron'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { StateStoreService } from '@/state/state-store.service'

const filenames = ['xray-access.log', 'xray-error.log'] as const
const archivePattern =
  /^xray-(?:access|error)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/
const copyBufferBytes = 256 * 1024

@Injectable()
export class LogRotationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogRotationService.name)
  private readonly dateFormatter: Intl.DateTimeFormat
  private dailyJob: CronJob | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private pending: Promise<void> | null = null
  private stopping = false
  private retryNeeded = false
  private cleanedDate: string | null = null

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly state: StateStoreService
  ) {
    this.dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.xrayLogTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  onApplicationBootstrap(): void {
    this.dailyJob = CronJob.from({
      cronTime: '0 0 * * *',
      timeZone: this.config.xrayLogTimezone,
      onTick: () => this.trigger(),
      start: true,
      unrefTimeout: true
    })
    void this.trigger()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true
    await this.dailyJob?.stop()
    this.dailyJob = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryNeeded = false
    // Finish state writes before DatabaseService closes SQLite on shutdown.
    await this.pending
  }

  trigger(now = new Date()): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.pending) return this.pending
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryNeeded = false
    this.pending = this.rotateAndClean(now)
      .catch((error: unknown) => this.reportFailure('maintenance', error))
      .finally(() => {
        this.pending = null
        if (this.retryNeeded && !this.stopping) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            void this.trigger()
          }, 60_000)
          this.retryTimer.unref()
        }
      })
    return this.pending
  }

  private async rotateAndClean(now: Date): Promise<void> {
    const today = this.dateFormatter.format(now)
    const archiveDate = shiftDate(today, -1)
    for (const filename of filenames) {
      const key = `logs.rotation.${filename}.date`
      const previous = this.state.getMeta(key)
      if (previous && previous >= today) continue
      try {
        // A missing cursor also rotates existing logs on the first upgrade.
        await this.rotate(filename, archiveDate)
        this.state.setMeta(key, today)
      } catch (error) {
        this.reportFailure(filename, error)
      }
    }

    if (this.cleanedDate !== today) {
      await this.cleanArchives(
        shiftDate(today, -this.config.xrayLogRetentionDays)
      )
      this.cleanedDate = today
    }
  }

  private async rotate(filename: string, date: string): Promise<void> {
    const path = join(this.config.logDir, filename)
    try {
      if (!(await lstat(path)).isFile()) {
        throw new Error('Xray log path is not a regular file')
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }

    const source = await open(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const temporaryPath = join(this.config.logDir, `.${filename}.rotation.tmp`)
    try {
      const stats = await source.stat()
      if (!stats.isFile())
        throw new Error('Xray log path is not a regular file')
      // Remove a partial copy left by an interrupted rotation, never an archive.
      await removeTemporary(temporaryPath)
      if (stats.size === 0) return

      const temporary = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o640
      )
      try {
        // Copy only the initial size so a busy writer cannot extend the job forever.
        const buffer = Buffer.allocUnsafe(copyBufferBytes)
        let position = 0
        while (position < stats.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, stats.size - position),
            position
          )
          if (bytesRead === 0)
            throw new Error('Xray log changed during rotation')
          let written = 0
          while (written < bytesRead) {
            const { bytesWritten } = await temporary.write(
              buffer,
              written,
              bytesRead - written
            )
            if (bytesWritten === 0)
              throw new Error('Xray log archive write failed')
            written += bytesWritten
          }
          position += bytesRead
        }
        await temporary.sync()
      } finally {
        await temporary.close()
      }

      const archive = await this.publishArchive(temporaryPath, filename, date)
      // Keep the inode and permissions used by Xray's existing append descriptor.
      // Entries appended after the snapshot may be lost, as with copytruncate.
      await source.truncate(0)
      this.logger.log({ event: 'logs.rotated', filename, archive })
    } finally {
      try {
        await removeTemporary(temporaryPath)
      } finally {
        await source.close()
      }
    }
  }

  private async publishArchive(
    temporaryPath: string,
    filename: string,
    date: string
  ): Promise<string> {
    const stem = `${filename.slice(0, -4)}-${date}`
    for (let index = 0; ; index += 1) {
      const archive = `${stem}${index === 0 ? '' : `-${index}`}.log`
      try {
        // A hard link publishes the complete file atomically without overwriting
        // an existing archive, including retries after an interrupted rotation.
        await link(temporaryPath, join(this.config.logDir, archive))
        return archive
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
    }
  }

  private async cleanArchives(cutoff: string): Promise<void> {
    let entries
    try {
      entries = await readdir(this.config.logDir, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const match = archivePattern.exec(entry.name)
      if (entry.isFile() && match && match[1]! < cutoff) {
        await unlink(join(this.config.logDir, entry.name))
      }
    }
  }

  private reportFailure(filename: string, error: unknown): void {
    this.logger.error({
      event: 'logs.rotation_failed',
      filename,
      code: errorCode(error) ?? 'ROTATION_FAILED'
    })
    this.retryNeeded = true
  }
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}
