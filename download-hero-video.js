import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(ROOT, "public", "alpha-film-rebuilt.mp4");
const TEMP = OUTPUT + ".download";
const EXPECTED_SIZE = 38_310_295;
const EXPECTED_DROPBOX_HASH = "31fd17b9513c38132b4be58a4bfd896a440866637850a1162e83f279843de847";
const SOURCE_URL = "https://www.dropbox.com/scl/fi/j7z73vgypmy98kn20wnec/alpha-film-rebuilt.mp4?rlkey=d8oo1orpndhyyza177lszylm7&st=tkvouj25&raw=1";
const BLOCK_SIZE = 4 * 1024 * 1024;

async function dropboxContentHash(filePath) {
  const bytes = await readFile(filePath);
  const blockHashes = [];
  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    blockHashes.push(createHash("sha256").update(bytes.subarray(offset, offset + BLOCK_SIZE)).digest());
  }
  return createHash("sha256").update(Buffer.concat(blockHashes)).digest("hex");
}

async function isExactVideo(filePath) {
  try {
    const info = await stat(filePath);
    if (info.size !== EXPECTED_SIZE) return false;
    return (await dropboxContentHash(filePath)) === EXPECTED_DROPBOX_HASH;
  } catch {
    return false;
  }
}

await mkdir(path.dirname(OUTPUT), { recursive: true });

if (await isExactVideo(OUTPUT)) {
  console.log("Hero video already present; original file verified.");
  process.exit(0);
}

await rm(TEMP, { force: true });
let lastError;

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    console.log(`Fetching original Alpha hero video (attempt ${attempt}/3)…`);
    const response = await fetch(SOURCE_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
      headers: { "User-Agent": "alpha-terminal-build/1.0" }
    });

    if (!response.ok || !response.body) {
      throw new Error("Dropbox returned HTTP " + response.status);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("video/mp4") && !contentType.includes("application/octet-stream")) {
      throw new Error("Dropbox did not return an MP4 file (content type: " + (contentType || "unknown") + ").");
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength !== EXPECTED_SIZE) {
      throw new Error("Unexpected video size from Dropbox: " + contentLength + " bytes.");
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(TEMP, { flags: "w" }));

    const info = await stat(TEMP);
    if (info.size !== EXPECTED_SIZE) {
      throw new Error("Downloaded video size mismatch: " + info.size + " bytes.");
    }

    const actualHash = await dropboxContentHash(TEMP);
    if (actualHash !== EXPECTED_DROPBOX_HASH) {
      throw new Error("Downloaded video checksum does not match the verified original.");
    }

    await rename(TEMP, OUTPUT);
    console.log("Original 1920x1080 Alpha hero video verified and ready in public/.");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await rm(TEMP, { force: true });
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
  }
}

console.error("Could not prepare the original Alpha hero video:", lastError?.message || "unknown error");
process.exit(1);
