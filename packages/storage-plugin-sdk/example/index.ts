import { S3Adapter } from '@ufm/storage-plugin-sdk';
export function createAdapter() { return new S3Adapter('EXAMPLE_S3'); }
