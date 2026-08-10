import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GATEWAY_DATA_ROOT } from "./config";
import type { DeviceAuthTokenRecord, DeviceIdentity } from "@openclaw/gateway-client";

/**
 * Ed25519 device identity + paired device tokens for the Gateway connection.
 * This directory holds a private key and a bearer credential that grants
 * operator access to the team OpenClaw Gateway — keep it out of git and out
 * of any rsync/backup that leaves the server.
 */

const GATEWAY_DIR = GATEWAY_DATA_ROOT;
const IDENTITY_FILE = path.join(GATEWAY_DIR, "device.json");
const TOKENS_FILE = path.join(GATEWAY_DIR, "tokens.json");

function ensureDir(): void {
  fs.mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
}

// deviceId must equal sha256(raw Ed25519 public key bytes) in hex — verified
// server-side by the gateway (deriveDeviceIdFromPublicKey). Not client-chosen.
function rawPublicKeyFromPem(publicKeyPem: string): Buffer {
  const keyObj = crypto.createPublicKey(publicKeyPem);
  const der = keyObj.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

function deriveDeviceId(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(rawPublicKeyFromPem(publicKeyPem)).digest("hex");
}

export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  ensureDir();
  if (fs.existsSync(IDENTITY_FILE)) {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as DeviceIdentity;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const identity: DeviceIdentity = {
    deviceId: deriveDeviceId(publicKeyPem),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload, "utf-8"), key).toString("base64url");
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return rawPublicKeyFromPem(publicKeyPem).toString("base64url");
}

interface TokenStore {
  [deviceRoleKey: string]: DeviceAuthTokenRecord;
}

function readTokenStore(): TokenStore {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as TokenStore;
}

function writeTokenStore(store: TokenStore): void {
  ensureDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function loadDeviceAuthToken(params: { deviceId: string; role: string }): DeviceAuthTokenRecord | null {
  return readTokenStore()[`${params.deviceId}:${params.role}`] ?? null;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes: string[];
}): void {
  const store = readTokenStore();
  store[`${params.deviceId}:${params.role}`] = { token: params.token, scopes: params.scopes };
  writeTokenStore(store);
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }): void {
  const store = readTokenStore();
  delete store[`${params.deviceId}:${params.role}`];
  writeTokenStore(store);
}
