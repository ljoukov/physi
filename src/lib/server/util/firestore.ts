import { Timestamp } from '$proto/google/protobuf/timestamp';
import {
  Document as DocumentProto,
  type Value as ValueProto,
  LatLng,
  ListDocumentsResponse,
  CommitRequest,
  CommitResponse,
  RpcError,
  StatusCode,
  DocumentMask
} from '$proto/third_party/FirestoreProto';
import { isJsonObject, type JsonValue } from '$lib/util/types';
import { NullValue } from '$proto/google/protobuf/struct';

import { getGoogleAccessToken, googleProjectId } from './gcpToken';
import { protoEnum } from '../../util/proto';
import { responseErrorAsString } from '../../util/error';
import { jsonSchema } from '../../util/json';

const statusCodeProto = protoEnum(StatusCode);

type Value = JsonValue | Timestamp | Uint8Array | LatLng | Value[] | ObjectValue;

type ObjectValue = { [k: string]: Value };

// Compatibility with client Firebase APIs.
export type Document = {
  id: string;
  name: string;
  data: ObjectValue;
  createTime: Timestamp;
  updateTime: Timestamp;
};

async function getAdminToken(): Promise<string> {
  const accessToken = await getGoogleAccessToken({
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/identitytoolkit',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    audiences: ['https://accounts.google.com/o/oauth2/token']
  });
  return accessToken.token;
}

export async function getDocAsAdmin(path: string): Promise<DocumentProto> {
  const docUrl = `https://firestore.googleapis.com/v1/projects/${googleProjectId}/databases/(default)/documents${path}`;
  const response = await fetch(docUrl, {
    headers: {
      Authorization: `Bearer ${await getAdminToken()}`
    }
  });
  if (!response.ok) {
    throw Error(`getDocAsAdmin: path=${path}: ${await responseErrorAsString(response)}`);
  }
  const docJson = jsonSchema.parse(await response.json());
  if (isJsonObject(docJson) && 'error' in docJson) {
    const error = RpcError.fromJson(docJson.error);
    throw Error(
      `getDoc failed: code=${error.code} status=${statusCodeProto.toString(error.status)}: ${error.message}`
    );
  }
  const docProto = DocumentProto.fromJson(docJson);
  return docProto;
}

export async function listDocsAsAdmin(path: string): Promise<DocumentProto[]> {
  const pageSize = '400';
  const token = await getAdminToken();

  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${googleProjectId}/databases/(default)/documents${path}`
  );
  url.search = new URLSearchParams({ pageSize }).toString();

  const docs: DocumentProto[] = [];
  for (; ;) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = jsonSchema.parse(await response.json());
    const responseProto = ListDocumentsResponse.fromJson(json);
    for (const doc of responseProto.documents) {
      docs.push(doc);
    }
    if (responseProto.nextPageToken === '') {
      break;
    }
    url.search = new URLSearchParams({
      pageToken: responseProto.nextPageToken,
      pageSize
    }).toString();
  }

  return docs;
}

export async function createDocAsAdmin(
  path: string,
  id: string,
  fields: DocumentProto['fields']
): Promise<DocumentProto> {
  const token = await getAdminToken();

  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${googleProjectId}/databases/(default)/documents${path}`
  );
  url.search = new URLSearchParams({
    documentId: id
  }).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: DocumentProto.toJsonString({
      name: '', // Name has to be empty for create document request.
      fields
    })
  });
  const json = jsonSchema.parse(await response.json());
  return DocumentProto.fromJson(json);
}

export async function updateDocAsAdmin(
  doc: DocumentProto,
  updateMask?: DocumentMask
): Promise<CommitResponse> {
  const token = await getAdminToken();

  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${googleProjectId}/databases/(default)/documents:commit`
  );
  const request: CommitRequest = {
    writes: [
      {
        updateMask,
        operation: {
          oneofKind: 'update',
          update: doc
        }
      }
    ],
    transaction: new Uint8Array()
  };

  const fetchResp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: CommitRequest.toJsonString(request)
  });
  if (!fetchResp.ok) {
    throw Error(
      `updateDocAsAdmin: doc.name=${doc.name}: ${await responseErrorAsString(fetchResp)}`
    );
  }
  const respJson = jsonSchema.parse(await fetchResp.json());
  if (isJsonObject(respJson) && 'error' in respJson) {
    const error = RpcError.fromJson(respJson.error);
    throw Error(
      `getDoc failed: code=${error.code} status=${statusCodeProto.toString(error.status)}: ${error.message}`
    );
  }
  const responseProto = CommitResponse.fromJson(respJson);
  return responseProto;
}

export function docFromProto(docProto: DocumentProto): Document {
  return {
    id: docProto.name.substring(docProto.name.lastIndexOf('/') + 1),
    name: docProto.name,
    data: objectFromFieldsProto(docProto.fields),
    createTime: docProto.createTime!,
    updateTime: docProto.updateTime!
  };
}

export function docName(path: string, id: string): string {
  if (id.length === 0 || id.indexOf('/') !== -1) {
    throw Error(`invalid doc id "${id}"`);
  }
  return `${collectionName(path)}/${id}`;
}

export function collectionName(path: string): string {
  if (path.length === 0 || path[0] !== '/' || path[path.length - 1] === '/') {
    throw Error(`invalid doc path "${path}"`);
  }
  return `projects/${googleProjectId}/databases/(default)/documents${path}`;
}

export function docToProto(doc: Document): DocumentProto {
  return {
    name: doc.name,
    fields: docDataToFieldsProto(doc.data),
    createTime: doc.createTime,
    updateTime: doc.updateTime
  };
}

function valueFromProto(value: ValueProto): Value {
  const valueType = value.valueType;
  switch (valueType.oneofKind) {
    case 'nullValue':
      return null;
    case 'booleanValue':
      return valueType.booleanValue;
    case 'integerValue':
      return parseInt(valueType.integerValue);
    case 'doubleValue':
      return valueType.doubleValue;
    case 'timestampValue':
      return valueType.timestampValue;
    case 'stringValue':
      return valueType.stringValue;
    case 'bytesValue':
      return valueType.bytesValue;
    case 'geoPointValue':
      return valueType.geoPointValue;
    case 'arrayValue':
      return valueType.arrayValue.values.map(valueFromProto);
    case 'mapValue':
      return objectFromFieldsProto(valueType.mapValue.fields);
    case 'referenceValue':
    // fallthrough
    case undefined: {
      const msg = `Unsupported value type ${valueType.oneofKind}`;
      console.error(msg);
      throw Error(msg);
    }
  }
}

function objectFromFieldsProto(fields: DocumentProto['fields']): ObjectValue {
  const result: Value = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = valueFromProto(value);
  }
  return result;
}

function valueToProto(value: Value): ValueProto {
  switch (typeof value) {
    case 'boolean':
      return {
        valueType: {
          oneofKind: 'booleanValue',
          booleanValue: value
        }
      };
    case 'number':
      if (Math.round(value) === value) {
        return {
          valueType: {
            oneofKind: 'integerValue',
            integerValue: value.toString()
          }
        };
      } else {
        return {
          valueType: {
            oneofKind: 'doubleValue',
            doubleValue: value
          }
        };
      }
    case 'string':
      return {
        valueType: {
          oneofKind: 'stringValue',
          stringValue: value
        }
      };
    case 'object':
      if (value === null) {
        return {
          valueType: {
            oneofKind: 'nullValue',
            nullValue: NullValue.NULL_VALUE
          }
        };
      } else if (Array.isArray(value)) {
        return {
          valueType: {
            oneofKind: 'arrayValue',
            arrayValue: {
              values: value.map(valueToProto)
            }
          }
        };
      } else if (value instanceof Uint8Array) {
        return {
          valueType: {
            oneofKind: 'bytesValue',
            bytesValue: value
          }
        };
      } else if (LatLng.is(value)) {
        return {
          valueType: {
            oneofKind: 'geoPointValue',
            geoPointValue: value
          }
        };
      } else if (Timestamp.is(value)) {
        return {
          valueType: {
            oneofKind: 'timestampValue',
            timestampValue: value
          }
        };
      } else {
        return {
          valueType: {
            oneofKind: 'mapValue',
            mapValue: {
              fields: docDataToFieldsProto(value)
            }
          }
        };
      }
    case 'bigint':
    // fallthrough
    case 'function':
    // fallthrough
    case 'symbol':
    // fallthrough
    case 'undefined':
      throw Error(`unsupported type "${typeof value}" for "${value}"`);
  }
}

export function docDataToFieldsProto(obj: ObjectValue): DocumentProto['fields'] {
  const fields: DocumentProto['fields'] = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = valueToProto(value);
  }
  return fields;
}
