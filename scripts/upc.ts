/** GTIN-12 / UPC-A check digit for the first 11 digits. */
export function gtin12CheckDigit(first11: string): string {
  if (!/^\d{11}$/.test(first11)) {
    throw new Error(`gtin12CheckDigit expects 11 digits, got: ${first11}`);
  }
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = first11.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** True iff upc is exactly 12 digits and the check digit is valid. */
export function isValidUpc(upc: string): boolean {
  if (!/^\d{12}$/.test(upc)) return false;
  return gtin12CheckDigit(upc.slice(0, 11)) === upc[11];
}

/** True iff ean is 13 digits with a valid EAN-13 check digit (weights 1,3 from the left). */
export function isValidEan13(ean: string): boolean {
  if (!/^\d{13}$/.test(ean)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (ean.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10) === ean[12];
}

/** The ways a notice can print this barcode: as is, without the UPC check digit, without the leading zero. */
export function printedForms(code: string): string[] {
  const out = new Set([code]);
  if (code.length === 12) { out.add(code.slice(0, 11)); if (code.startsWith("0")) out.add(code.slice(1)); }
  return [...out];
}
