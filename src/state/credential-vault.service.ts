import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'

@Injectable()
export class CredentialVaultService implements OnApplicationBootstrap {
  private key: Buffer | null = null

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    const path = this.config.stateKeyPath
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    chmodSync(path, 0o600)
    const key = readFileSync(path)
    if (key.length !== 32)
      throw new Error('State encryption key must be 32 bytes')
    this.key = key
  }

  encrypt(value: string): string {
    const key = this.requireKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final()
    ])
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url')
    ].join(':')
  }

  decrypt(value: string): string {
    const [version, ivText, tagText, ciphertextText, extra] = value.split(':')
    if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra) {
      throw new Error('Encrypted credential format is invalid')
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.requireKey(),
      Buffer.from(ivText, 'base64url')
    )
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final()
    ]).toString('utf8')
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('Credential vault is not initialized')
    return this.key
  }
}
