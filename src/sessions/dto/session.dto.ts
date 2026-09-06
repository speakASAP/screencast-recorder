import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class TrackRequestDto {
  @IsUUID() agent_id!: string;
  @IsIn(['screen', 'audio', 'webcam', 'metadata']) kind!: string;
  @IsString() source_ref!: string;
  @IsOptional() @IsString() codec?: string;
  @IsOptional() @IsInt() @Min(1) fps?: number;
  @IsOptional() @IsInt() @Min(1) segment_seconds?: number;
  @IsOptional() @IsInt() @Min(1) sample_hz?: number;
  @IsOptional() @IsInt() @Min(1) bitrate_kbps?: number;
}

export class CreateSessionDto {
  @IsString() @Length(1, 200) title!: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => TrackRequestDto)
  tracks!: TrackRequestDto[];

  @IsOptional() @IsInt() @Min(0) min_free_gb?: number;
}

export class ClockReportDto {
  @IsBoolean() synchronised!: boolean;
  @IsInt() offset_ms!: number;
  @IsOptional() @IsString() source?: string;
}

export class StatusDto {
  @IsOptional() @IsUUID() command_id?: string;
  @IsUUID() agent_id!: string;

  @IsIn(['ready', 'recording', 'stopping', 'stopped', 'failed'])
  state!: string;

  @IsOptional() @ValidateNested() @Type(() => ClockReportDto)
  clock?: ClockReportDto;

  @IsOptional() @IsInt() free_disk_bytes?: number;

  /** Required when state is failed; one of the contract's closed reason set. */
  @IsOptional() @IsString() reason?: string;
}

export class TrackProgressDto {
  @IsUUID() track_id!: string;
  @IsInt() @Min(0) segments!: number;
  @IsInt() @Min(0) bytes!: number;
  @IsOptional() @IsBoolean() degraded?: boolean;
}

export class ProgressDto {
  @IsUUID() agent_id!: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => TrackProgressDto)
  tracks!: TrackProgressDto[];

  @IsOptional() @IsInt() free_disk_bytes?: number;

  /**
   * Display-only. Never persisted and never logged: a window title can carry a
   * file path, a customer name, or a credential pasted into a terminal.
   */
  @IsOptional() @IsString() active_window?: string;
}
