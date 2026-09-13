const PUNCTUATION_RE = /^[\s《》「」【】『』〈〉（）()"'""''・·—–…、。，。！？]+/u;

export function firstContentChar(str: string): string {
  const stripped = str.replace(PUNCTUATION_RE, "");
  return (stripped.charAt(0) || str.charAt(0)).toUpperCase();
}
