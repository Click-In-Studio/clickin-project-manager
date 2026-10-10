// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import CuePage from '@/components/ops/CuePage';
import type { Cue } from '@/lib/ops/cue-types';
import type { Props } from '@/components/ops/cue-page/types';
vi.mock('@/components/shell/ProductionTopMenu', async () => {
  const React = await import('react');
  return {
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ProductionTopMenuContext: () => null, ProductionTopMenuDivider: () => null,
    ProductionOverflowSubmenuButton: () => null,
    PRODUCTION_PAGE_SCROLL_ROOT_CLASS: '', PRODUCTION_TOP_MENU_RIGHT_CLASS: '',
    PRODUCTION_TOOLBAR_STAGE: { secondaryStored: 2, primaryShort: 3, primaryStored: 4 },
    useProductionToolbar: () => ({ stage: 0, closeOverflow: () => {}, overflowOpen: false }),
    useAnchoredMenu: () => ({ anchorRef: React.useRef(null), menuRef: React.useRef(null), style: {} }),
  };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource extends EventTarget {
  static latest: FakeEventSource;
  constructor(_url: string) { super(); FakeEventSource.latest = this; }
  close() {}
}
function cue(listId: string, name: string) {
  return { id: `cue-${listId}`, cueListId: listId, number: '1', name, content: '', warning: false,
    start: { kind: 'block', blockId: 'b1', offset: 1 }, end: { kind: 'block', blockId: 'b1', offset: 1 } };
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(status: number, data: unknown) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
let root: Root, container: HTMLDivElement;
let pending: { listId: string; method: string; body?: unknown; request: ReturnType<typeof deferred> }[];
const props = { productionId: 'p934', blocks: [{ id: 'b1', type: 'stage', content: '正文内容', order: 0, characterIds: [] }],
  characters: [], scenes: [], cueLists: [{ id: 'l1', name: '灯光' }, { id: 'l2', name: '音响' }],
  initialCues: [cue('l1', '灯光初始'), cue('l2', '音响初始')], editableListIds: ['l1'], manageListIds: [],
  myUserId: 'u934', isAdmin: false, pageMap: {}, versionId: 'v1' } as unknown as Props;
const chip = (id: string) => container.querySelector(`[data-chip-cue-id="cue-${id}"]`)?.textContent ?? null;
async function trigger(type: 'open' | 'message' = 'open') {
  await act(async () => { FakeEventSource.latest.dispatchEvent(new Event(type)); await vi.advanceTimersByTimeAsync(300); });
}
async function settle(index: number, status: number, data: unknown) {
  await act(async () => { pending[index].request.resolve(response(status, data)); });
}
beforeEach(async () => {
  vi.useFakeTimers(); pending = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const match = url.match(/cuelists\/([^/]+)\/cues/);
    if (match) { const request = deferred(); pending.push({ listId: match[1], method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined, request }); return request.promise; }
    return Promise.resolve(response(200, {}));
  }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<CuePage {...props} />); });
  FakeEventSource.latest.dispatchEvent(new Event('open'));
  expect(chip('l1')).toContain('灯光初始'); expect(chip('l2')).toContain('音响初始');
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const writes = () => pending.filter(call => call.method === 'PATCH');
async function finishWrite(status: number, data: unknown) {
  await act(async () => writes().at(-1)!.request.resolve(response(status, data)));
}
function edit(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function select() {
  act(() => container.querySelector('[data-chip-cue-id="cue-l1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  return container.querySelector('[data-chip-cue-id="cue-l1"] input[placeholder="名称"]') as HTMLInputElement;
}
describe('真实 CuePage 编辑与 SSE 接线', () => {
  it('聚焦草稿对账后提交仍传原值；失败保留草稿与明确提示', async () => {
    const input = select(); act(() => input.focus()); edit(input, '本地草稿');
    await trigger(); await settle(0, 200, [cue('l1', '线上新名称')]); await settle(1, 200, [cue('l2', '最新音响')]);
    expect(input.value).toBe('本地草稿');
    act(() => input.blur());
    expect(writes()[0].body).toEqual({ name: '本地草稿', basis: { name: '灯光初始' } });
    expect(input.value).toBe('本地草稿');
    await finishWrite(503, {});
    expect(input.value).toBe('本地草稿'); expect(container.textContent).toContain('等待网络');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(writes()[1].body).toEqual(writes()[0].body);
    await finishWrite(409, { error: 'Cue 已被修改' });
    expect(input.value).toBe('本地草稿'); expect(container.textContent).toContain('本地修改未上传');
  });
  it('一笔保存冲突不会卸载另一字段正在输入的草稿', async () => {
    const input = select(); act(() => input.focus()); edit(input, '正在提交的名称'); act(() => input.blur());
    const content = container.querySelector('input[placeholder="—"].flex-1') as HTMLInputElement;
    expect(content).not.toBeNull(); act(() => content.focus()); edit(content, '尚未提交的内容');
    await finishWrite(409, { error: '名称已被修改' });
    expect(content.isConnected).toBe(true); expect(content.value).toBe('尚未提交的内容');
    act(() => content.blur());
    expect(content.value).toBe('尚未提交的内容'); expect(writes()).toHaveLength(1);
  });
  it('旧读取不能覆盖已保存的名称，失败表不消失', async () => {
    await trigger(); const input = select(); act(() => input.focus()); edit(input, '保存新值'); act(() => input.blur());
    await finishWrite(200, { cue: cue('l1', '保存新值') as Cue });
    await settle(0, 200, [cue('l1', '旧值')]); await settle(1, 503, {});
    expect(input.value).toBe('保存新值'); expect(chip('l2')).toContain('音响初始');
  });
  it('成功空表清空，其他成功列表立即更新', async () => {
    await trigger(); await settle(1, 200, [cue('l2', '音响最新')]);
    expect(chip('l2')).toContain('音响最新');
    await settle(0, 200, []); expect(chip('l1')).toBeNull();
  });
});
