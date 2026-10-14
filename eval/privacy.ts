/** Match configured sentinels, keeping decimal amounts distinct from timestamps. */
export function containsSentinel(text: string, value: string): boolean {
  if (value.length < 4) return false;
  if (/^\d+\.\d{2}$/.test(value)) {
    const escaped = value.replace('.', '\\.');
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(text);
  }
  return text.includes(value);
}
