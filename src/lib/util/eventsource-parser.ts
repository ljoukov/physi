export interface EventSourceParser {
  feed(chunk: string): Promise<void>;
  reset(): void;
}

export interface ParsedEvent {
  type: 'event';
  event?: string;
  id?: string;
  data: string;
}

export interface ReconnectInterval {
  type: 'reconnect-interval';
  value: number;
}

export type ServerSourceEvent = ParsedEvent | ReconnectInterval;

export type ParseEvent = ParsedEvent | ReconnectInterval;
export type EventSourceParseCallback = (event: ParseEvent) => Promise<void>;

export function createParser(onParse: EventSourceParseCallback): EventSourceParser {
  // Processing state
  let isFirstChunk: boolean;
  let buffer: string;
  let startingPosition: number;
  let startingFieldLength: number;

  // Event state
  let eventId: string | undefined;
  let eventName: string | undefined;
  let data: string;

  reset();
  return { feed, reset };

  function reset(): void {
    isFirstChunk = true;
    buffer = '';
    startingPosition = 0;
    startingFieldLength = -1;

    eventId = undefined;
    eventName = undefined;
    data = '';
  }

  async function feed(chunk: string): Promise<void> {
    buffer = buffer ? buffer + chunk : chunk;

    // Strip any UTF8 byte order mark (BOM) at the start of the stream.
    // Note that we do not strip any non - UTF8 BOM, as eventsource streams are
    // always decoded as UTF8 as per the specification.
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length);
    }

    isFirstChunk = false;

    // Set up chunk-specific processing state
    const length = buffer.length;
    let position = 0;
    let discardTrailingNewline = false;

    // Read the current buffer byte by byte
    while (position < length) {
      // EventSource allows for carriage return + line feed, which means we
      // need to ignore a linefeed character if the previous character was a
      // carriage return
      // Consider refactor to reduce nesting, consider checking previous byte? but consider multiple chunks etc
      if (discardTrailingNewline) {
        if (buffer[position] === '\n') {
          ++position;
        }
        discardTrailingNewline = false;
      }

      let lineLength = -1;
      let fieldLength = startingFieldLength;
      let character: string;

      for (let index = startingPosition; lineLength < 0 && index < length; ++index) {
        character = buffer[index];
        if (character === ':' && fieldLength < 0) {
          fieldLength = index - position;
        } else if (character === '\r') {
          discardTrailingNewline = true;
          lineLength = index - position;
        } else if (character === '\n') {
          lineLength = index - position;
        }
      }

      if (lineLength < 0) {
        startingPosition = length - position;
        startingFieldLength = fieldLength;
        break;
      } else {
        startingPosition = 0;
        startingFieldLength = -1;
      }

      await parseEventStreamLine(buffer, position, fieldLength, lineLength);

      position += lineLength + 1;
    }

    if (position === length) {
      // If we consumed the entire buffer to read the event, reset the buffer
      buffer = '';
    } else if (position > 0) {
      // If there are bytes left to process, set the buffer to the unprocessed
      // portion of the buffer only
      buffer = buffer.slice(position);
    }
  }

  async function parseEventStreamLine(
    lineBuffer: string,
    index: number,
    fieldLength: number,
    lineLength: number
  ) {
    if (lineLength === 0) {
      // We reached the last line of this event
      if (data.length > 0) {
        await onParse({
          type: 'event',
          id: eventId,
          event: eventName || undefined,
          data: data.slice(0, -1) // remove trailing newline
        });

        data = '';
        eventId = undefined;
      }
      eventName = undefined;
      return;
    }

    const noValue = fieldLength < 0;
    const field = lineBuffer.slice(index, index + (noValue ? lineLength : fieldLength));
    let step: number;

    if (noValue) {
      step = lineLength;
    } else if (lineBuffer[index + fieldLength + 1] === ' ') {
      step = fieldLength + 2;
    } else {
      step = fieldLength + 1;
    }

    const position = index + step;
    const valueLength = lineLength - step;
    const value = lineBuffer.slice(position, position + valueLength).toString();

    if (field === 'data') {
      data += value ? `${value}\n` : '\n';
    } else if (field === 'event') {
      eventName = value;
    } else if (field === 'id' && !value.includes('\u0000')) {
      eventId = value;
    } else if (field === 'retry') {
      const retry = parseInt(value, 10);
      if (!Number.isNaN(retry)) {
        await onParse({ type: 'reconnect-interval', value: retry });
      }
    }
  }
}

const BOM = [239, 187, 191];

function hasBom(buffer: string) {
  return BOM.every((charCode: number, index: number) => buffer.charCodeAt(index) === charCode);
}

export async function* parseEventSourceStream(
  responseBody: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  let onDataCallback: (() => void) | null = null;
  const callOnDataCallback = () => {
    if (onDataCallback) {
      onDataCallback();
      onDataCallback = null;
    }
  };
  const dataQueue: string[] = [];
  let done = false;
  let error: unknown;

  const textDecoder = new TextDecoder();
  const sseParser = createParser(async (event: ServerSourceEvent) => {
    if (event.type === 'event') {
      if (event.data === '[DONE]') {
        done = true;
      } else {
        dataQueue.push(event.data);
      }
      callOnDataCallback();
    }
  });

  (async () => {
    const responseReader = responseBody.getReader();
    try {
      for (;;) {
        const { done, value } = await responseReader.read();
        if (done) {
          break;
        }
        if (value) {
          const chunk = textDecoder.decode(value, { stream: true });
          await sseParser.feed(chunk);
        }
      }
      done = true;
    } catch (e) {
      error = e;
    } finally {
      callOnDataCallback();
      responseReader.releaseLock();
    }
  })();

  for (;;) {
    while (dataQueue.length > 0) {
      yield dataQueue.shift()!;
    }
    if (done) {
      break;
    }
    if (error) {
      throw error;
    }
    await new Promise<void>((resolve) => (onDataCallback = resolve));
  }
}
