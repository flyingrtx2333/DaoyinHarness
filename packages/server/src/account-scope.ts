import { createHash } from "node:crypto";
import path from "node:path";
import type { AuthenticationSummary } from "@daoyin/harness-protocol";

export interface RuntimeIdentityProvider {
  readonly authority?: string;
  status(): AuthenticationSummary;
}
export interface RuntimeAccountScope { accountId: string; dataDir?: string }

/** Only trusted authentication state determines the namespace, never a request field. */
export function runtimeAccountScope(dataDir: string | undefined, authentication?: RuntimeIdentityProvider | null): RuntimeAccountScope {
  if (authentication === undefined || authentication === null) {
    return { accountId: "local", ...(dataDir === undefined ? {} : { dataDir }) };
  }
  const status = authentication.status();
  let accountId = "signed_out";
  if (status.status === "signed_in") {
    const account = status.account;
    if (account === null || !Number.isSafeInteger(account.id) || account.id <= 0 || !Number.isSafeInteger(account.tenantId) || account.tenantId < 0) {
      throw Object.assign(new Error("登录账号标识无效，已拒绝访问本地数据。"), { code: "AUTH_IDENTITY_INVALID" });
    }
    const authority = authentication.authority ?? "daoyin";
    accountId = `account_${createHash("sha256").update(JSON.stringify([authority, account.tenantId, account.id])).digest("hex").slice(0, 32)}`;
  }
  return { accountId, ...(dataDir === undefined ? {} : { dataDir: path.join(dataDir, "accounts", accountId) }) };
}
