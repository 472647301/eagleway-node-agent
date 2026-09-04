export interface ApiSuccess<T> {
  code: 0
  data: T
  message?: string
}

export interface ApiFailure {
  code: number
  errorCode: string
  message: string
}

export function success<T>(data: T, message?: string): ApiSuccess<T> {
  return message ? { code: 0, data, message } : { code: 0, data }
}
