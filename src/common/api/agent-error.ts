import { HttpException, HttpStatus } from '@nestjs/common'

export class AgentError extends HttpException {
  constructor(
    readonly errorCode: string,
    message: string,
    status: HttpStatus
  ) {
    super({ code: status, errorCode, message }, status)
  }
}

export function invalidRequest(message: string): AgentError {
  return new AgentError('INVALID_REQUEST', message, HttpStatus.BAD_REQUEST)
}

export function operationConflict(message: string): AgentError {
  return new AgentError('OPERATION_CONFLICT', message, HttpStatus.CONFLICT)
}
