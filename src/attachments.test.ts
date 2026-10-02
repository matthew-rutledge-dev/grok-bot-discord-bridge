import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_MIME,
  AttachmentError,
  MAX_ATTACHMENTS,
  decodeBase64Attachment,
  resolveJsonAttachments,
  resolveMultipartFiles,
  wakeAttachmentRefsFromDiscord,
} from "./attachments.js";

describe("attachments allowlist", () => {
  it("includes expected mimes", () => {
    assert.ok(ALLOWED_MIME.has("image/png"));
    assert.ok(ALLOWED_MIME.has("application/pdf"));
    assert.ok(ALLOWED_MIME.has("text/plain"));
    assert.ok(
      ALLOWED_MIME.has(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    assert.ok(ALLOWED_MIME.has("application/json"));
    assert.ok(ALLOWED_MIME.has("text/markdown"));
    assert.ok(ALLOWED_MIME.has("text/csv"));
    assert.ok(ALLOWED_MIME.has("application/zip"));
    assert.ok(ALLOWED_MIME.has("application/x-tar"));
    assert.ok(ALLOWED_MIME.has("application/gzip"));
    assert.ok(ALLOWED_MIME.has("application/x-7z-compressed"));
    assert.ok(ALLOWED_MIME.has("application/vnd.rar"));
    assert.equal(ALLOWED_MIME.has("application/x-msdownload"), false);
    assert.equal(ALLOWED_MIME.has("application/x-iso9660-image"), false);
    assert.equal(ALLOWED_MIME.has("application/vnd.microsoft.portable-executable"), false);
  });

  it("guesses office/code mime from filename when octet-stream", () => {
    const data = Buffer.from("hello").toString("base64");
    const r = decodeBase64Attachment({
      filename: "notes.md",
      contentType: "application/octet-stream",
      data,
    });
    assert.equal(r.contentType, "text/markdown");
    const docx = decodeBase64Attachment({
      filename: "report.docx",
      contentType: "application/octet-stream",
      data,
    });
    assert.equal(
      docx.contentType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const zip = decodeBase64Attachment({
      filename: "bundle.zip",
      contentType: "application/octet-stream",
      data,
    });
    assert.equal(zip.contentType, "application/zip");
    const tgz = decodeBase64Attachment({
      filename: "src.tar.gz",
      contentType: "application/octet-stream",
      data,
    });
    assert.equal(tgz.contentType, "application/gzip");
  });
});

describe("decodeBase64Attachment", () => {
  it("decodes a tiny png-ish buffer", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const r = decodeBase64Attachment({
      filename: "t.png",
      contentType: "image/png",
      data,
    });
    assert.equal(r.filename, "t.png");
    assert.equal(r.contentType, "image/png");
    assert.equal(r.buffer.length, 4);
  });

  it("rejects unsupported mime", () => {
    const data = Buffer.from("hi").toString("base64");
    assert.throws(
      () =>
        decodeBase64Attachment({
          filename: "x.exe",
          contentType: "application/x-msdownload",
          data,
        }),
      (e: unknown) =>
        e instanceof AttachmentError && e.code === "unsupported_media_type",
    );
  });

  it("rejects oversized buffer", () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    assert.throws(
      () =>
        decodeBase64Attachment({
          filename: "big.png",
          contentType: "image/png",
          data: big.toString("base64"),
        }),
      (e: unknown) =>
        e instanceof AttachmentError && e.code === "attachment_too_large",
    );
  });
});

describe("resolveJsonAttachments", () => {
  it("caps count at 10", async () => {
    const items = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      filename: `f${i}.png`,
      contentType: "image/png",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    }));
    await assert.rejects(
      () => resolveJsonAttachments(items),
      (e: unknown) =>
        e instanceof AttachmentError && e.code === "too_many_attachments",
    );
  });

  it("requires exactly one of data or url", async () => {
    await assert.rejects(
      () => resolveJsonAttachments([{ filename: "a.png" }]),
      (e: unknown) =>
        e instanceof AttachmentError && e.code === "invalid_attachment",
    );
  });
});

describe("resolveMultipartFiles", () => {
  it("accepts files and files[] field names", () => {
    const buf = Buffer.from("hello");
    const out = resolveMultipartFiles([
      {
        fieldname: "files",
        originalname: "a.txt",
        mimetype: "text/plain",
        buffer: buf,
        size: buf.length,
      },
      {
        fieldname: "files[]",
        originalname: "b.txt",
        mimetype: "text/plain",
        buffer: buf,
        size: buf.length,
      },
      {
        fieldname: "other",
        originalname: "skip.bin",
        mimetype: "application/octet-stream",
        buffer: buf,
        size: buf.length,
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].filename, "a.txt");
    assert.equal(out[1].filename, "b.txt");
  });
});

describe("wakeAttachmentRefsFromDiscord", () => {
  it("maps discord attachments to url refs", () => {
    const refs = wakeAttachmentRefsFromDiscord({
      attachments: {
        size: 1,
        values: function* () {
          yield {
            url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
            proxyURL: "https://media.discordapp.net/attachments/1/2/photo.png",
            name: "photo.png",
            contentType: "image/png",
            size: 1234,
          };
        },
      },
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].url, "https://cdn.discordapp.com/attachments/1/2/photo.png");
    assert.equal(refs[0].filename, "photo.png");
    assert.equal(refs[0].contentType, "image/png");
    assert.equal(refs[0].size, 1234);
  });
});
