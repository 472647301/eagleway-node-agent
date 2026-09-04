import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from '@nestjs/common'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'

@Injectable()
export class DatabaseService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private connection: Database.Database | null = null

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 })
    const database = new Database(join(this.config.stateDir, 'state.db'))
    database.pragma('journal_mode = WAL')
    database.pragma('busy_timeout = 5000')
    database.pragma('foreign_keys = ON')
    database.pragma('synchronous = FULL')
    this.connection = database
    this.migrate()
  }

  onApplicationShutdown(): void {
    this.connection?.close()
    this.connection = null
  }

  get db(): Database.Database {
    if (!this.connection) throw new Error('State database is not initialized')
    return this.connection
  }

  private migrate(): void {
    const db = this.db
    const version = db.pragma('user_version', { simple: true }) as number
    if (version > 1) {
      throw new Error(`Unsupported state database version: ${version}`)
    }
    if (version === 0) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE managed_users (
            assignment_key TEXT PRIMARY KEY,
            encrypted_credential TEXT NOT NULL,
            protocol TEXT NOT NULL,
            runtime TEXT NOT NULL,
            runtime_user_hash TEXT NOT NULL,
            ip_limit INTEGER NOT NULL CHECK (ip_limit >= 0),
            traffic_limit_bytes TEXT NULL,
            synced_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX managed_users_runtime_hash
            ON managed_users(protocol, runtime_user_hash);

          CREATE TABLE operations (
            operation_id TEXT PRIMARY KEY,
            operation_type TEXT NOT NULL,
            protocol TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            state TEXT NOT NULL,
            current_stage TEXT NOT NULL,
            previous_runtime_state TEXT NULL,
            error_code TEXT NULL,
            error_message_safe TEXT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT NULL
          );
          CREATE INDEX operations_active
            ON operations(protocol, state, started_at);
          CREATE INDEX operations_fingerprint
            ON operations(protocol, operation_type, request_fingerprint);

          CREATE TABLE report_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_reported_at TEXT NULL,
            last_success_at TEXT NULL,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            next_retry_at TEXT NULL
          );
          INSERT INTO report_state(id) VALUES (1);

          CREATE TABLE owned_resources (
            resource_type TEXT NOT NULL,
            resource_name TEXT NOT NULL,
            ownership_tag TEXT NOT NULL,
            created_at TEXT NOT NULL,
            removed_at TEXT NULL,
            PRIMARY KEY(resource_type, resource_name)
          );

          CREATE TABLE agent_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `)
        db.pragma('user_version = 1')
      })()
    }
  }
}
