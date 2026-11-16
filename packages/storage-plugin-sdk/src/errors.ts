/** Transport-neutral storage error. getStatus preserves older adapter consumers without NestJS. */
export class StoragePluginError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = 'StoragePluginError'; }
  getStatus(): number { return this.statusCode; }
}
