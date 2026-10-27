declare module 'ali-oss' {
  interface OssClient {
    put(key: string, body: Buffer, options?: Record<string, unknown>): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    head(key: string): Promise<unknown>;
    signatureUrl(key: string, options?: Record<string, unknown>): string;
    calculatePostSignature(policy: Record<string, unknown>): { policy: string; signature: string };
  }

  const OSS: new (options: Record<string, unknown>) => OssClient;
  export default OSS;
}
