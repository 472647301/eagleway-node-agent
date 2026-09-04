import { Global, Module } from '@nestjs/common'
import { CredentialVaultService } from './credential-vault.service'
import { DatabaseService } from './database.service'
import { StateStoreService } from './state-store.service'

@Global()
@Module({
  providers: [DatabaseService, CredentialVaultService, StateStoreService],
  exports: [DatabaseService, CredentialVaultService, StateStoreService]
})
export class StateModule {}
