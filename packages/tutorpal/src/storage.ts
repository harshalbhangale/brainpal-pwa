import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Where uploaded bytes live. Keys are always generated server-side. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export class S3BlobStore implements BlobStore {
  private readonly client = new S3Client({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });

  constructor(private readonly bucket: string) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!object.Body) throw new Error(`object ${key} has no body`);
    return object.Body.transformToByteArray();
  }
}

/** For development and tests: files on disk, under one root they cannot escape. */
export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error("storage key escapes the store");
    return path;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
}

let store: BlobStore | undefined;

export function blobStore(): BlobStore {
  if (!store) {
    const bucket = process.env["UPLOADS_BUCKET"];
    if (bucket) store = new S3BlobStore(bucket);
    else if (process.env["NODE_ENV"] === "production") throw new Error("UPLOADS_BUCKET is required in production");
    else store = new LocalBlobStore(process.env["LOCAL_UPLOADS_DIR"] ?? ".data/uploads");
  }
  return store;
}

export function setBlobStore(next: BlobStore): void {
  store = next;
}
