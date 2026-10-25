// PTP constants and binary dataset parsing (ISO 15740 + Nikon vendor extensions).

export const OK = 0x2001;

export const Op = {
  GetDeviceInfo: 0x1001,
  GetStorageIDs: 0x1004,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  GetThumb: 0x100a,
  InitiateCapture: 0x100e,
  GetDevicePropDesc: 0x1014,
  GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
  // Nikon
  NikonInitiateCaptureRecInSdram: 0x90c0,
  NikonAfDrive: 0x90c1,
  NikonCheckEvent: 0x90c7,
  NikonDeviceReady: 0x90c8,
  NikonGetVendorPropCodes: 0x90ca,
  NikonStartLiveView: 0x9201,
  NikonEndLiveView: 0x9202,
  NikonGetLiveViewImage: 0x9203,
  NikonInitiateCaptureRecInMedia: 0x9207,
  NikonChangeAfArea: 0x9205,
};

export const Resp = {
  0x2001: 'OK', 0x2002: 'General error', 0x2005: 'Operation not supported', 0x2019: 'Device busy',
  0x201e: 'Session not open', 0x2003: 'Session not open', 0xa001: 'Hardware busy', 0xa002: 'Out of focus',
  0xa003: 'Invalid status', 0xa004: 'Set property not supported', 0xa005: 'Wrong data type',
  0xa008: 'Not in live view', 0xa00b: 'Not live view', 0xa00c: 'Change camera mode failed', 0x201d: 'Invalid parameter',
  0x201c: 'Invalid device prop value', 0x200f: 'Access denied', 0x200c: 'Store full', 0x2013: 'Store not available',
};
export const respName = code => Resp[code] || `0x${code.toString(16)}`;

export const Event = { ObjectAdded: 0x4002, DevicePropChanged: 0x4006, CaptureComplete: 0x400d, NikonObjectAddedInSdram: 0xc101, NikonCaptureCompleteRecInSdram: 0xc102 };

// Data types
const T = { INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6, INT64: 7, UINT64: 8, STR: 0xffff };

export class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b.readUInt8(this.o++); }
  i8() { return this.b.readInt8(this.o++); }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  i16() { const v = this.b.readInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return Number(v); }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return Number(v); }
  str() {
    const n = this.u8();
    if (!n) return '';
    const s = this.b.toString('utf16le', this.o, this.o + (n - 1) * 2);
    this.o += n * 2;
    return s;
  }
  arr(fn) { const n = this.u32(); const out = []; for (let i = 0; i < n; i++) out.push(fn.call(this)); return out; }
  value(type) {
    if (type === T.STR) return this.str();
    if (type & 0x4000) return this.arr(() => this.value(type & ~0x4000));
    switch (type) {
      case T.INT8: return this.i8(); case T.UINT8: return this.u8();
      case T.INT16: return this.i16(); case T.UINT16: return this.u16();
      case T.INT32: return this.i32(); case T.UINT32: return this.u32();
      case T.INT64: return this.i64(); case T.UINT64: return this.u64();
      default: throw new Error(`Unsupported PTP data type 0x${type.toString(16)}`);
    }
  }
}

export function encodeValue(type, v) {
  const b = Buffer.alloc(8);
  switch (type) {
    case T.INT8: b.writeInt8(v); return b.subarray(0, 1);
    case T.UINT8: b.writeUInt8(v); return b.subarray(0, 1);
    case T.INT16: b.writeInt16LE(v); return b.subarray(0, 2);
    case T.UINT16: b.writeUInt16LE(v); return b.subarray(0, 2);
    case T.INT32: b.writeInt32LE(v); return b.subarray(0, 4);
    case T.UINT32: b.writeUInt32LE(v); return b.subarray(0, 4);
    case T.INT64: b.writeBigInt64LE(BigInt(v)); return b;
    case T.UINT64: b.writeBigUInt64LE(BigInt(v)); return b;
    case T.STR: {
      const s = Buffer.from(v + '\0', 'utf16le');
      return Buffer.concat([Buffer.from([s.length / 2]), s]);
    }
    default: throw new Error(`Cannot encode PTP data type 0x${type.toString(16)}`);
  }
}

export function parseDeviceInfo(buf) {
  const r = new Reader(buf);
  return {
    standardVersion: r.u16(),
    vendorExtensionId: r.u32(),
    vendorExtensionVersion: r.u16(),
    vendorExtensionDesc: r.str(),
    functionalMode: r.u16(),
    operations: r.arr(r.u16),
    events: r.arr(r.u16),
    properties: r.arr(r.u16),
    captureFormats: r.arr(r.u16),
    imageFormats: r.arr(r.u16),
    manufacturer: r.str(),
    model: r.str(),
    deviceVersion: r.str(),
    serialNumber: r.str(),
  };
}

export function parsePropDesc(buf) {
  const r = new Reader(buf);
  const code = r.u16(), type = r.u16(), writable = r.u8() === 1;
  const factory = r.value(type), current = r.value(type);
  const form = r.u8();
  const desc = { code, type, writable, factory, current };
  if (form === 1) desc.range = { min: r.value(type), max: r.value(type), step: r.value(type) };
  else if (form === 2) { const n = r.u16(); desc.values = []; for (let i = 0; i < n; i++) desc.values.push(r.value(type)); }
  return desc;
}

export function parseObjectInfo(buf) {
  const r = new Reader(buf);
  const info = {
    storageId: r.u32(), format: r.u16(), protection: r.u16(), size: r.u32(),
    thumbFormat: r.u16(), thumbSize: r.u32(), thumbWidth: r.u32(), thumbHeight: r.u32(),
    width: r.u32(), height: r.u32(), bitDepth: r.u32(), parent: r.u32(),
    assocType: r.u16(), assocDesc: r.u32(), sequence: r.u32(),
  };
  info.filename = r.str();
  return info;
}

// Nikon CheckEvent: u16 count, then (u16 code, u32 param) pairs.
export function parseNikonEvents(buf) {
  const r = new Reader(buf);
  const n = r.u16(), out = [];
  for (let i = 0; i < n; i++) out.push({ code: r.u16(), param: r.u32() });
  return out;
}
