// SOURCE: National Bank of Poland (NBP)
// Free, official, no API key. JSON. Table A (~33 majors) + Table B (~110
// exotic currencies) together cover ~140 currencies — the big coverage win.
//
// NBP quotes "mid" = how many PLN equal 1 unit of the foreign currency.
// We convert that to a EUR base using NBP's own EUR quote:
//   ratesPerEur[X] = plnPer[EUR] / plnPer[X]
// (units: (PLN/EUR) / (PLN/X) = X/EUR)

const TABLE_A = 'https://api.nbp.pl/api/exchangerates/tables/A?format=json';
const TABLE_B = 'https://api.nbp.pl/api/exchangerates/tables/B?format=json';

export async function fetchNbp() {
  const [ra, rb] = await Promise.all([fetch(TABLE_A), fetch(TABLE_B)]);
  if (!ra.ok) throw new Error(`NBP Table A HTTP ${ra.status}`);
  const aJson = await ra.json();
  const bJson = rb.ok ? await rb.json() : [{ rates: [] }];

  const tableA = aJson[0];
  const plnPer = { PLN: 1 }; // 1 PLN = 1 PLN
  for (const r of tableA.rates) plnPer[r.code] = r.mid;
  for (const r of bJson[0]?.rates || []) plnPer[r.code] = r.mid;

  const plnPerEur = plnPer.EUR;
  if (!plnPerEur) throw new Error('NBP feed missing EUR quote (cannot anchor).');

  const ratesPerEur = {};
  for (const [code, mid] of Object.entries(plnPer)) {
    ratesPerEur[code] = plnPerEur / mid;
  }

  return { name: 'National Bank of Poland', date: tableA.effectiveDate, ratesPerEur };
}
