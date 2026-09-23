// India financial year (1 Apr - 31 Mar) -> 4-digit code, e.g. "2728".
function financialYearCode(date = new Date()) {
  const d = new Date(date);
  const month = d.getMonth() + 1;
  const startYear = month >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}
function formatDocumentNo(fyCode, sequence, width = 5) {
  return `${fyCode}${String(sequence).padStart(width, '0')}`;
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
module.exports = { financialYearCode, formatDocumentNo, round2 };
