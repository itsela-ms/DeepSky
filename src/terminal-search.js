// Wrapped-line-aware terminal search inspired by xterm's official search addon.

function translateBufferLineToStringWithWrap(buffer, lineIndex, trimRight) {
  const strings = [];
  const lineOffsets = [0];
  let line = buffer.getLine(lineIndex);

  while (line) {
    const nextLine = buffer.getLine(lineIndex + 1);
    const lineWrapsToNext = !!nextLine?.isWrapped;
    let string = line.translateToString(!lineWrapsToNext && trimRight);

    if (lineWrapsToNext && nextLine) {
      const lastCell = line.getCell(line.length - 1);
      const lastCellIsNull = lastCell && lastCell.getCode() === 0 && lastCell.getWidth() === 1;
      if (lastCellIsNull && nextLine.getCell(0)?.getWidth() === 2) {
        string = string.slice(0, -1);
      }
    }

    strings.push(string);
    if (!lineWrapsToNext) break;

    lineOffsets.push(lineOffsets[lineOffsets.length - 1] + string.length);
    lineIndex += 1;
    line = nextLine;
  }

  return [strings.join(''), lineOffsets];
}

function stringLengthToBufferSize(buffer, row, offset) {
  const line = buffer.getLine(row);
  if (!line) return 0;

  for (let i = 0; i < offset; i++) {
    const cell = line.getCell(i);
    if (!cell) break;

    const chars = cell.getChars();
    if (chars.length > 1) {
      offset -= chars.length - 1;
    }

    const nextCell = line.getCell(i + 1);
    if (nextCell && nextCell.getWidth() === 0) {
      offset += 1;
    }
  }

  return offset;
}

function buildSearchMatchPreview(text, matchIndex, matchLength) {
  const previewRadius = 42;
  const contextRadius = 28;
  const previewStart = Math.max(0, matchIndex - previewRadius);
  const previewEnd = Math.min(text.length, matchIndex + matchLength + previewRadius);
  const contextStart = Math.max(0, matchIndex - contextRadius);
  const contextEnd = Math.min(text.length, matchIndex + matchLength + contextRadius);

  return {
    preview: `${previewStart > 0 ? '…' : ''}${text.slice(previewStart, previewEnd)}${previewEnd < text.length ? '…' : ''}`,
    beforeText: text.slice(contextStart, matchIndex),
    matchText: text.slice(matchIndex, matchIndex + matchLength),
    afterText: text.slice(matchIndex + matchLength, contextEnd)
  };
}

function collectTerminalSearchMatches(buffer, terminalCols, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];

  const matches = [];
  for (let row = 0; row < buffer.length; row++) {
    const firstLine = buffer.getLine(row);
    if (!firstLine || firstLine.isWrapped) continue;

    const [stringLine, lineOffsets] = translateBufferLineToStringWithWrap(buffer, row, true);
    const haystack = stringLine.toLowerCase();
    let searchIndex = 0;

    while (searchIndex <= haystack.length - needle.length) {
      const resultIndex = haystack.indexOf(needle, searchIndex);
      if (resultIndex === -1) break;

      let startRowOffset = 0;
      while (startRowOffset < lineOffsets.length - 1 && resultIndex >= lineOffsets[startRowOffset + 1]) {
        startRowOffset += 1;
      }

      let endRowOffset = startRowOffset;
      while (endRowOffset < lineOffsets.length - 1 && resultIndex + needle.length > lineOffsets[endRowOffset + 1]) {
        endRowOffset += 1;
      }

      const startColOffset = resultIndex - lineOffsets[startRowOffset];
      const endColOffset = resultIndex + needle.length - lineOffsets[endRowOffset];
      const startColIndex = stringLengthToBufferSize(buffer, row + startRowOffset, startColOffset);
      const endColIndex = stringLengthToBufferSize(buffer, row + endRowOffset, endColOffset);
      const size = endColIndex - startColIndex + terminalCols * (endRowOffset - startRowOffset);

      matches.push({
        ...buildSearchMatchPreview(stringLine, resultIndex, needle.length),
        row: row + startRowOffset,
        col: startColIndex,
        length: Math.max(size, 1)
      });

      searchIndex = resultIndex + Math.max(needle.length, 1);
    }
  }

  return matches;
}

module.exports = {
  translateBufferLineToStringWithWrap,
  stringLengthToBufferSize,
  collectTerminalSearchMatches
};
