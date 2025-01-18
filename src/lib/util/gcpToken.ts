import { GOOGLE_SERVICE_ACCOUNT_JSON } from '$env/static/private';
import { base64decode, base64encode } from './base64';
import { responseErrorAsString } from '$lib/util/error';
import type { JsonValue } from '$lib/util/types';
import { z } from 'zod';
import { newTimer } from './timer';

export const serviceAccountJsonSchema = z.object({
  project_id: z.string(),
  client_email: z.string(),
  private_key_id: z.string(),
  private_key: z.string()
});

const googleServiceAccount = serviceAccountJsonSchema.parse(
  JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)
);

export const googleProjectId = googleServiceAccount.project_id;

/**
 * Converts PEM into DER.
 *
 * PEM (originally “Privacy Enhanced Mail”) is text format for cryptographic keys.
 * DER (Distinguished Encoding Rules) is a binary encoding for cryptographic keys.
 */
function convertPEMtoDER(pem: string): Uint8Array {
  const pemBase64 = pem
    .trim()
    .split('\n')
    .slice(1, -1) // Remove first and last lines with "--- BEGIN / END PRIVATE KEY ---"
    .join('');
  return base64decode(pemBase64);
}

function base64noPadding(bytes: Uint8Array): string {
  return base64encode(bytes, '');
}

function jsonToBase64url(json: JsonValue): string {
  const te = new TextEncoder();
  return base64noPadding(te.encode(JSON.stringify(json)));
}

function stringToArrayBuffer(s: string): ArrayBuffer {
  const buf = new ArrayBuffer(s.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, n = s.length; i < n; i++) {
    bufView[i] = s.charCodeAt(i);
  }
  return buf;
}

/**
 * This function does not do any I/O. It is async just because it uses encryption.
 */
export async function getGoogleServiceAccountToken(audienceClaim: URL | URL[]): Promise<string> {
  const alg = 'RS256';
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: {
      name: 'SHA-256'
    }
  };
  const expiredAfter = 3600;
  const nowSec = Math.floor(Date.now() / 1000);

  const header = {
    alg,
    kid: googleServiceAccount.private_key_id,
    typ: 'JWT'
  };
  const payload = {
    aud: Array.isArray(audienceClaim)
      ? audienceClaim.map((u) => u.toString).join(',')
      : audienceClaim.toString(),
    iss: googleServiceAccount.client_email,
    sub: googleServiceAccount.client_email,
    iat: nowSec,
    exp: nowSec + expiredAfter
  };

  const message = `${jsonToBase64url(header)}.${jsonToBase64url(payload)}`;

  const pkDER = convertPEMtoDER(googleServiceAccount.private_key);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkDER, algorithm, false, ['sign']);
  const signature = await crypto.subtle.sign(algorithm, privateKey, stringToArrayBuffer(message));
  const signatureStr = base64noPadding(new Uint8Array(signature));

  const token = `${message}.${signatureStr}`;
  return token;
}

// Docs: https://developers.google.com/identity/protocols/oauth2/service-account#httprest

const accessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.literal('Bearer')
});

export type AccessToken = {
  token: string;
  expiresAtMillis: number;
};

const GOOGLE_AUTH_TOKEN_HOST = 'accounts.google.com';
const GOOGLE_AUTH_TOKEN_PATH = '/o/oauth2/token';

// Reference:
// https://github.com/auth0/node-jws/blob/b9fb8d30e9c009ade6379f308590f1b0703eefc3/lib/sign-stream.js#L25
async function signJWT(params: { scopes: string[]; audiences: string[] }): Promise<string> {
  const alg = 'RS256';
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: {
      name: 'SHA-256'
    }
  };
  const oneHourInSeconds = 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg,
    kid: googleServiceAccount.private_key_id,
    typ: 'JWT'
  };
  const payloadJson = {
    aud: params.audiences.join(' '),
    iat: nowSec,
    exp: nowSec + oneHourInSeconds,
    iss: googleServiceAccount.client_email,
    sub: googleServiceAccount.client_email,
    scope: params.scopes.join(' ')
  };
  const message = `${jsonToBase64url(header)}.${jsonToBase64url(payloadJson)}`;
  const pkDER = convertPEMtoDER(googleServiceAccount.private_key);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkDER, algorithm, false, ['sign']);
  const signature = await crypto.subtle.sign(algorithm, privateKey, stringToArrayBuffer(message));
  const signatureStr = base64noPadding(new Uint8Array(signature));
  return `${message}.${signatureStr}`;
}

export type AccessTokenParams = {
  scopes: string[];
  audiences: string[];
};

// Reference:
// https://github.com/firebase/firebase-admin-node/blob/fdde8c3a6f67c23830746065b8467e7bbe42e3df/src/app/credential-internal.ts#L94
export async function fetchGoogleAccessToken(params: AccessTokenParams): Promise<AccessToken> {
  const assertion = await signJWT(params);
  const url = `https://${GOOGLE_AUTH_TOKEN_HOST}${GOOGLE_AUTH_TOKEN_PATH}`;
  const timer = newTimer();
  const fetchResp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  console.log(
    `fetchGoogleAccessToken: status=${fetchResp.status}, latency=${timer.elapsedStr()}: ${makeAccessTokenCacheKey(params)}`
  );
  if (!fetchResp.ok) {
    console.log('fetchGoogleAccessToken failed: ', await responseErrorAsString(fetchResp));
    throw Error(`fetchGoogleAccessToken failed: status=${fetchResp.status}`);
  }
  const accessToken = accessTokenResponseSchema.parse(await fetchResp.json());
  return {
    token: accessToken.access_token,
    expiresAtMillis: Date.now() + accessToken.expires_in * 1000
  };
}

const accessTokenCache = new Map<string, Promise<AccessToken>>();

function makeAccessTokenCacheKey(params: AccessTokenParams): string {
  return JSON.stringify({
    audiences: params.audiences.toSorted(),
    scopes: params.scopes.toSorted()
  });
}

export async function getGoogleAccessToken(params: AccessTokenParams): Promise<AccessToken> {
  const key = makeAccessTokenCacheKey(params);
  const promise = accessTokenCache.get(key);
  if (promise) {
    try {
      const token = await promise;
      if (token.expiresAtMillis >= Date.now() + 10_000) {
        return token;
      }
    } catch (e) {
      console.log('getGoogleAccessToken: cached promise failed, ignoring it and retrying.');
    }
  }
  const fetchPromise = fetchGoogleAccessToken(params);
  accessTokenCache.set(key, fetchPromise);
  return fetchPromise;
}
