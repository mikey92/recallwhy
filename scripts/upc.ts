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
