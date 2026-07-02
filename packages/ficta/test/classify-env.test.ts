import { describe, expect, it } from "vitest";
import { classifyEnvCandidate, looksHighEntropy, type NonSecretReason } from "../src/classify-env.js";

const HEX16 = "a1b2c3d4e5f6a7b8"; // random-ish 16-hex, e.g. STARSHIP_SESSION_KEY
const HEX32 = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const B64_32 = "aGVsbG9Xb3JsZFRoaXNJc0Jhc2U2NFN0dQ"; // 34-char base64-ish blob

describe("classifyEnvCandidate — keeps protecting", () => {
  const keep: Array<[string, string[]]> = [
    ["OPENAI_API_KEY", [HEX32]],
    ["WORKOS_API_KEY", ["sk-proj-abcdef"]],
    ["WORKOS_COOKIE_PASSWORD", ["some-long-cookie-password-value"]],
    ["DATABASE_URL", ["postgres://user:pass@host:5432/db"]], // userinfo veto (name isn't secret-ish)
    ["SIGNED_ASSET", ["https://cdn.example.com/f.png?sig=abc123&token=xyz"]], // cred query veto
    ["STARSHIP_SESSION_KEY", [HEX16]], // secret name + entropy
    ["AWS_PROFILE", [B64_32]], // entropy veto beats name allowlist
    ["SLACK_WEBHOOK_URL", ["https://hooks.slack.com/services/T00/B00/abcdEFGH1234ijklMNOP5678"]],
    ["SUPPORT_PHONE", ["+14155550123"]], // PII name
    ["GH_TOKEN", ["ghp_16CharsOfTokenABCDEFG"]], // known prefix
    ["MYSTERY", ["c3d2e1f00f1e2d3c4b5a6978"]], // unknown name, 24-hex value → default keep via entropy
  ];
  it.each(keep)("%s → keep-protected", (name, values) => {
    expect(classifyEnvCandidate(name, values).verdict).toBe("keep-protected");
  });
});

describe("classifyEnvCandidate — likely non-secret", () => {
  const nonSecret: Array<[string, string[], NonSecretReason]> = [
    ["WORKOS_REDIRECT_URI", ["https://app.example.com/callback"], "looks like a URL (no credentials)"],
    ["FICTA_PII_PRESIDIO_URL", ["http://localhost:5000"], "looks like a URL (no credentials)"],
    ["DB_HOST_URL", ["postgres://localhost:5432/mydb"], "looks like a URL (no credentials)"],
    ["SSH_AUTH_SOCK", ["/private/tmp/com.apple.launchd.abc123/Listeners"], "well-known config name"],
    ["DEPLOY_SOCKET", ["/var/run/app.sock"], "looks like a file/socket path"],
    ["AWS_PROFILE", ["eu-central-1-prod"], "well-known config name"],
    ["MYAPP_LOG_LEVEL", ["debug"], "well-known config name"],
    ["DOPPLER_PROMPT_ANSI", ["\\u001b[..."], "well-known config name"],
    ["FEATURE_FLAG", ["true"], "looks like a config setting"],
    ["RETRY_COUNT", ["5"], "looks like a config setting"],
    ["RELEASE_CHANNEL", ["stable-v2"], "looks like a config setting"],
  ];
  it.each(nonSecret)("%s → likely-non-secret (%s)", (name, values, reason) => {
    const result = classifyEnvCandidate(name, values);
    expect(result.verdict).toBe("likely-non-secret");
    expect(result.reason).toBe(reason);
  });
});

describe("classifyEnvCandidate — multi-value and edge cases", () => {
  it("keeps a name if any of its values looks secret", () => {
    // Same name in .env (benign URL) and process-env (credentialed URL) → keep.
    const result = classifyEnvCandidate("SERVICE_URL", [
      "https://api.example.com",
      "https://user:pass@api.example.com",
    ]);
    expect(result.verdict).toBe("keep-protected");
  });

  it("is non-secret only when every value is benign", () => {
    const result = classifyEnvCandidate("SERVICE_URL", ["https://a.example.com", "https://b.example.com"]);
    expect(result.verdict).toBe("likely-non-secret");
  });

  it("defaults to keep for an unknown name with no recognizable shape", () => {
    expect(classifyEnvCandidate("MYSTERY", ["value with spaces and stuff"]).verdict).toBe("keep-protected");
  });

  it("defaults to keep with no values", () => {
    expect(classifyEnvCandidate("WHATEVER", []).verdict).toBe("keep-protected");
  });

  it("never leaks value text into the reason", () => {
    const result = classifyEnvCandidate("WORKOS_REDIRECT_URI", ["https://secret-host.internal/callback?x=1"]);
    expect(result.reason).toBe("looks like a URL (no credentials)");
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });
});

describe("looksHighEntropy", () => {
  it("flags random tokens and long hex", () => {
    expect(looksHighEntropy(HEX16)).toBe(true);
    expect(looksHighEntropy(HEX32)).toBe(true);
    expect(looksHighEntropy(B64_32)).toBe(true);
    expect(looksHighEntropy("ghp_abcdefg")).toBe(true);
  });

  it("does not flag structured slugs or short values", () => {
    expect(looksHighEntropy("eu-central-1-prod")).toBe(false);
    expect(looksHighEntropy("us-east-1")).toBe(false);
    expect(looksHighEntropy("debug")).toBe(false);
    expect(looksHighEntropy("/var/run/app.sock")).toBe(false);
  });
});
