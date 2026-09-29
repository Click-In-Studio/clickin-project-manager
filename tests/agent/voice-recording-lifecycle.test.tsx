// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoiceRecordButton from "@/components/agent/VoiceRecordButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeMediaRecorder {
  static latest: FakeMediaRecorder | null = null;
  static isTypeSupported(type: string) { return type === "audio/mp4"; }
  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "video/mp4";
    FakeMediaRecorder.latest = this;
  }

  start() { this.state = "recording"; }
  stop() {
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.state = "inactive";
    this.onstop?.();
  }
}

describe("VoiceRecordButton 录音生命周期", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stopTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stopTrack = vi.fn();
    FakeMediaRecorder.latest = null;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stream(): MediaStream {
    return { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  }

  async function render(getUserMedia: () => Promise<MediaStream>, onRecorded = vi.fn(async (_file: File) => {})) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    await act(async () => {
      root.render(<VoiceRecordButton disabled={false} cancelKey="open:s1" onRecorded={onRecorded} onError={vi.fn()} />);
    });
    return { button: container.querySelector("button")!, onRecorded };
  }

  it("授权尚未返回时松手，会在授权返回后立即释放麦克风且不录音", async () => {
    let resolveStream!: (value: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolveStream = resolve; });
    const { button, onRecorded } = await render(() => pending);

    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
      button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientY: 500 }));
      resolveStream(stream());
      await pending;
    });

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.latest).toBeNull();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("上滑进入取消区后松手，停止轨道但不发送录音", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { button, onRecorded } = await render(async () => stream());
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
      await Promise.resolve();
    });
    now.mockReturnValue(1_500);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientY: 430 }));
      button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientY: 430 }));
      await Promise.resolve();
    });

    expect(stopTrack).toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
    expect(button.textContent).toBe("🎤");
  });

  it("未滑入取消区时松手，生成音频文件并发送", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { button, onRecorded } = await render(async () => stream());
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
      await Promise.resolve();
    });
    now.mockReturnValue(1_500);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientY: 470 }));
      await Promise.resolve();
    });

    expect(onRecorded).toHaveBeenCalledOnce();
    const file = onRecorded.mock.calls[0][0];
    expect(file).toMatchObject({ type: "audio/mp4" });
    expect(file.name.endsWith(".m4a")).toBe(true);
  });
});
