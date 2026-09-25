import { createHash, createHmac } from "node:crypto";

export type SignTosUrlOptions = {
  readonly method: "DELETE" | "GET" | "PUT";
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly expiresSeconds: number;
  readonly now?: Date;
};

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function quote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function utcDate(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

/** Build the TOS4-HMAC-SHA256 query URL used by the official TOS SDK. */
export function signTosUrl(options: SignTosUrlOptions): string {
  const endpoint = new URL(options.endpoint.includes("://")
    ? options.endpoint
    : `https://${options.endpoint}`);
  const endpointHost = endpoint.port.length === 0
    ? endpoint.hostname
    : `${endpoint.hostname}:${endpoint.port}`;
  const host = endpointHost.startsWith(`${options.bucket}.`)
    ? endpointHost
    : `${options.bucket}.${endpointHost}`;
  const path = `/${options.key.split("/").map(quote).join("/")}`;
  const date = utcDate(options.now ?? new Date());
  const dateStamp = date.slice(0, 8);
  const scope = `${dateStamp}/${options.region}/tos/request`;
  const credential = `${options.accessKey}/${scope}`;
  const params = [
    ["X-Tos-Algorithm", "TOS4-HMAC-SHA256"],
    ["X-Tos-Credential", credential],
    ["X-Tos-Date", date],
    ["X-Tos-Expires", String(options.expiresSeconds)],
    ["X-Tos-SignedHeaders", "host"],
  ] as const;
  const canonicalQuery = [...params]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    options.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "TOS4-HMAC-SHA256",
    date,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(options.secretKey, dateStamp), options.region), "tos"), "request");
  const signature = hmacHex(signingKey, stringToSign);
  const query = [...params, ["X-Tos-Signature", signature] as const]
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join("&");
  return `${endpoint.protocol}//${host}${path}?${query}`;
}
