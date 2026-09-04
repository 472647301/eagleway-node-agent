import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import compression from 'compression'
import helmet from 'helmet'
import { AppModule } from './app.module'
import { APP_CONFIG, type AppConfig } from './config/app-config'
import { HttpExceptionFilter } from './common/api/http-exception.filter'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  const config = app.get<AppConfig>(APP_CONFIG)
  app.setGlobalPrefix('api')
  app.set('trust proxy', config.trustProxy ? 'loopback' : false)
  app.use(helmet())
  app.use(compression())
  app.useGlobalFilters(new HttpExceptionFilter())
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  )
  app.enableShutdownHooks()
  await app.listen(config.port, config.host)
}

void bootstrap()
