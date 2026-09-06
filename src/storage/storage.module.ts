import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { S3_BUCKET, S3_CLIENT, StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      useFactory: (): S3Client =>
        new S3Client({
          endpoint: process.env.MINIO_ENDPOINT_URL ?? 'https://minio.alfares.cz',
          region: process.env.MINIO_REGION ?? 'us-east-1',
          // MinIO serves buckets as path segments, not as subdomains.
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
            secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
          },
        }),
    },
    {
      provide: S3_BUCKET,
      useFactory: (): string => process.env.MINIO_BUCKET ?? 'screencast-sessions',
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
