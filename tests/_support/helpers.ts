// Fixed UUID for the test system user — matches app_user.id inserted in global-setup.ts
export const TEST_USER = "00000000-0000-0000-0000-000000000001";
/**
 * 建演出用的专用 owner（production.owner_id NOT NULL）。
 * **刻意与 TEST_USER 分开**：owner 在每个门顶端恒真（isOwner 旁路），若拿 TEST_USER
 * 当 owner，凡是以 TEST_USER 为被测主体的权限断言都会静默变成空转。
 */
export const TEST_OWNER = "00000000-0000-0000-0000-0000000000ff";
