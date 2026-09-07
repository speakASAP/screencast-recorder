import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class DisplayDto {
  @IsString() id!: string;
  @IsInt() width!: number;
  @IsInt() height!: number;

  /**
   * Position within the X screen.
   *
   * Load-bearing rather than informational: x11grab captures at `:0.0+X,Y`, so
   * without the offset every monitor on a multi-head seat records the primary
   * one. Negative values are legal — a monitor can sit left of or above the
   * origin — so these are not constrained to non-negative.
   */
  @IsOptional() @IsInt() x?: number;
  @IsOptional() @IsInt() y?: number;

  @IsOptional() @IsInt() refresh_hz?: number;
  @IsOptional() @IsBoolean() primary?: boolean;
}

export class AudioInputDto {
  @IsString() id!: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() channels?: number;
}

export class CameraDto {
  @IsString() id!: string;
  @IsOptional() @IsString() label?: string;
}

export class ClockDto {
  @IsBoolean() synchronised!: boolean;
  @IsInt() offset_ms!: number;
  @IsOptional() @IsString() source?: string;
}

export class CapabilitiesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DisplayDto)
  displays!: DisplayDto[];

  @IsArray() @ValidateNested({ each: true }) @Type(() => AudioInputDto)
  audio_inputs!: AudioInputDto[];

  /** Empty is the normal state on a host with no camera, not an error. */
  @IsArray() @ValidateNested({ each: true }) @Type(() => CameraDto)
  cameras!: CameraDto[];

  @IsOptional() @IsArray() @IsString({ each: true })
  encoders?: string[];

  @IsOptional() @IsString()
  session_type?: string;

  @IsOptional() @IsInt()
  free_disk_bytes?: number;

  @IsOptional() @ValidateNested() @Type(() => ClockDto)
  clock?: ClockDto;
}
