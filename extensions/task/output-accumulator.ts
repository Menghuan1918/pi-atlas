/**
 * Simplified OutputAccumulator.
 *
 * The pi-coding-agent package does not export its OutputAccumulator, so we
 * provide a slimmed-down re-implementation that covers the needs of the Task
 * extension: incremental append with bounded memory, tail-truncated snapshots
 * for display, and a temp file for full output when truncation occurs.
 *
 * The truncation logic (maxLines / maxBytes, tail-keeping) is delegated to the
 * exported `truncateTail` helper from pi-coding-agent to stay consistent with
 * the native bash tool.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface OutputAccumulatorOptions {
  maxLines?: number;
  maxBytes?: number;
  tempFilePrefix?: string;
}

export interface OutputSnapshot {
  /** Truncated tail content for display. */
  content: string;
  truncation: TruncationResult;
  /** Path to the full (untruncated) output when truncation occurred. */
  fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends raw Buffer chunks with a streaming UTF-8 decoder, keeps only a
 * decoded tail for display snapshots, and opens a temp file when the full
 * output needs to be preserved.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private readonly decoder = new TextDecoder();

  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private tempFilePath?: string;
  private tempFileStream?: ReturnType<typeof createWriteStream>;
  /** First error on the temp file stream (if any). Checked in closeTempFile. */
  private tempFileError?: Error;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "pi-atlas-output";
  }

  append(data: Buffer): void {
    if (this.finished) {
      // Silently ignore late data that arrives after finish() — the pipe
      // may emit buffered chunks between finish() and closeTempFile().
      return;
    }
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncation.truncated) {
      this.ensureTempFile();
    }
    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) {
      // If a stream error already fired and cleared tempFileStream, reject.
      if (this.tempFileError) throw this.tempFileError;
      return;
    }
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  /**
   * Return the full, untruncated output.
   *
   * When the output was large enough to spill to a temp file, the file is read
   * back. Otherwise the in-memory tail *is* the full output.
   */
  async getFullOutput(): Promise<string> {
    if (this.tempFilePath) {
      try {
        return await readFile(this.tempFilePath, "utf-8");
      } catch {
        // fall through to in-memory tail
      }
    }
    return this.getSnapshotText();
  }

  // ---- internals (mirrors the pi-native accumulator) ----

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail();
    }
    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    // advance past any UTF-8 continuation bytes
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }
    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    );
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    const stream = createWriteStream(this.tempFilePath);
    // Install a permanent error listener so disk errors don't crash the
    // process with an unhandled 'error' event. The first error is saved;
    // closeTempFile rejects with it if the stream never finished cleanly.
    stream.on("error", (err: Error) => {
      if (!this.tempFileError) this.tempFileError = err;
      this.tempFileStream = undefined;
    });
    this.tempFileStream = stream;
    for (const chunk of this.rawChunks) {
      stream.write(chunk);
    }
    this.rawChunks = [];
  }
}
