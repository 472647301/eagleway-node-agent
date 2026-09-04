import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '@/app.module'
import { HttpExceptionFilter } from '@/common/api/http-exception.filter'

test('status API enforces node identity and the frozen response envelope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-api-'))
  const previous = { ...process.env }
  const logDirectory = join(directory, 'logs')
  mkdirSync(logDirectory)
  writeFileSync(
    join(logDirectory, 'agent.log'),
    `${JSON.stringify({
      timestamp: '2026-09-04T00:00:00.000Z',
      level: 'info',
      context: 'Agent',
      message: 'started'
    })}\n`
  )
  Object.assign(process.env, {
    NODE_ENV: 'test',
    NODE_ID: '42',
    REPORTING_ENABLED: 'false',
    ALLOWED_CIDRS: '127.0.0.1/32,::1/128',
    STATE_DIR: directory,
    STATE_KEY_PATH: join(directory, 'state.key'),
    LOG_DIR: logDirectory,
    TROJAN_GO_POLICY_PATH: join(directory, 'runtime-policy.json')
  })

  const module = await Test.createTestingModule({
    imports: [AppModule]
  }).compile()
  const app = module.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new HttpExceptionFilter())
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  )

  try {
    await app.init()
    const response = await request(app.getHttpServer())
      .post('/api/trojan/status')
      .send({ nodeId: 42 })
      .expect(200)
    assert.equal(response.body.code, 0)
    assert.deepEqual(
      {
        nodeId: response.body.data.nodeId,
        protocol: response.body.data.protocol,
        runtime: response.body.data.runtime,
        state: response.body.data.state
      },
      {
        nodeId: 42,
        protocol: 'trojan',
        runtime: 'trojan-go',
        state: 'not_installed'
      }
    )

    const rejected = await request(app.getHttpServer())
      .post('/api/trojan/status')
      .send({ nodeId: 7 })
      .expect(403)
    assert.equal(rejected.body.errorCode, 'NODE_ID_MISMATCH')

    const files = await request(app.getHttpServer())
      .post('/api/log/files')
      .send({})
      .expect(200)
    assert.deepEqual(files.body, { code: 0, data: ['agent.log'] })

    const logs = await request(app.getHttpServer())
      .post('/api/log/pages')
      .send({ filename: 'agent.log', page: 1, pageSize: 100 })
      .expect(200)
    assert.equal(logs.body.code, 0)
    assert.equal(logs.body.data.total, 1)
    assert.deepEqual(logs.body.data.data[0], {
      timestamp: '2026-09-04T00:00:00.000Z',
      level: 'INFO',
      category: 'Agent',
      message: 'started',
      raw: JSON.stringify({
        timestamp: '2026-09-04T00:00:00.000Z',
        level: 'info',
        context: 'Agent',
        message: 'started'
      })
    })

    const invalidLogRequest = await request(app.getHttpServer())
      .post('/api/log/pages')
      .send({ filename: '../agent.log', page: 1, pageSize: 100 })
      .expect(400)
    assert.equal(invalidLogRequest.body.errorCode, 'INVALID_REQUEST')

    await request(app.getHttpServer())
      .post('/api/log/pages')
      .send({ filename: 'agent.log', page: 1, pageSize: 501 })
      .expect(400)
  } finally {
    await app.close()
    process.env = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
