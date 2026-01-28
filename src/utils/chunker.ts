import { Transform, TransformCallback } from 'stream';

const CHUNK_SIZE = 24 * 1024 * 1024;

export class Chunker extends Transform {
    private buffer: Buffer[] = [];
    private bufferSize = 0;

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        this.buffer.push(chunk);
        this.bufferSize += chunk.length;

        while (this.bufferSize >= CHUNK_SIZE) {
            const combined = Buffer.concat(this.buffer);
            const slice = combined.subarray(0, CHUNK_SIZE);
            const remainder = combined.subarray(CHUNK_SIZE);

            this.push(slice);

            this.buffer = remainder.length > 0 ? [remainder] : [];
            this.bufferSize = remainder.length;
        }

        callback();
    }

    _flush(callback: TransformCallback): void {
        if (this.bufferSize > 0) {
            const combined = Buffer.concat(this.buffer);
            this.push(combined);
            this.buffer = [];
            this.bufferSize = 0;
        }
        callback();
    }
}
