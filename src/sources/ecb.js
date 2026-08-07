// SOURCE: European Central Bank (ECB)
// Free, official, redistributable. EUR-based XML, ~30 major currencies.
// Returns rates normalized as "units of CUR per 1 EUR".

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export async function fetchEcb() {
  const res = await fetch(ECB_URL);
  if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
  const xml = await res.text();

  // Rows look like: <Cube currency='USD' rate='1.1542'/>  (single quotes!)
  const ratesPerEur = { EUR: 1 };
  const rowRegex = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
  let m;
  while ((m = rowRegex.exec(xml)) !== null) {
    ratesPerEur[m[1]] = Number(m[2]);
  }
  if (Object.keys(ratesPerEur).length <= 1) {
    throw new Error('ECB feed parsed but contained no rates.');
  }

  const dm = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/);
  return { name: 'European Central Bank', date: dm ? dm[1] : null, ratesPerEur };
}
