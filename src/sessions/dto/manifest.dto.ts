import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class SegmentDto {
  @IsInt() @Min(0) index!: number;
  @IsString() file!: string;
  @IsInt() @Min(0) start_ms!: number;
  @IsInt() @Min(0) end_ms!: number;
  @IsInt() @Min(0) bytes!: number;
}

export class ManifestTrackDto {
  @IsUUID() track_id!: string;
  @IsString() kind!: string;
  @IsString() source_ref!: string;
  @IsOptional() @IsString() codec?: string;
  @IsOptional() @IsInt() fps?: number;
  @IsOptional() @IsInt() pts_origin_ms?: number;

  @IsArray() @ValidateNested({ each: true }) @Type(() => SegmentDto)
  segments!: SegmentDto[];
}

export class ManifestDto {
  @IsUUID() agent_id!: string;

  /** Used to build the per-agent object prefix; the S3 layout is per hostname. */
  @IsOptional() @IsString() hostname?: string;

  @IsString() started_at!: string;
  @IsString() ended_at!: string;

  @IsOptional() @IsInt() clock_offset_ms?: number;

  @IsArray() @ValidateNested({ each: true }) @Type(() => ManifestTrackDto)
  tracks!: ManifestTrackDto[];
}

export class UploadCompleteDto {
  @IsUUID() agent_id!: string;
  @IsInt() @Min(0) objects!: number;
  @IsInt() @Min(0) bytes!: number;

  /**
   * The agent's own verdict. Recorded, but never sufficient: the API confirms
   * against S3 before marking a session stored.
   */
  @IsOptional() @IsBoolean() verified?: boolean;
}
