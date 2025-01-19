import { listEnumValues } from '@protobuf-ts/runtime';
import { z } from 'zod';

export function protoEnum<T extends Record<string, string | number>>(
  enumObj: T,
  prefix: string = ''
) {
  type V = T[keyof T];
  const values = listEnumValues(enumObj);
  const names: string[] = [];
  const nameToVal = new Map<string, V>();
  const valToName = new Map<V, string>();
  let undefValue: V;
  for (const value of values) {
    if (value.number === 0) {
      undefValue = enumObj[value.name] as unknown as T[keyof T];
      continue; // skip default
    }
    if (value.name.startsWith(prefix)) {
      const name = value.name.substring(prefix.length).toLocaleLowerCase();
      const val = enumObj[value.name] as unknown as T[keyof T];
      nameToVal.set(name, val);
      valToName.set(val, name);
      names.push(name);
    }
  }
  const schema = z.string().refine((s) => names.includes(s));
  function toProto(name: string): T[keyof T] {
    return nameToVal.get(name) ?? undefValue;
  }
  function toString(v: V): string {
    return valToName.get(v) ?? 'undefined';
  }
  return { names, schema, toProto, toString };
}
