// Picks a driver from the camera's DeviceInfo: the manufacturer string, plus the vendor
// operations it advertises (several brands report Microsoft's MTP extension ID, so that alone isn't enough).
import { PtpDriver } from './ptp.js';
import { NikonDriver } from './nikon.js';
import { CanonDriver } from './canon.js';
import { SonyDriver } from './sony.js';

const BRANDS = [
  [/nikon/i, 'Nikon'], [/canon/i, 'Canon'], [/sony/i, 'Sony'], [/fuji/i, 'Fujifilm'],
  [/olympus|om digital/i, 'OM System'], [/panasonic|lumix/i, 'Panasonic'], [/pentax|ricoh/i, 'Ricoh'], [/leica/i, 'Leica'], [/sigma/i, 'Sigma'],
];

export function pickDriver(cam) {
  const { manufacturer = '', operations = [] } = cam.info;
  const has = op => operations.includes(op);
  if (/nikon/i.test(manufacturer) && has(0x90c7)) return new NikonDriver(cam); // CheckEvent
  if (/canon/i.test(manufacturer) && has(0x9116)) return new CanonDriver(cam);  // EOS GetEvent
  if (/sony/i.test(manufacturer) && has(0x9201)) return new SonyDriver(cam);    // SDIO connect
  // Anything else gets standard PTP: settings, shutter and auto-download, without live view.
  const driver = new PtpDriver(cam);
  driver.brand = BRANDS.find(([re]) => re.test(manufacturer))?.[1] || manufacturer.trim() || 'Camera';
  return driver;
}
