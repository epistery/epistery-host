import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { Config } from 'epistery';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, unlink, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Provisions isolated Storj storage for domain contracts using per-bucket isolation.
 * Uses the existing uplink access grant to create a domain-specific bucket,
 * derive a restricted access grant scoped to that bucket, and register
 * S3-compatible credentials via the gateway auth service.
 *
 * Root config (~/.epistery/) must contain:
 *   storj_satellite: {
 *     access: "<name of uplink access grant>",
 *     auth_service: "https://auth.storjshare.io"  (optional)
 *   }
 *
 * Requires `uplink` CLI installed with the named access grant imported.
 */
export default class StorjProvisioner {
  constructor(satelliteConfig) {
    this.accessName = satelliteConfig.access || 'epistery';
    this.authService = satelliteConfig.auth_service || 'https://auth.storjshare.io';
  }

  static async fromRootConfig() {
    const config = new Config();
    const rootData = await config.read('/');
    if (!rootData?.storj_satellite) {
      throw new Error('storj_satellite not configured in root epistery config. Set access name.');
    }
    return new StorjProvisioner(rootData.storj_satellite);
  }

  /**
   * Create a bucket using uplink CLI.
   * @param {string} bucketName
   */
  async createBucket(bucketName) {
    try {
      await execFileAsync('uplink', [
        'mb', `sj://${bucketName}`,
        '--access', this.accessName
      ], { timeout: 30000 });
      console.log(`[storj-provision] Created bucket: ${bucketName}`);
    } catch (error) {
      if (error.stderr?.includes('already exists')) {
        console.log(`[storj-provision] Bucket already exists: ${bucketName}`);
      } else if (error.code === 'ENOENT') {
        throw new Error('uplink CLI not found. Install from https://storj.dev/dcs/downloads/download-uplink-cli');
      } else {
        throw new Error(`Failed to create bucket "${bucketName}": ${error.stderr || error.message}`);
      }
    }
  }

  /**
   * Derive a restricted access grant scoped to a specific bucket.
   * @param {string} bucketName - bucket to restrict access to
   * @returns {string} - serialized restricted access grant
   */
  async restrictAccess(bucketName) {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'storj-'));
    const tmpFile = path.join(tmpDir, 'access.txt');
    try {
      await execFileAsync('uplink', [
        'access', 'restrict',
        '--access', this.accessName,
        '--prefix', `sj://${bucketName}/`,
        '--readonly=false',
        '--export-to', tmpFile
      ], { timeout: 30000 });

      const grant = (await readFile(tmpFile, 'utf8')).trim();
      if (!grant) throw new Error('uplink returned empty restricted access grant');
      console.log(`[storj-provision] Derived restricted access for bucket: ${bucketName}`);
      return grant;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('uplink CLI not found. Install from https://storj.dev/dcs/downloads/download-uplink-cli');
      }
      throw new Error(`uplink access restrict failed: ${error.stderr || error.message}`);
    } finally {
      try { await unlink(tmpFile); } catch {}
      try { await rmdir(tmpDir); } catch {}
    }
  }

  /**
   * Register an access grant with the gateway auth service to get S3 credentials.
   * @param {string} accessGrant - serialized access grant
   * @returns {object} - { access_key_id, secret_key, endpoint }
   */
  async registerS3Credentials(accessGrant) {
    const response = await fetch(`${this.authService}/v1/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_grant: accessGrant, public: false })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to register S3 credentials (${response.status}): ${text}`);
    }

    const creds = await response.json();
    console.log(`[storj-provision] Registered S3 credentials: ${creds.access_key_id}`);
    return creds;
  }

  /**
   * Full provisioning flow: create bucket, restrict access, register S3 creds.
   * @param {string} domainName - domain to provision for
   * @param {string} contractAddress - domain contract address (used as unique bucket name)
   * @returns {object} - { ACCESS_KEY, SECRET_KEY, ENDPOINT, BUCKET }
   */
  async provision(domainName, contractAddress) {
    if (!contractAddress) throw new Error('Contract address required for bucket naming');
    console.log(`[storj-provision] Provisioning private storage for ${domainName}...`);

    // Bucket name from contract address — globally unique, no collisions between developers
    const bucketName = `ep-${contractAddress.toLowerCase()}`;

    // 1. Create dedicated bucket
    await this.createBucket(bucketName);

    // 2. Derive restricted access grant scoped to this bucket
    const restrictedGrant = await this.restrictAccess(bucketName);

    // 3. Register for S3 credentials
    const s3Creds = await this.registerS3Credentials(restrictedGrant);

    const result = {
      ACCESS_KEY: s3Creds.access_key_id,
      SECRET_KEY: s3Creds.secret_key,
      ENDPOINT: s3Creds.endpoint,
      BUCKET: bucketName
    };

    console.log(`[storj-provision] Provisioning complete for ${domainName} (bucket: ${bucketName})`);
    return result;
  }
}