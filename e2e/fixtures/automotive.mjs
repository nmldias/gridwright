// Synthetic automotive inventory for the analytical benchmark (13 Oct 2026 assessment, §4):
// 10,000 vehicles with VIN, manufacturer, model, branch, purchase date, age, currency, exchange
// rate, landed cost, selling price, reservation status and inventory value. Deterministic (seeded),
// entirely invented, and seeded with the traps a happy-path demo would miss:
//   * duplicate VINs (the same vehicle exported twice),
//   * blank and text ("n/a") landed costs,
//   * landed costs in three currencies (only the AOA column may be added up),
//   * reserved vehicles that are older than average (excluding them flatters ageing),
//   * margins whose plain average differs from Σ margin / Σ price.
// `rows(n)` returns plain objects (the independent reference); `table(rows)` the workbook values.

export const HEADERS = ['VIN', 'Manufacturer', 'Model', 'Branch', 'Purchase date', 'Age (days)', 'Currency', 'FX rate', 'Landed cost', 'Landed cost AOA', 'Selling price AOA', 'Reserved', 'Inventory value AOA'];

const MAKES = {
  Toyota: ['Hilux', 'Corolla', 'Land Cruiser', 'RAV4'],
  Hyundai: ['Tucson', 'Creta', 'Accent'],
  Kia: ['Sportage', 'Picanto', 'Sorento'],
  Ford: ['Ranger', 'Everest'],
  Suzuki: ['Swift', 'Jimny', 'Vitara'],
};
const BRANCHES = ['Luanda', 'Benguela', 'Huambo', 'Lubango', 'Cabinda'];
// AOA per unit of the currency (synthetic, fixed per currency for reproducibility)
const FX = { USD: 912.5, EUR: 987.25, AOA: 1 };
const AS_OF = Date.UTC(2026, 8, 30); // 30 Sep 2026 snapshot

function rng(seed) {
  // mulberry32
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const round2 = (x) => Math.round(x * 100) / 100;

export function rows(n = 10000, seed = 20261013) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const make = pick(r, Object.keys(MAKES));
    const model = pick(r, MAKES[make]);
    const branch = pick(r, BRANCHES);
    const age = Math.floor(r() * r() * 420); // skewed to younger stock
    const reserved = r() < (age > 180 ? 0.35 : 0.08); // reserved stock is older on average
    const currency = r() < 0.55 ? 'USD' : r() < 0.6 ? 'EUR' : 'AOA';
    const base = 9000 + r() * 41000; // USD-equivalent
    const landed = currency === 'AOA' ? round2(base * FX.USD) : round2((base * FX.USD) / FX[currency]);
    let landedAoa = round2(landed * FX[currency]);
    const price = round2(landedAoa * (1.04 + r() * 0.3));
    let landedOut = landed;
    if (i % 250 === 17) { landedOut = null; landedAoa = null; } // 40 vehicles without a landed cost yet
    if (i % 2000 === 1234) { landedOut = 'n/a'; landedAoa = 'n/a'; } // 5 typed as text
    const date = new Date(AS_OF - age * 86400000).toISOString().slice(0, 10);
    out.push({
      VIN: `VIN-${String(i + 1).padStart(6, '0')}`,
      Manufacturer: make,
      Model: model,
      Branch: branch,
      'Purchase date': date,
      'Age (days)': age,
      Currency: currency,
      'FX rate': FX[currency],
      'Landed cost': landedOut,
      'Landed cost AOA': landedAoa,
      'Selling price AOA': price,
      Reserved: reserved ? 'Yes' : 'No',
      'Inventory value AOA': landedAoa,
    });
  }
  // 25 vehicles exported twice
  for (let k = 0; k < 25; k++) out.push({ ...out[k * 397] });
  return out;
}

/** Workbook values (header row first) for an `add_table` operation: canonical text inputs. */
export function table(rs) {
  return [HEADERS, ...rs.map((o) => HEADERS.map((h) => (o[h] === null || o[h] === undefined ? '' : String(o[h]))))];
}
