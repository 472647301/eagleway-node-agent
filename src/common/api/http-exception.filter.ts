import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common'
import type { Response } from 'express'
import type { ApiFailure } from './api-response'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const body = exception.getResponse()
      const normalized = normalizeHttpError(status, body)
      response.status(status).json(normalized)
      return
    }
    this.logger.error({
      event: 'http.unhandled_error',
      error: safeError(exception)
    })
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal server error'
    } satisfies ApiFailure)
  }
}

function normalizeHttpError(
  status: number,
  value: string | object
): ApiFailure {
  if (typeof value === 'object' && value) {
    const candidate = value as Record<string, unknown>
    if (
      typeof candidate.errorCode === 'string' &&
      typeof candidate.message === 'string'
    ) {
      return {
        code: status,
        errorCode: candidate.errorCode,
        message: candidate.message
      }
    }
    const message = Array.isArray(candidate.message)
      ? candidate.message
          .filter((item): item is string => typeof item === 'string')
          .join(', ')
      : typeof candidate.message === 'string'
        ? candidate.message
        : 'Request failed'
    return { code: status, errorCode: 'INVALID_REQUEST', message }
  }
  return {
    code: status,
    errorCode: status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
    message: typeof value === 'string' ? value : 'Request failed'
  }
}

function safeError(value: unknown): string {
  return value instanceof Error ? value.name : typeof value
}
