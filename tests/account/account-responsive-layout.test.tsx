import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const css = readFileSync(path.join(root, "app/account/account.module.css"), "utf8");
const client = readFileSync(path.join(root, "app/account/AccountClient.tsx"), "utf8");
const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");

function between(source: string, start: string, end?: string) {
  const from = source.indexOf(start);
  expect(from, `缺少 ${start}`).toBeGreaterThanOrEqual(0);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  expect(to, `缺少 ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("个人中心窄屏布局", () => {
  it("319px 导航三项等分且不换行，极窄屏优先隐藏图标", () => {
    const tablet = between(css, "@media (max-width: 820px)", "@media (max-width: 580px)");
    const phone = between(css, "@media (max-width: 580px)", "@media (max-width: 360px)");
    const narrow = between(css, "@media (max-width: 360px)");

    expect(tablet).toMatch(/\.sidebarNav\s*>\s*button\s*{[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0;[^}]*white-space:\s*nowrap;/);
    expect(phone).toMatch(/\.sidebarNav\s*>\s*button\s*{[^}]*font-size:\s*12px;/);
    expect(narrow).toMatch(/\.sidebarNav\s*>\s*button\s*>\s*span\s*{[^}]*display:\s*none;/);
  });

  it("移动端隐藏重复大页头，桌面规则仍保留完整标题层级", () => {
    expect(css).toMatch(/\.pageHeader\s*{[^}]*padding-bottom:\s*24px;/);
    const tablet = between(css, "@media (max-width: 820px)", "@media (max-width: 580px)");
    expect(tablet).toMatch(/\.pageHeader\s*{[^}]*display:\s*none;/);
  });

  it("公开资料使用独立的真名与紧凑字段规则，头像在手机上转为横向布局", () => {
    expect(client).toContain("className={styles.profileNameField}");
    expect(client).toContain("className={styles.compactField}");
    expect(client).toContain('className={`${styles.fullField} ${styles.compactField}`}');
    const phone = between(css, "@media (max-width: 580px)", "@media (max-width: 360px)");
    expect(phone).toMatch(/\.avatarEditor\s*{[^}]*flex-direction:\s*row;/);
    expect(phone).toMatch(/\.compactField\s*{[^}]*gap:\s*4px !important;/);
    expect(phone).toMatch(/\.profileNameField\s*{[^}]*margin-bottom:\s*4px;/);
  });

  it("邮箱绑定与兑换码使用可收缩的输入列，按钮不会把窄屏撑宽", () => {
    expect(client).toContain("styles.bindRow");
    expect(client).toContain("styles.redeemForm");
    const phone = between(css, "@media (max-width: 580px)", "@media (max-width: 360px)");
    expect(phone).toMatch(/\.bindForm\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
    expect(phone).toMatch(/\.redeemForm\s*{[^}]*gap:\s*6px;/);
    expect(css).toMatch(/\.bindInput\s*{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.redeemField input\s*{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.row\s*>\s*\.rowInfo span\s*{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it("手机与平板输入控件保持 16px，聚焦时不会触发 iOS Safari 自动放大", () => {
    const mobileGlobals = between(globals, "@media (max-width: 1023px)", "/* iOS Safari 的 Visual Viewport");
    expect(mobileGlobals).toMatch(/input,[\s\S]*textarea,[\s\S]*select,[\s\S]*font-size:\s*16px !important;/);

    const accountMobile = between(css, "@media (max-width: 820px)");
    expect(accountMobile).not.toMatch(/font-size:\s*(?:[0-9]|1[0-5])px[^;]*;\s*\n?[^}]*\b(?:input|textarea|select)\b/);
  });

  it("319px 的资料占位文字与主要通道保持 13px，显示名使用通用文案", () => {
    expect(client).toContain('placeholder="请输入显示名"');
    expect(client).not.toContain('placeholder="如：林淼 · 舞监"');

    const baseControl = between(css, ".formGrid input,", ".formGrid input:focus");
    expect(baseControl).toMatch(/font-size:\s*13px;/);
    const phone = between(css, "@media (max-width: 580px)", "@media (max-width: 360px)");
    expect(phone).toMatch(/\.compactField input::placeholder,[\s\S]*?\.compactField textarea::placeholder\s*{[^}]*font-size:\s*13px;/);
  });

  it("邮箱占位文字与身份标题同为 13px，两类身份使用同尺寸模版色图标", () => {
    expect(client).toContain('<IdentityIcon platformId="feishu" />');
    expect(client).toContain('<IdentityIcon platformId="email" />');
    expect(client).not.toContain('<span className={styles.rowIcon}>书</span>');
    expect(client).not.toContain('<span className={styles.rowIcon}>邮</span>');

    expect(css).toMatch(/\.row > \.rowInfo b\s*{[^}]*font-size:\s*13px;/);
    expect(css).toMatch(/\.bindInput::placeholder\s*{[^}]*font-size:\s*13px;/);
    expect(css).toMatch(/\.identityGlyph\s*{[^}]*width:\s*21px;[^}]*height:\s*21px;[^}]*fill:\s*currentColor;/);
    expect(css).toMatch(/\.rowIcon\s*{[^}]*background:\s*var\(--script-soft\);[^}]*color:\s*var\(--script\);/);
  });

  it("用可收缩列与断行规则守住从 319px 到桌面的横向布局", () => {
    expect(css).toMatch(/\.layout\s*{[^}]*width:\s*min\(1160px, calc\(100% - 48px\)\);/);
    expect(css).toMatch(/\.main\s*{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.profileNameField,[\s\S]*?\.compactField\s*{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.bindForm\s*{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.row > \.rowInfo span\s*{[^}]*overflow-wrap:\s*anywhere;/);
  });
});
