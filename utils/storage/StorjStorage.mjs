import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Config } from 'epistery';

/**
 * S3-compatible storage adapter.
 * Works with any S3-compatible provider: Storj, AWS S3, Backblaze B2, MinIO, etc.
 *
 * Credential resolution: domain config `[storj]` → root config `[storj]`
 * Prefix: {contract_address}/{agentName}/ for namespace isolation
 */
export default class StorjStorage {
  constructor(domain = 'localhost', agentName = 'wiki') {
    this.client = null;
    this.bucket = null;
    this.domain = domain;
    this.agentName = agentName;
    this.prefix = null;
    this.initialized = false;
  }

  /**
   * Initialize S3 client from config
   */
  async initialize() {
    if (this.initialized) return;

    try {
      const config = new Config();
      const domainConfig = config.read(this.domain);
      const rootConfig = config.read('/');

      const storjConfig = domainConfig.storj || rootConfig.storj;
      if (!storjConfig) {
        throw new Error('S3 storage configuration not found in domain or root config');
      }

      const accessKey = storjConfig.ACCESS_KEY;
      const secretKey = storjConfig.SECRET_KEY;
      const endpoint = storjConfig.ENDPOINT;
      const bucket = storjConfig.BUCKET;

      if (!accessKey || !secretKey || !bucket) {
        throw new Error('S3 credentials incomplete. Required: ACCESS_KEY, SECRET_KEY, BUCKET');
      }

      // Namespace by contract address within shared bucket
      const contractAddress = domainConfig.contract_address;
      if (!contractAddress) {
        throw new Error('Contract address not found in domain config');
      }
      this.prefix = `${contractAddress}/${this.agentName}/`;
      this.bucket = bucket;

      const clientConfig = {
        region: storjConfig.REGION || 'us-east-1',
        credentials: {
          accessKeyId: accessKey,
          secretAccessKey: secretKey
        },
        forcePathStyle: true
      };
      // Custom endpoint for non-AWS providers (Storj, MinIO, B2, etc.)
      if (endpoint) {
        clientConfig.endpoint = endpoint;
      }

      this.client = new S3Client(clientConfig);
      this.initialized = true;
      console.log(`[${this.agentName}:storj] Initialized: ${this.bucket}/${this.prefix}`);
    } catch (error) {
      console.error(`[${this.agentName}:storj] Failed to initialize:`, error.message);
      throw error;
    }
  }

  /**
   * Save a file
   */
  async writeFile(key, content) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: typeof content === 'string' ? Buffer.from(content) : content,
        ContentType: key.endsWith('.json') ? 'application/json' : 'text/plain'
      });

      await this.client.send(command);
      console.log(`[${this.agentName}:storj] Wrote: ${fullKey}`);
      return true;
    } catch (error) {
      console.error(`[${this.agentName}:storj] Failed to write ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Read a file
   */
  async readFile(key) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey
      });

      const response = await this.client.send(command);
      const chunks = [];

      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      return buffer;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error(`File not found: ${key}`);
      }
      console.error(`[${this.agentName}:storj] Failed to read ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async exists(key) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * List files with a prefix
   */
  async listFiles(prefix = '') {
    await this.initialize();

    try {
      const fullPrefix = this.prefix + prefix;
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix
      });

      const response = await this.client.send(command);
      // Strip domain prefix from returned keys
      return (response.Contents || []).map(item =>
        item.Key.startsWith(this.prefix) ? item.Key.slice(this.prefix.length) : item.Key
      );
    } catch (error) {
      console.error(`[${this.agentName}:storj] Failed to list files:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(key) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: fullKey
      });

      await this.client.send(command);
      console.log(`[${this.agentName}:storj] Deleted: ${fullKey}`);
      return true;
    } catch (error) {
      console.error(`[${this.agentName}:storj] Failed to delete ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Delete multiple files
   */
  async deleteFiles(keys) {
    await this.initialize();

    const deletePromises = keys.map(key => this.deleteFile(key));
    const results = await Promise.allSettled(deletePromises);

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`[${this.agentName}:storj] Deleted ${succeeded} files, ${failed} failed`);
    return { succeeded, failed };
  }
}
