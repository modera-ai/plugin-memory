/** Direct-command shortcut only; ambiguous language still requires candidate review. */
export function rememberIntent(message: string | undefined, memoryText?: string): "explicit" | "candidate" | "denied" {
  if (!message) return "candidate";
  const input = message.trim();
  if (/^(?:请)?(?:不要|别)(?:记住|记录|保存)|^(?:please\s+)?(?:do\s+not|don't|never)\s+(?:remember|save|store)\b/i.test(input)) return "denied";
  if (!memoryText || /[?？]\s*$/.test(input)) return "candidate";
  const command = /^(?:(?:请)?(?:记住|记一下)\s*[:：]|(?:please\s+)?remember(?:\s+that)?(?:\s*:\s*|\s+)|(?:please\s+)?save\s+(?:this|that)\s+(?:to|in)\s+memory\s*:)\s*([\s\S]+)$/i.exec(input);
  if (!command) return "candidate";
  const normalize = (text: string) => {
    let value = text.trim().replace(/[。.!！]+$/, "").trim();
    for (const [start, end] of [["\"", "\""], ["“", "”"], ["「", "」"]]) {
      if (value.startsWith(start!) && value.endsWith(end!)) { value = value.slice(start!.length, -end!.length).trim(); break; }
    }
    return value;
  };
  return normalize(command[1]!) === normalize(memoryText) ? "explicit" : "candidate";
}
