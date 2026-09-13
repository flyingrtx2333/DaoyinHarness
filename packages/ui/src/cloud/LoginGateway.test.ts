import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginGateway, publicAuthError, validMainlandPhone } from "./LoginGateway.js";

describe("Harness unified-account login gateway", () => {
  it("accepts only normalized mainland mobile numbers", () => {
    expect(validMainlandPhone("13800138000")).toBe(true);
    expect(validMainlandPhone(" 13800138000 ")).toBe(true);
    expect(validMainlandPhone("12800138000")).toBe(false);
    expect(validMainlandPhone("1380013800")).toBe(false);
  });

  it("keeps bounded platform error messages and understands the account-session shape", () => {
    expect(publicAuthError({ detail: "验证码错误" }, "fallback")).toBe("验证码错误");
    expect(publicAuthError({ detail: { code: "ACCOUNT_LOGIN_REQUIRED", message: "请登录道引账号。" } }, "fallback")).toBe("请登录道引账号。");
    expect(publicAuthError({ detail: [] }, "请求未完成")).toBe("请求未完成");
  });

  it("renders SMS and unified-account password login without a second account system", () => {
    const html = renderToStaticMarkup(createElement(LoginGateway));
    expect(html).toContain("登录 Harness");
    expect(html).toContain("获取验证码");
    expect(html).toContain("手机号一键登录");
    expect(html).toContain("账号密码登录");
    expect(html).toContain("道引统一账号");
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).not.toContain("Harness 账号注册");
    expect(html).not.toContain("内容创作");
    expect(html).not.toContain("使用主平台登录页");
    expect(html).toContain("poster=");
    expect(html).toContain("login-hero-ribbon-loop-v1.mp4");
    expect(html).toContain('autoPlay=""');
    expect(html).not.toContain("<video src=");
  });
});
