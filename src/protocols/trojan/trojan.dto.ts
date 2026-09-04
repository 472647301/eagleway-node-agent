import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsFQDN,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateNested
} from 'class-validator'

export class NodeRequestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  nodeId!: number
}

export class TrojanControlDto extends NodeRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  port?: number

  @IsOptional()
  @IsFQDN({ require_tld: true })
  @MaxLength(253)
  domain?: string

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Matches(/^[^\s{};#]+$/)
  @MaxLength(2048)
  proxyUrl?: string
}

export class NodeUserDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/)
  @MaxLength(100)
  assignmentKey!: string

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  credential!: string

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  ipLimit!: number

  @IsOptional()
  @IsNumberString({ no_symbols: true })
  @MaxLength(20)
  trafficLimitBytes!: string | null

  @IsOptional()
  @IsObject()
  connectionOptions?: Record<string, unknown> | null
}

export class TrojanUserSyncDto extends NodeRequestDto {
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => NodeUserDto)
  users!: NodeUserDto[]
}

export class TrojanUserUpdateDto extends NodeRequestDto {
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
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9_-]+$/, { each: true })
  @MaxLength(100, { each: true })
  assignmentKeys?: string[]
}
