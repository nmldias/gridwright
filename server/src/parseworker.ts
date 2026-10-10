// Worker thread entry: parse one file and post back the raw sets (see parsepool.ts).
import { parentPort, workerData } from 'node:worker_threads';
import { parseJson, parseWorkbook, parseXml } from './parsers.js';

const { kind, buf, name, text } = workerData as { kind: 'workbook' | 'xml' | 'json'; buf?: Uint8Array; name: string; text?: string };
try {
  const out = kind === 'workbook' ? parseWorkbook(Buffer.from(buf!.buffer, buf!.byteOffset, buf!.byteLength), name) : kind === 'xml' ? parseXml(text ?? '') : parseJson(text ?? '');
  parentPort!.postMessage({ ok: true, out });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error)?.message ?? String(e) });
}
