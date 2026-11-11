// Keep every source character. Split at scene headings, then paragraph boundaries.
export function splitScript(script, maxChars = 5000) {
  const source = String(script || '');
  if (!source.trim()) return [];
  const headings = [...source.matchAll(/^(?:场景[一二三四五六七八九十百零〇\d]+\s*[:：]|第[一二三四五六七八九十百零〇\d]+[场幕集]\s*[:：]?|INT\.|EXT\.).*$/gm)];
  const boundaries = [0, ...headings.map(match => match.index).filter(index => index > 0), source.length];
  const pieces = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    let remainder = source.slice(boundaries[i], boundaries[i + 1]);
    const heading = remainder.match(/^(?:场景|第|INT\.|EXT\.).*/)?.[0]?.trim();
    while (remainder.length) {
      let end = Math.min(maxChars, remainder.length);
      if (end < remainder.length) {
        const newline = remainder.lastIndexOf('\n', end);
        if (newline > maxChars / 2) end = newline + 1;
        else if (/[\uD800-\uDBFF]/.test(remainder[end - 1])) end--;
      }
      pieces.push({ referenceOnly: headings.length > 0 && i === 0 && headings[0].index > 0, title: heading || (i === 0 && headings.length ? '剧本资料与人物小传' : `剧本段落 ${pieces.length + 1}`), text: remainder.slice(0, end) });
      remainder = remainder.slice(end);
    }
  }
  return pieces.map((piece, index) => ({ ...piece, id: `chunk-${index + 1}`, index: index + 1, analysisState: 'idle', storyboardState: 'idle' }));
}
