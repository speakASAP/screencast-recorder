import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One rendered object, exactly as the agent sends it.
 *
 * Field names are camelCase because that is what `RenderedArtifact` in
 * `agent/src/agent.ts` actually puts on the wire. The global pipe runs with
 * `forbidNonWhitelisted`, so a DTO declaring snake_case here would turn every
 * successful render into a 400 -- the same shape of failure that once made
 * the agent crash-loop over display offsets.
 */
export class PreviewArtifactDto {
  @IsIn(['video', 'audio']) kind!: 'video' | 'audio';

  /** Null for the video proxy, which carries no audio stream. */
  @IsOptional() @IsString() sourceRef!: string | null;

  @IsString() objectKey!: string;

  @IsInt() @Min(0) bytes!: number;

  @IsOptional() @IsInt() @Min(0) durationMs!: number | null;

  /** Measured level, audio only. Negative dB, so no Min constraint. */
  @IsOptional() @IsNumber() meanDb?: number;
  @IsOptional() @IsNumber() maxDb?: number;
}

/**
 * The agent's report at the end of a render.
 *
 * `deferred` is a first-class outcome, not a failure: it means a recording
 * was running and the render stood aside. The row returns to pending so the
 * operator can retry once capture finishes.
 */
export class PreviewCompleteDto {
  @IsUUID() agent_id!: string;

  @IsIn(['ready', 'failed', 'deferred']) state!: 'ready' | 'failed' | 'deferred';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreviewArtifactDto)
  artifacts?: PreviewArtifactDto[];

  @IsOptional() @IsIn(['local', 'storage']) source_path?: 'local' | 'storage';

  @IsOptional() @IsString() reason?: string;

  @IsOptional() @IsString() detail?: string;
}
