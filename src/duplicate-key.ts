/** Preserve case, internal whitespace, numbers and punctuation: they can change code/claims. */
export function duplicateKey(text: string): string {
  return text.normalize("NFC").trim();
}
