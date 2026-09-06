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
