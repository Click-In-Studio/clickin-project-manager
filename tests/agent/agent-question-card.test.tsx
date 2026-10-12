// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { QuestionInfo } from "@/lib/agent/chat/stream-reducer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock("next/navigation",()=>({ usePathname:()=>"/",useRouter:()=>({ refresh:vi.fn() }) }));

import { QuestionCard } from "@/components/agent/AgentPopout";

let container: HTMLDivElement;
let root: Root;
beforeEach(()=>{
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T10:37:00+08:00"));
  container=document.createElement("div");
  document.body.appendChild(container);
  root=createRoot(container);
});
afterEach(()=>{
  act(()=>root.unmount());
  container.remove();
  vi.useRealTimers();
});

const question: QuestionInfo={
  id:"aq_context",toolCallId:"c_context",waitMode:"continue_independent",status:"pending",
  createdAtMs:new Date("2026-10-12T10:00:00+08:00").getTime(),
  continuation:{ continueWith:"核对枪声次数、人物动作和已有素材",blockedUntilAnswer:"确定最终音色并写入 Cue" },
  questions:[{ questionId:"style",header:"枪声风格",question:"这一枪希望写实还是舞台化？",
    options:[{ label:"写实" },{ label:"舞台化" }] }],
};

describe("Agent 提问卡",()=>{
  it("让迟归用户看见提问时间、原问题以及继续/等待边界",()=>{
    act(()=>root.render(<QuestionCard question={{...question,originRunStatus:"completed"}} onSubmit={vi.fn()} onCancel={vi.fn()} />));
    expect(container.textContent).toContain("待你补充");
    expect(container.textContent).toContain("提问于 37 分钟前");
    expect(container.textContent).toContain("其他部分已完成");
    expect(container.textContent).toContain("已继续：核对枪声次数、人物动作和已有素材");
    expect(container.textContent).toContain("仍等待：确定最终音色并写入 Cue");
    expect(container.querySelector("[title='2026/10/12 10:00:00']")).toBeTruthy();
  });

  it("回答仍按原 questionId 提交，完成态显示实际答案",()=>{
    const onSubmit=vi.fn();
    act(()=>root.render(<QuestionCard question={question} onSubmit={onSubmit} onCancel={vi.fn()} />));
    act(()=>Array.from(container.querySelectorAll("button")).find((button)=>button.textContent==="舞台化")!.click());
    expect(onSubmit).toHaveBeenCalledWith({ style:["舞台化"] });

    act(()=>root.render(<QuestionCard question={{...question,status:"answered",answer:{style:["舞台化"]}}}
      status="answered" onSubmit={onSubmit} onCancel={vi.fn()} />));
    expect(container.textContent).toContain("已回答");
    expect(container.textContent).toContain("枪声风格：舞台化");
  });
});
