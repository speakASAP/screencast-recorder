import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class EnrollDto {
  @IsString()
  @Length(1, 253)
  hostname!: string;

  /** /etc/machine-id, or its launchd equivalent on darwin. */
  @IsString()
  @Length(1, 128)
  machine_id!: string;

  @IsIn(['linux', 'darwin'])
  platform!: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  agent_version?: string;
}
