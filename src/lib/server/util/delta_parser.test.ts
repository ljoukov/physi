import { parseKeyValueDelta, parseKeyValueDeltas } from './delta_parser';

describe('parseKeyValueDelta', () => {
  it('incomplete key', () => {
    const input = `$KEY`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: input });
    expect(generator.next().done).toBe(true);
  });

  it('complete key, no value yet', () => {
    const input = `$KEY:`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: input });
    expect(generator.next().done).toBe(true);
  });

  it('incomplete value', () => {
    const input = `\
$KEY:
value`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'incomplete_kv',
      key: 'KEY',
      value: 'value',
      remaining: input
    });
    expect(generator.next().done).toBe(true);
  });

  it('incomplete value, extra spaces', () => {
    const input = '$KEY: \nvalue';
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'incomplete_kv',
      key: 'KEY',
      value: 'value',
      remaining: input
    });
    expect(generator.next().done).toBe(true);
  });

  it('single key-value pair', () => {
    const input = `\
$KEY:
value
---
`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'KEY',
      value: 'value'
    });
    expect(generator.next().value).toEqual({ type: 'separator' });
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: '' });
    expect(generator.next().done).toBe(true);
  });

  it('two key-value pairs', () => {
    const input = `\
$KEY_1:
value1
$KEY_2:
value2
---
`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'KEY_1',
      value: 'value1'
    });
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'KEY_2',
      value: 'value2'
    });
    expect(generator.next().value).toEqual({ type: 'separator' });
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: '' });
    expect(generator.next().done).toBe(true);
  });

  it('single complete key-value pair', () => {
    const input = `\
$KEY_1:
value1
$KEY_2: value2`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'KEY_1',
      value: 'value1'
    });
    expect(generator.next().value).toEqual({
      type: 'incomplete_kv',
      key: 'KEY_2',
      value: 'value2',
      remaining: '$KEY_2: value2'
    });
    expect(generator.next().done).toBe(true);
  });

  it('should correctly parse key-value pairs', () => {
    const input = `\
$ABC_1:
What is the primary product of photosynthesis? 🍂
$A: Oxygen
$B: Glucose
$C: Nitrogen
$CORRECT_ANSWER: C
$TITLE: Photosynthesis Products
$EMOJI: 🍂
---
`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'ABC_1',
      value: 'What is the primary product of photosynthesis? 🍂'
    });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'A', value: 'Oxygen' });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'B', value: 'Glucose' });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'C', value: 'Nitrogen' });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'CORRECT_ANSWER', value: 'C' });
    expect(generator.next().value).toEqual({
      type: 'kv',
      key: 'TITLE',
      value: 'Photosynthesis Products'
    });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'EMOJI', value: '🍂' });
    expect(generator.next().value).toEqual({ type: 'separator' });
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: '' });
    expect(generator.next().done).toBe(true);
  });

  it('should correctly handle remaining text in label', () => {
    const input = `$ABC_`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: input });
    expect(generator.next().done).toBe(true);
  });

  it('should correctly handle remaining text in value', () => {
    const input = `\
$DID_YOU_KNOW_1:
Did `;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({
      type: 'incomplete_kv',
      key: 'DID_YOU_KNOW_1',
      value: 'Did',
      remaining: input
    });
    expect(generator.next().done).toBe(true);
  });

  it('should parse kv sep kv', () => {
    const input = `\
$KEY_1_1: value11
$KEY_1_2: value12
---

$KEY_2_1: value21
---`;
    const generator = parseKeyValueDelta(input);
    expect(generator.next().value).toEqual({ type: 'kv', key: 'KEY_1_1', value: 'value11' });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'KEY_1_2', value: 'value12' });
    expect(generator.next().value).toEqual({ type: 'separator' });
    expect(generator.next().value).toEqual({ type: 'kv', key: 'KEY_2_1', value: 'value21' });
    expect(generator.next().value).toEqual({ type: 'separator' });
    expect(generator.next().value).toEqual({ type: 'remaining', remaining: '' });
    expect(generator.next().done).toBe(true);
  });
});

it('should correctly parse key-value pairs from deltas', async () => {
  async function* gen(): AsyncGenerator<string> {
    yield '$';
    yield 'K';
    yield 'EY_';
    yield '1';
    yield ': ';
    yield 'val';
    yield 'ue1';
    yield '\n$KEY_2: value2';
    yield '\n---';
    yield '$KEY_3: value3';
  }

  const expectedResults = [
    { type: 'incomplete_kv', key: 'KEY_1', value: 'val', remaining: '$KEY_1: val' },
    { type: 'incomplete_kv', key: 'KEY_1', value: 'value1', remaining: '$KEY_1: value1' },
    { type: 'kv', key: 'KEY_1', value: 'value1' },
    { type: 'incomplete_kv', key: 'KEY_2', value: 'value2', remaining: '$KEY_2: value2' },
    { type: 'kv', key: 'KEY_2', value: 'value2' },
    { type: 'separator' },
    { type: 'incomplete_kv', key: 'KEY_3', value: 'value3', remaining: '$KEY_3: value3' }
  ];

  let i = 0;
  for await (const delta of parseKeyValueDeltas(gen())) {
    expect(delta).toEqual(expectedResults[i]);
    i++;
  }
});
