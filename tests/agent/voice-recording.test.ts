import { describe, expect, it } from "vitest";
import {
  isVoiceCancelGesture,
  pickVoiceMimeType,
  voiceFileName,
} from "@/components/agent/VoiceRecordButton";

describe("移动端语音录制", () => {
  it("优先选择 Safari 可用的 audio/mp4，再退回 Opus 容器", () => {
    expect(pickVoiceMimeType({ isTypeSupported: (type) => type === "audio/mp4" })).toBe("audio/mp4");
    expect(pickVoiceMimeType({ isTypeSupported: (type) => type === "audio/webm;codecs=opus" })).toBe("audio/webm;codecs=opus");
    expect(pickVoiceMimeType({ isTypeSupported: (type) => type === "audio/ogg;codecs=opus" })).toBe("audio/ogg;codecs=opus");
    expect(pickVoiceMimeType({ isTypeSupported: () => false })).toBeUndefined();
  });

  it("即使 Safari 回报 video/mp4，录音文件仍使用音频扩展名", () => {
    expect(voiceFileName("video/mp4", Date.UTC(2026, 8, 29))).toBe("voice-2026-09-29T00-00-00-000Z.m4a");
  });

  it("上滑越过取消区才在松手时取消", () => {
    expect(isVoiceCancelGesture(500, 445)).toBe(false);
    expect(isVoiceCancelGesture(500, 444)).toBe(true);
    expect(isVoiceCancelGesture(500, 560)).toBe(false);
  });
});
