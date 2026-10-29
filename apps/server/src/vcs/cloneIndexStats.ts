// @effect-diagnostics nodeBuiltinImport:off - Git's stat cache needs nanoseconds from BigIntStats, not Effect's millisecond timestamps.
import type * as NodeFS from "node:fs";
import * as Hex from "effect/encoding/Hex";

// gitformat-index: only stat fields change; object IDs, modes, paths and the TREE cache stay intact.
export function withCloneIndexStats(
  index: Uint8Array,
  clones: ReadonlyMap<string, { readonly oid: string; readonly stat: NodeFS.BigIntStats }>,
): Uint8Array | null {
  if (index.length < 32 || new TextDecoder().decode(index.subarray(0, 4)) !== "DIRC") return null;
  const bytes = index.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) return null;
  const end = bytes.length - 20;
  const count = view.getUint32(8);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const uint32 = (value: bigint) => Number(BigInt.asUintN(32, value));
  let offset = 12;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 62 >= end) return null;
    const flags = view.getUint16(offset + 60);
    if ((flags & 0xf000) !== 0) return null;
    const nameEnd = bytes.indexOf(0, offset + 62);
    if (nameEnd < 0 || nameEnd >= end) return null;
    if ((flags & 0xfff) !== 0xfff && nameEnd - offset - 62 !== (flags & 0xfff)) return null;
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 62, nameEnd));
    } catch {
      return null;
    }
    const clone = clones.get(name);
    if (clone && Hex.encode(bytes.subarray(offset + 40, offset + 60)) === clone.oid) {
      const stat = clone.stat;
      view.setUint32(offset, uint32(stat.ctimeNs / 1_000_000_000n));
      view.setUint32(offset + 4, uint32(stat.ctimeNs % 1_000_000_000n));
      view.setUint32(offset + 8, uint32(stat.mtimeNs / 1_000_000_000n));
      view.setUint32(offset + 12, uint32(stat.mtimeNs % 1_000_000_000n));
      view.setUint32(offset + 16, uint32(stat.dev));
      view.setUint32(offset + 20, uint32(stat.ino));
      view.setUint32(offset + 28, uint32(stat.uid));
      view.setUint32(offset + 32, uint32(stat.gid));
    }
    offset += Math.ceil((nameEnd + 1 - offset) / 8) * 8;
    if (offset > end) return null;
  }
  const parts = [bytes.subarray(0, offset)];
  while (offset < end) {
    if (offset + 8 > end) return null;
    const length = view.getUint32(offset + 4);
    const next = offset + 8 + length;
    if (next > end) return null;
    // Split/sparse indexes need Git; discard other optional caches belonging to the source checkout.
    if (bytes[offset]! < 65 || bytes[offset]! > 90) return null;
    const signature = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    if (signature === "FSMN") return null;
    if (signature === "TREE") {
      parts.push(bytes.subarray(offset, next));
    }
    offset = next;
  }
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 20));
  offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
