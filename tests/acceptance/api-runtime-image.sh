#!/bin/sh
set -eu

# Run against a built API image without attaching production data or a network.
image="${1:?Usage: sh tests/acceptance/api-runtime-image.sh IMAGE}"

docker run --rm --network none --user node --entrypoint node "$image" -e '
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

(async () => {
  const required = ["@nestjs/core", "@nestjs/swagger", "@prisma/client", "@ufm/storage-plugin-sdk", "sharp", "archiver", "yauzl"];
  for (const name of required) require(name);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  await prisma.$disconnect();

  const png = await require("sharp")(Buffer.from([255, 0, 0, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  }).png().toBuffer();
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const prismaVersion = execFileSync("/app/node_modules/.bin/prisma", ["--version"], { encoding: "utf8" });
  assert.match(prismaVersion, /Schema Engine/);
  const ffmpegVersion = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" });
  assert.match(ffmpegVersion, /ffmpeg version/);

  for (const directory of ["/app/storage", "/app/storage-plugins"]) {
    const file = path.join(directory, `runtime-image-check-${process.pid}`);
    fs.writeFileSync(file, "ok");
    assert.equal(fs.readFileSync(file, "utf8"), "ok");
    fs.unlinkSync(file);
  }

  for (const name of ["element-plus", "vue", "@ufm/web", "@ufm/storage-qiniu", "@ufm/storage-upyun",
    "@ufm/storage-aliyun", "@ufm/storage-aliyun-drive", "@ufm/storage-s3", "@ufm/storage-cloudflare-r2"]) {
    assert.throws(() => fs.lstatSync(path.join("/app/node_modules", name)), error => error.code === "ENOENT",
      `API runtime unexpectedly contains workspace files for ${name}`);
    assert.throws(() => require.resolve(name), error => error.code === "MODULE_NOT_FOUND",
      `API runtime unexpectedly contains ${name}`);
  }
  console.log(JSON.stringify({ ok: true, uid: process.getuid(), required, sharpPngBytes: png.length,
    prisma: true, ffmpeg: true, storageWritable: true, frontendAndPluginWorkspacesAbsent: true }));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
'
