import { Global, Module } from '@nestjs/common'
import { OperationCoordinatorService } from './operation-coordinator.service'

@Global()
@Module({
  providers: [OperationCoordinatorService],
  exports: [OperationCoordinatorService]
})
export class OperationsModule {}
