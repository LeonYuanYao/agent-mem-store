export type SecretCategory =
  | "authorization_header"
  | "private_key"
  | "credential_field";

export type LocalSensitivityFinding =
  | {
      readonly state: "secret";
      readonly category: SecretCategory;
      readonly matchedValue: string;
    }
  | {
      readonly state: "uncertain";
      readonly category: "contextual_credential";
      readonly matchedValue: string;
    }
  | { readonly state: "normal" };

export function classifyLocalSensitivity(value: string): LocalSensitivityFinding {
  const authorization = /authorization\s*:\s*(?:bearer|basic)\s+[^\s"}]+/iu.exec(value);
  if (authorization !== null) {
    return {
      state: "secret",
      category: "authorization_header",
      matchedValue: authorization[0]
    };
  }
  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.exec(value);
  if (privateKey !== null) {
    return {
      state: "secret",
      category: "private_key",
      matchedValue: privateKey[0]
    };
  }
  const credentialField =
    /(?:api[_-]?key|password|secret|session[_-]?cookie)\s*[:=]\s*["']?[^\s,"'}]{8,}/iu.exec(
      value
    );
  if (credentialField !== null) {
    return {
      state: "secret",
      category: "credential_field",
      matchedValue: credentialField[0]
    };
  }

  const uncertain =
    /(?:credential|authentication|auth)\D{0,32}([A-Za-z0-9+/_=-]{24,})/iu.exec(value);
  const candidate = uncertain?.[1];
  if (
    candidate !== undefined &&
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(candidate) &&
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(candidate) &&
    !/^(?:test|example|dummy|placeholder)/iu.test(candidate)
  ) {
    return {
      state: "uncertain",
      category: "contextual_credential",
      matchedValue: candidate
    };
  }

  return { state: "normal" };
}
