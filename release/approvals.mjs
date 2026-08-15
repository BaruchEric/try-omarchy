import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

export const REQUIRED_APPROVAL_GATES = Object.freeze([
  "licensing",
  "runtime",
  "security",
  "product",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  invariant(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  invariant(
    actual.length === required.length && actual.every((key, index) => key === required[index]),
    `${label} has missing or unsupported fields`,
  );
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "approval signature payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  invariant(isRecord(value), "approval signature payload contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function canonicalTimestamp(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, `${label} must be canonical UTC ISO-8601`);
  return value;
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(filePath, label) {
  const before = await lstat(filePath);
  invariant(before.isFile(), `${label} is not a regular file`);
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  invariant(
    after.isFile() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      bytes.byteLength === after.size,
    `${label} changed while it was being read`,
  );
  return bytes;
}

export function approvalSignaturePayload({
  releaseId,
  artifactManifest,
  approval,
}) {
  const signedApproval = {
    gate: approval.gate,
    decision: approval.decision,
    approvedAt: approval.approvedAt,
    approvedBy: approval.approvedBy,
    evidence: approval.evidence,
    keyId: approval.keyId,
  };
  return Buffer.from(canonicalJson({
    schemaVersion: 1,
    releaseId,
    artifactManifest,
    approval: signedApproval,
  }), "utf8");
}

function validatePolicy(policy) {
  assertExactKeys(policy, ["schemaVersion", "keys"], "approval policy");
  invariant(policy.schemaVersion === 1, "approval policy has an unsupported schema");
  invariant(Array.isArray(policy.keys) && policy.keys.length === REQUIRED_APPROVAL_GATES.length, "approval policy must define exactly four gate keys");
  const gates = new Set();
  const keyIds = new Set();
  const keyFingerprints = new Set();
  const keys = new Map();
  for (const record of policy.keys) {
    assertExactKeys(record, ["gate", "keyId", "publicKeyPem"], "approval policy key");
    invariant(REQUIRED_APPROVAL_GATES.includes(record.gate), `approval policy gate is invalid: ${record.gate}`);
    invariant(!gates.has(record.gate), `approval policy gate is duplicated: ${record.gate}`);
    invariant(KEY_ID.test(record.keyId ?? ""), `approval policy key ID is invalid: ${record.keyId}`);
    invariant(!keyIds.has(record.keyId), `approval policy key ID is duplicated: ${record.keyId}`);
    invariant(typeof record.publicKeyPem === "string" && record.publicKeyPem.length <= 4096, `approval policy public key is invalid: ${record.keyId}`);
    let publicKey;
    try {
      publicKey = createPublicKey(record.publicKeyPem);
    } catch {
      throw new Error(`approval policy public key cannot be parsed: ${record.keyId}`);
    }
    invariant(publicKey.asymmetricKeyType === "ed25519", `approval policy key is not Ed25519: ${record.keyId}`);
    const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
    invariant(!keyFingerprints.has(fingerprint), `approval policy reuses a public key across gates: ${record.keyId}`);
    gates.add(record.gate);
    keyIds.add(record.keyId);
    keyFingerprints.add(fingerprint);
    keys.set(record.gate, { keyId: record.keyId, publicKey });
  }
  for (const gate of REQUIRED_APPROVAL_GATES) {
    invariant(gates.has(gate), `approval policy is missing gate: ${gate}`);
  }
  return keys;
}

function validateApprovalRecord(record, gate, key) {
  assertExactKeys(
    record,
    ["gate", "decision", "approvedAt", "approvedBy", "evidence", "keyId", "signature"],
    `approval for ${gate}`,
  );
  invariant(record.gate === gate, `approval gate is inconsistent: ${gate}`);
  invariant(record.decision === "approved", `approval gate is not approved: ${gate}`);
  canonicalTimestamp(record.approvedAt, `approval timestamp for ${gate}`);
  invariant(
    typeof record.approvedBy === "string" &&
      record.approvedBy.length <= 200 &&
      record.approvedBy === record.approvedBy.trim() &&
      PRINTABLE.test(record.approvedBy),
    `approval signer is invalid: ${gate}`,
  );
  invariant(
    Array.isArray(record.evidence) &&
      record.evidence.length > 0 &&
      record.evidence.length <= 32 &&
      record.evidence.every(validHttpsUrl),
    `approval evidence URLs are invalid: ${gate}`,
  );
  invariant(record.keyId === key.keyId, `approval key ID does not match policy: ${gate}`);
  invariant(typeof record.signature === "string" && record.signature.length > 0, `approval signature is missing: ${gate}`);
  const signature = Buffer.from(record.signature, "base64");
  invariant(
    signature.byteLength === 64 && signature.toString("base64") === record.signature,
    `approval signature is not canonical Ed25519 bytes: ${gate}`,
  );
  return signature;
}

export async function verifyReleaseApprovals({
  releaseId,
  manifestBytes,
  approvalsFile,
  approvalPolicyFile,
  trustedApprovalPolicySha256,
}) {
  invariant(SHA256.test(releaseId ?? ""), "release approval ID must be 64 lowercase hexadecimal characters");
  invariant(Buffer.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array, "release manifest bytes are required for approval verification");
  invariant(sha256(manifestBytes) === releaseId, "release approval ID does not match the artifact manifest bytes");
  invariant(SHA256.test(trustedApprovalPolicySha256 ?? ""), "trusted approval policy SHA-256 is required");
  invariant(trustedApprovalPolicySha256 !== "0".repeat(64), "trusted approval policy SHA-256 is still the unpublished sentinel");
  invariant(typeof approvalsFile === "string" && approvalsFile.length > 0, "release approvals file is required");
  invariant(typeof approvalPolicyFile === "string" && approvalPolicyFile.length > 0, "approval policy file is required");

  const [approvalBytes, policyBytes] = await Promise.all([
    readRegularFile(approvalsFile, "release approvals file"),
    readRegularFile(approvalPolicyFile, "approval policy file"),
  ]);
  const policySha256 = sha256(policyBytes);
  invariant(policySha256 === trustedApprovalPolicySha256, "approval policy SHA-256 does not match the trusted pin");

  let document;
  let policy;
  try {
    document = JSON.parse(approvalBytes.toString("utf8"));
    policy = JSON.parse(policyBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`release approval JSON is invalid: ${error.message}`);
  }
  const policyKeys = validatePolicy(policy);
  assertExactKeys(document, ["schemaVersion", "releaseId", "artifactManifest", "approvals"], "release approvals");
  invariant(document.schemaVersion === 1, "release approvals have an unsupported schema");
  invariant(document.releaseId === releaseId, "release approvals are bound to a different release ID");
  assertExactKeys(document.artifactManifest, ["sha256", "bytes"], "release approval artifact manifest");
  invariant(document.artifactManifest.sha256 === releaseId, "release approvals identify different manifest bytes");
  invariant(
    document.artifactManifest.bytes === manifestBytes.byteLength,
    "release approvals identify a different manifest size",
  );
  invariant(
    Array.isArray(document.approvals) && document.approvals.length === REQUIRED_APPROVAL_GATES.length,
    "release approvals must contain exactly four gate records",
  );

  const byGate = new Map();
  for (const record of document.approvals) {
    invariant(isRecord(record) && REQUIRED_APPROVAL_GATES.includes(record.gate), `release approval gate is invalid: ${record?.gate}`);
    invariant(!byGate.has(record.gate), `release approval gate is duplicated: ${record.gate}`);
    byGate.set(record.gate, record);
  }

  const summaries = {};
  for (const gate of REQUIRED_APPROVAL_GATES) {
    const record = byGate.get(gate);
    invariant(record, `release approval gate is missing: ${gate}`);
    const key = policyKeys.get(gate);
    const signature = validateApprovalRecord(record, gate, key);
    const payload = approvalSignaturePayload({
      releaseId,
      artifactManifest: document.artifactManifest,
      approval: record,
    });
    invariant(verifySignature(null, payload, key.publicKey, signature), `release approval signature is invalid: ${gate}`);
    summaries[gate] = Object.freeze({
      approved: true,
      approvedAt: record.approvedAt,
      approvedBy: record.approvedBy,
    });
  }

  return Object.freeze({
    evidenceSha256: sha256(approvalBytes),
    policySha256,
    approvals: Object.freeze(summaries),
  });
}
