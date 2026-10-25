import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { DocumentStore } from './document-store.js';
import { requireId } from './errors.js';

/** Tenant prefixes are constructed from validated identifiers, never supplied paths. */
export class S3DocumentStore implements DocumentStore {
  constructor(private bucket: string, private client = new S3Client({})) {
    if (!bucket) throw new Error('DOCUMENTS_BUCKET is required');
  }
  forTenant(tenantId: string) {
    const prefix = `tenants/${requireId(tenantId)}/`;
    const key = (id: string) => `${prefix}${requireId(id)}`;
    return {
      put: async (id: string, content: Uint8Array) => {
        await this.client.send(new PutObjectCommand({Bucket: this.bucket, Key: key(id), Body: content,
          ContentType: 'application/octet-stream', ServerSideEncryption: 'AES256'}));
      },
      get: async (id: string) => {
        try {
          const result = await this.client.send(new GetObjectCommand({Bucket: this.bucket, Key: key(id)}));
          if (!result.Body) throw new Error('Empty S3 response');
          return await result.Body.transformToByteArray();
        } catch (error) {
          if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
          throw error;
        }
      },
      remove: async (id: string) => { await this.client.send(new DeleteObjectCommand({Bucket: this.bucket, Key: key(id)})); }
    };
  }
}
