import { base64encode } from '$lib/util/base64';
import { errorAsString } from '$lib/util/error';
import { MessageType } from '@protobuf-ts/runtime';

export function generatorToResponse(
  deltas: AsyncGenerator<string>,
  { dataPrefix }: { dataPrefix: string } = { dataPrefix: 'data: ' }
): Response {
  const textEncoder = new TextEncoder();
  const responseHeaders = {
    headers: { 'Content-Type': 'text/event-stream' }
  };

  const { readable, writable } = new TransformStream();
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
      controller.close();
    }
  })
    .pipeThrough(
      new TransformStream({
        async start(controller) {
          try {
            for await (const delta of deltas) {
              controller.enqueue(textEncoder.encode(`${dataPrefix}${delta}\n\n`));
            }
            controller.enqueue(textEncoder.encode(`data: [DONE]\n\n`));
            controller.terminate();
          } catch (e) {
            console.warn(`generatorToResponse error: ${errorAsString(e)}`);
            controller.enqueue(textEncoder.encode(`error: server error\n\n`));
          }
        }
      })
    )
    .pipeTo(writable)
    .catch(() => {
      console.error('Exception in generatorToResponse.catch, aborting response generation.');
    });
  return new Response(readable, responseHeaders);
}

export function protoGeneratorToResponse<H extends object, D extends object>(
  header: H,
  headerMessageType: MessageType<H>,
  deltas: AsyncGenerator<D>,
  deltaMessageType: MessageType<D>
): Response {
  async function* protosToString(): AsyncGenerator<string> {
    yield `header: ${base64encode(headerMessageType.toBinary(header))}`;
    for await (const delta of deltas) {
      yield `delta: ${base64encode(deltaMessageType.toBinary(delta))}`;
    }
  }
  return generatorToResponse(protosToString(), { dataPrefix: '' });
}

export async function* dropDuplicateDeltas<T extends object>(
  deltas: AsyncGenerator<T>
): AsyncGenerator<T> {
  let prevDeltaJson: string | undefined;
  for await (const delta of deltas) {
    const deltaJson = JSON.stringify(delta);
    if (prevDeltaJson !== deltaJson) {
      prevDeltaJson = deltaJson;
      yield delta;
    }
  }
}

export async function* dropBefore(
  deltas: AsyncGenerator<string>,
  startPattern: RegExp
): AsyncGenerator<string> {
  let seenStart = false;
  let buffer = '';
  for await (const delta of deltas) {
    if (!seenStart) {
      buffer += delta;
      const match = buffer.match(startPattern);
      if (match !== null && match.index !== undefined) {
        yield buffer.substring(match.index);
        seenStart = true;
      }
    } else {
      yield delta;
    }
  }
}

export async function* mergeGenerators<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
  type IndexResult = {
    index: number;
    result: IteratorResult<T, unknown>;
  };
  const getNext = async (g: AsyncGenerator<T>, index: number): Promise<IndexResult> => {
    return { index, result: await g.next() };
  };
  const nextPromisses = generators.map(async (g, index) => getNext(g, index));
  let count = nextPromisses.length;
  const never = new Promise<IndexResult>(() => { });
  try {
    for (; count > 0;) {
      const { index, result } = await Promise.race(nextPromisses);
      if (result.done) {
        nextPromisses[index] = never;
        count--;
      } else {
        nextPromisses[index] = getNext(generators[index], index);
        yield result.value;
      }
    }
  } finally {
    for (const [index, generator] of generators.entries()) {
      if (nextPromisses[index] !== never) {
        generator.return(null); // no await
      }
    }
  }
}

export function callbackToResponse(
  nextDelta: () => Promise<string | null>,
  { dataPrefix }: { dataPrefix: string } = { dataPrefix: 'data: ' }
): Response {
  const textEncoder = new TextEncoder();
  const responseHeaders = {
    headers: { 'Content-Type': 'text/event-stream' }
  };

  const { readable, writable } = new TransformStream();
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
      controller.close();
    }
  })
    .pipeThrough(
      new TransformStream({
        async start(controller) {
          try {
            for (; ;) {
              const delta = await nextDelta();
              if (delta === null) {
                break;
              }
              controller.enqueue(textEncoder.encode(`${dataPrefix}${delta}\n\n`));
            }
            controller.enqueue(textEncoder.encode(`data: [DONE]\n\n`));
            controller.terminate();
          } catch (e) {
            console.warn(`generatorToResponse error: ${errorAsString(e)}`);
            controller.enqueue(textEncoder.encode(`error: server error\n\n`));
          }
        }
      })
    )
    .pipeTo(writable)
    .catch(() => {
      console.error('Exception in generatorToResponse.catch, aborting response generation.');
    });
  return new Response(readable, responseHeaders);
}
