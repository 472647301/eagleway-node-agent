import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsFQDN,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from 'class-validator'

export class NodeRequestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  nodeId!: number
}

export class ProtocolControlDto extends NodeRequestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number

  @IsFQDN({ require_tld: true })
  @MaxLength(253)
  domain!: string

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Matches(/^[^\s{};#]+$/)
  @MaxLength(2048)
  proxyUrl?: string | null
}

export class NodeUserDto {
  @IsUUID()
  assignmentId!: string

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  credential!: string
}

export class ProtocolUserSyncDto extends NodeRequestDto {
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => NodeUserDto)
  users!: NodeUserDto[]
}

export class ProtocolUserUpdateDto extends NodeRequestDto {
  @IsString()
  @IsIn(['add', 'delete'])
  action!: 'add' | 'delete'

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => NodeUserDto)
  users?: NodeUserDto[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsUUID(undefined, { each: true })
  assignmentIds?: string[]
}
