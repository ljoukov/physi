const kvRegexp = /^\$([A-Z0-9_]+):\s([\s\S]*?)(?=\n\$|\n---)/;
const incompleteKvRegexp = /^\$([A-Z0-9_]+):\s(.+)/s; // "/s" modifier enables dot (".") to match newline
const separatorRegexp = /^---/;

export const SEPARATOR = '---'; // Has to be at the start of the line.

type KVParse =
  | { type: 'kv'; key: string; value: string }
  | { type: 'incomplete_kv'; key: string; value: string; remaining: string }
  | { type: 'separator' };

export function* parseKeyValueDelta(
  inputBuffer: string
): Generator<KVParse | { type: 'remaining'; remaining: string }> {
  let buffer = inputBuffer;
  // Skip empty lines
  for (; buffer.length > 0 && buffer[0] === '\n';) {
    buffer = buffer.substring(1);
  }
  for (; buffer.length > 0;) {
    let hasMatch = false;
    // Match kv pair
    const kvMatch = kvRegexp.exec(buffer);
    if (kvMatch !== null) {
      yield {
        type: 'kv',
        key: kvMatch[1],
        value: kvMatch[2].trim()
      };
      buffer = buffer.substring(kvMatch[0].length + 1);
      hasMatch = true;
    }

    // Match separator
    const separatorMatch = separatorRegexp.exec(buffer);
    if (separatorMatch !== null) {
      yield { type: 'separator' };
      buffer = buffer.substring(separatorMatch[0].length);
      // Skip empty lines
      for (; buffer.length > 0 && buffer[0] === '\n';) {
        buffer = buffer.substring(1);
      }
      hasMatch = true;
    }

    if (!hasMatch) {
      break;
    }
  }
  const incompleteKvMatch = incompleteKvRegexp.exec(buffer);
  if (incompleteKvMatch !== null) {
    yield {
      type: 'incomplete_kv',
      key: incompleteKvMatch[1],
      value: incompleteKvMatch[2].trim(),
      remaining: buffer
    };
  } else {
    yield {
      type: 'remaining',
      remaining: buffer
    };
  }
}

export async function* parseKeyValueDeltas(
  deltas: AsyncGenerator<string>
): AsyncGenerator<KVParse> {
  let buffer = '';
  nextDelta: for await (const delta of deltas) {
    buffer += delta;
    for (const kvDelta of parseKeyValueDelta(buffer)) {
      switch (kvDelta.type) {
        case 'kv': // fallthrough
        case 'separator':
          yield kvDelta;
          break;
        case 'incomplete_kv':
          yield kvDelta; // fallthrough
        case 'remaining':
          buffer = kvDelta.remaining;
          continue nextDelta;
      }
    }
    console.error('Unexpected end of parse, buffer:', buffer);
    throw Error('Unexpected end of parse');
  }
}
