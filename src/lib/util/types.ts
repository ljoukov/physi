export type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends { [P in K]: T[K] } ? never : K;
}[keyof T];

export type OptionalKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends { [P in K]: T[K] } ? K : never;
}[keyof T];

export type PickRequired<T> = Pick<T, RequiredKeys<T>>;

export type PickOptional<T> = Pick<T, OptionalKeys<T>>;

export type KeysMatching<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T];

export type Common<A, B> = Pick<
  A,
  {
    [K in keyof A & keyof B]: A[K] extends B[K] ? (B[K] extends A[K] ? K : never) : never;
  }[keyof A & keyof B]
>;

export function isNotNull<T>(v: T | null): v is T {
  return v != null;
}

export declare type JsonValue = number | string | boolean | null | JsonObject | JsonArray;

export declare type JsonObject = {
  [k: string]: JsonValue;
};

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export declare type JsonArray = Array<JsonValue>;

export function hasProp<T extends Record<string, unknown>, P extends keyof T>(
  v: T,
  prop: P
): v is T & Required<Pick<T, P>> {
  return !!Object.getOwnPropertyDescriptor(v, prop);
}

export function ensureProp<T extends Record<string, unknown>, P extends keyof T, V extends T[P]>(
  v: T,
  prop: P,
  makeDefaultValue: () => V
): T & Required<Pick<T, P>> {
  while (!hasProp(v, prop)) {
    v[prop] = makeDefaultValue();
  }
  return v;
}

export type Modify<T, R> = Omit<T, keyof R> & R;

export type DeepRequired<T> = {
  [K in keyof T]: Required<DeepRequired<T[K]>>;
};

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
