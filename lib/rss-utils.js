const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", copy: "©", reg: "®", trade: "™", euro: "€",
  pound: "£", cent: "¢", middot: "·", bull: "•"
};

export function decodeRssEntities(value) {
  let text = String(value ?? "");
  // Repeated passes handle feeds that encode entities more than once,
  // such as &amp;nbsp; or &amp;#8217;.
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      const key = entity.toLowerCase();
      if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
      const codePoint = key.startsWith("#x")
        ? Number.parseInt(key.slice(2), 16)
        : key.startsWith("#")
          ? Number.parseInt(key.slice(1), 10)
          : NaN;
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
      try { return String.fromCodePoint(codePoint); }
      catch { return match; }
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

export function cleanRssText(value) {
  let text = String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  text = decodeRssEntities(text)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  text = decodeRssEntities(text).replace(/<[^>]*>/g, " ");
  return text.replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
}
