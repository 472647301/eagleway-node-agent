import { Type } from 'class-transformer'
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator'

export class LogPageDto {
  @IsString()
  @MaxLength(255)
  @Matches(/^(?!.*\.\.)[A-Za-z0-9_.-]+\.log$/)
  filename!: string

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page = 1

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize = 100
}
