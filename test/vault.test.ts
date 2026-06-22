process.env.FICTA_CONFIG_FILE = "0";
process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
process.env.FICTA_REGISTRY_MIN_LEN = "6";
process.env.FICTA_REDACT_PATHS = "0";

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadRegistryValues } from "../src/plugins/index.js";
import { Vault } from "../src/vault.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const v = new Vault(loadRegistryValues());

describe("vault", () => {
  it("loads the registry", () => {
    expect(v.size).toBeGreaterThanOrEqual(3);
  });

  it("redacts known values out of a JSON body", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: `key is ${AWS}` }] });
    const { body: red, count } = v.redactBody(body);
    expect(count).toBe(1);
    expect(red).not.toContain(AWS);
    expect(red).toMatch(/FICTA_[0-9a-f]{32}/);
  });

  it("round-trips: restore(redact(x)) recovers the value", () => {
    const { body: red } = v.redactBody(JSON.stringify({ x: AWS }));
    expect(v.restoreText(red)).toContain(AWS);
  });

  it("redacts and gates known values when they appear as JSON object keys", () => {
    const body = JSON.stringify({ [AWS]: "value" });
    const { body: red, count } = v.redactBody(body);
    expect(count).toBe(1);
    expect(red).not.toContain(AWS);
    expect(v.leakCount(body)).toBe(1);
    expect(v.leakCount(red)).toBe(0);
  });

  it("leaves JSON byte-for-byte when no known value is present", () => {
    const body = '{\n  "message": "nothing sensitive here"\n}';
    expect(v.redactBody(body)).toEqual({ body, count: 0 });
  });

  it("deterministic surrogate: same value → same token", () => {
    const a = v.redactBody(JSON.stringify({ x: AWS })).body;
    const b = v.redactBody(JSON.stringify({ y: AWS })).body;
    const sa = a.match(/FICTA_[0-9a-f]{32}/)?.[0];
    const sb = b.match(/FICTA_[0-9a-f]{32}/)?.[0];
    expect(sa).toBe(sb);
  });

  it("uses keyed, non-guessable surrogates rather than a raw secret hash", () => {
    const red = v.redactBody(JSON.stringify({ x: AWS })).body;
    const sur = red.match(/FICTA_[0-9a-f]{32}/)?.[0];
    expect(sur).toBeTruthy();
    const rawHashPrefix = "FICTA_" + createHash("sha256").update(AWS).digest("hex").slice(0, 32);
    expect(sur).not.toBe(rawHashPrefix);
  });

  it("fail-closed gate: flags raw leaks, clean after redaction", () => {
    const body = JSON.stringify({ x: AWS });
    expect(v.leakCount(body)).toBe(1);
    expect(v.leakCount(v.redactBody(body).body)).toBe(0);
  });

  it("redacts a value living inside a longer string", () => {
    const body = JSON.stringify({ content: "DATABASE_URL=postgres://u:longpassword@host:5432/db end" });
    expect(v.redactBody(body).body).not.toContain("longpassword");
  });

  it("does not redact known values inside filesystem paths", () => {
    const vault = new Vault([{ value: "eu-central-1" }]);
    const path = "/Users/alice/src/acme/eu-central-1-prod";
    const body = JSON.stringify({ cwd: path, command: `cd ${path} && git diff` });

    expect(vault.redactBody(body)).toEqual({ body, count: 0 });
    expect(vault.leakCount(body)).toBe(0);
  });

  it("redacts non-path occurrences while leaving path occurrences untouched", () => {
    const vault = new Vault([{ value: "eu-central-1" }]);
    const path = "/Users/alice/src/acme/eu-central-1-prod";
    const body = JSON.stringify({ content: `cwd=${path}\nAWS_REGION=eu-central-1` });
    const { body: red, count } = vault.redactBody(body);

    expect(count).toBe(1);
    expect(red).toContain(path);
    expect(red).not.toContain("AWS_REGION=eu-central-1");
    expect(red).toMatch(/AWS_REGION=FICTA_[0-9a-f]{32}/);
    expect(vault.leakCount(red)).toBe(0);
  });

  it("does not redact simple registered values when used as bare cd path operands", () => {
    const vault = new Vault([{ value: "eu-central-1-prod" }]);
    const command = "cd eu-central-1-prod && grep -ril supabase .";
    const body = JSON.stringify({ command });

    expect(vault.redactBody(body)).toEqual({ body, count: 0 });
    expect(vault.leakCount(body)).toBe(0);
  });

  it("does not redact registered values that are themselves explicit path operands", () => {
    const vault = new Vault([{ value: "./corova" }, { value: "/corova" }]);
    const body = JSON.stringify({ content: "check ./corova and find /corova -type f" });

    expect(vault.redactBody(body)).toEqual({ body, count: 0 });
    expect(vault.leakCount(body)).toBe(0);
  });

  it("still redacts slash-containing assignment values", () => {
    const secret = "/fake/secret/value-12345";
    const vault = new Vault([{ value: secret }]);
    const body = JSON.stringify({ content: `API_SECRET=${secret}` });
    const { body: red, count } = vault.redactBody(body);

    expect(count).toBe(1);
    expect(red).not.toContain(secret);
    expect(vault.leakCount(red)).toBe(0);
  });

  it("still redacts the same simple value in non-path env assignment context", () => {
    const vault = new Vault([{ value: "eu-central-1-prod" }]);
    const body = JSON.stringify({ content: "AWS_PROFILE=eu-central-1-prod" });
    const { body: red, count } = vault.redactBody(body);

    expect(count).toBe(1);
    expect(red).not.toContain("AWS_PROFILE=eu-central-1-prod");
    expect(red).toMatch(/AWS_PROFILE=FICTA_[0-9a-f]{32}/);
  });

  it("still redacts values inside URLs rather than treating them as filesystem paths", () => {
    const vault = new Vault([{ value: "longpassword" }]);
    const body = JSON.stringify({ content: "DATABASE_URL=postgres://u:longpassword@host:5432/db" });

    expect(vault.redactBody(body).body).not.toContain("longpassword");
  });

  it("redacts slash-containing secrets instead of treating them as filesystem paths", () => {
    const secret = "fake/secret/value-12345";
    const vault = new Vault([{ value: secret }]);
    const body = JSON.stringify({ content: `API_SECRET=${secret}` });
    const { body: red, count } = vault.redactBody(body);

    expect(count).toBe(1);
    expect(red).not.toContain(secret);
    expect(vault.leakCount(red)).toBe(0);
  });

  it("redacts multiline private-key-like values", () => {
    const secret = "-----BEGIN TEST PRIVATE KEY-----\nabc123multilinefake\n-----END TEST PRIVATE KEY-----";
    const vault = new Vault([{ value: secret }]);
    const body = JSON.stringify({ content: secret });
    const { body: red, count } = vault.redactBody(body);

    expect(count).toBe(1);
    expect(red).not.toContain(secret);
    expect(vault.leakCount(red)).toBe(0);
  });

  it("FICTA_REDACT_PATHS=1 opts back into path redaction", () => {
    const before = process.env.FICTA_REDACT_PATHS;
    process.env.FICTA_REDACT_PATHS = "1";
    try {
      const vault = new Vault([{ value: "eu-central-1" }]);
      const path = "/Users/alice/src/acme/eu-central-1-prod";
      const { body: red, count } = vault.redactBody(JSON.stringify({ cwd: path }));

      expect(count).toBe(1);
      expect(red).not.toContain(path);
    } finally {
      if (before === undefined) delete process.env.FICTA_REDACT_PATHS;
      else process.env.FICTA_REDACT_PATHS = before;
    }
  });

  it("streaming restore reassembles a surrogate split across chunks", async () => {
    const red = v.redactBody(JSON.stringify({ x: AWS })).body;
    const sur = red.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";
    const text = `data: {"t":"${sur}"}\n\n`;
    const cut = text.indexOf(sur) + 8; // mid-surrogate
    const rs = v.restoreStream();
    const w = rs.writable.getWriter();
    const r = rs.readable.getReader();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let out = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        out += dec.decode(value);
      }
    })();
    await w.write(enc.encode(text.slice(0, cut)));
    await w.write(enc.encode(text.slice(cut)));
    await w.close();
    await pump;
    expect(out).toContain(AWS);
    expect(out).not.toContain(sur);
  });
});
