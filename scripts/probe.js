// Dumps what the connected camera supports: operations, events, properties and their current values.
// Usage: node scripts/probe.js
import { Bridge } from '../src/bridge.js';
import { Op, OK, Reader, parseDeviceInfo, parsePropDesc, respName } from '../src/ptp.js';

const hex = n => '0x' + n.toString(16).padStart(4, '0');
const bridge = new Bridge();
const status = await bridge.ready;
if (!status.ready) { console.error(status.error); process.exit(1); }

const info = parseDeviceInfo((await bridge.send(Op.GetDeviceInfo, [], { dir: 'read' })).data);
console.log(`${info.manufacturer} ${info.model} fw ${info.deviceVersion}`);
console.log('ops:', info.operations.map(hex).join(' '));
console.log('events:', info.events.map(hex).join(' '));

let props = [...info.properties];
const vendor = await bridge.send(Op.NikonGetVendorPropCodes, [], { dir: 'read' }).catch(() => null);
if (vendor?.code === OK) props.push(...new Reader(vendor.data).arr(Reader.prototype.u16));
props = [...new Set(props)];
console.log(`props (${props.length}):`);
for (const p of props) {
  const res = await bridge.send(Op.GetDevicePropDesc, [p], { dir: 'read' }).catch(e => ({ code: -1, err: e.message }));
  if (res.code !== OK) { console.log(`  ${hex(p)} -> ${res.err || respName(res.code)}`); continue; }
  try {
    const d = parsePropDesc(res.data);
    const form = d.values ? `enum[${d.values.length}] ${JSON.stringify(d.values.slice(0, 12))}${d.values.length > 12 ? '…' : ''}`
      : d.range ? `range ${JSON.stringify(d.range)}` : '';
    console.log(`  ${hex(p)} t=${hex(d.type)} ${d.writable ? 'rw' : 'ro'} cur=${JSON.stringify(d.current)} ${form}`);
  } catch (e) { console.log(`  ${hex(p)} parse error: ${e.message}`); }
}
bridge.stop();
