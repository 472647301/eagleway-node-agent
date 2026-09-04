import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface ProcessOptions {
  timeoutMs?: number
  rejectOnNonZero?: boolean
  maxOutputBytes?: number
  cwd?: string
}

export class ProcessExecutionError extends Error {
  readonly errorCode = 'PROCESS_FAILED'
  readonly safeMessage: string

  constructor(
    readonly executable: string,
    readonly exitCode: number | null,
    message = 'Host command failed'
  ) {
    super(message)
    this.name = ProcessExecutionError.name
    this.safeMessage = message
  }
}

@Injectable()
export class ProcessRunnerService {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    if (!executable || executable.includes('\0')) {
      throw new Error('Executable is invalid')
    }
    for (const arg of args) {
      if (arg.includes('\0')) throw new Error('Process argument is invalid')
    }
    const timeoutMs = options.timeoutMs ?? 20_000
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let outputExceeded = false
      const append = (
        current: Buffer[],
        currentBytes: number,
        chunk: Buffer
      ): number => {
        if (currentBytes + chunk.length > maxOutputBytes) {
          outputExceeded = true
          child.kill('SIGKILL')
          return currentBytes
        }
        current.push(chunk)
        return currentBytes + chunk.length
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes = append(stdout, stdoutBytes, chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = append(stderr, stderrBytes, chunk)
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      timer.unref()
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(
          new ProcessExecutionError(
            executable,
            null,
            error.name === 'AbortError'
              ? 'Host command timed out'
              : 'Host command failed'
          )
        )
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (outputExceeded) {
          reject(
            new ProcessExecutionError(
              executable,
              code,
              'Host command output exceeded limit'
            )
          )
          return
        }
        const result = {
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8').trim(),
          stderr: Buffer.concat(stderr).toString('utf8').trim()
        }
        if ((options.rejectOnNonZero ?? true) && result.code !== 0) {
          reject(new ProcessExecutionError(executable, result.code))
          return
        }
        resolve(result)
      })
    })
  }
}
