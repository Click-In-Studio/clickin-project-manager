// 媒体接收校验不依赖浏览器播放器或当前模型的原生输入能力。
import { imageSize } from "image-size";
import { Input, BufferSource, WAVE, FLAC, MP3, OGG, MP4 } from "mediabunny";

export const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff", "image/bmp": "bmp",
  "audio/wav": "wav", "audio/flac": "flac", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a",
};

type Measurements = { width?: number; height?: number; durationSeconds?: number; sampleRate?: number; channels?: number };

/** 元数据可来自基础工具的 files 数组，也可来自生成能力的单对象；保留输出索引。 */
export function mediaMetadata(outputs: Record<string, unknown>, index: number): Record<string, unknown>[] {
  return Object.values(outputs).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const selected = Array.isArray(item.files) ? item.files[index] : item;
    return selected && typeof selected === "object" && !Array.isArray(selected) ? [selected as Record<string, unknown>] : [];
  });
}

export async function inspectMediaOutput(bytes: Buffer, mimeType: string, metadata: Record<string, unknown>[]): Promise<Measurements> {
  if (mimeType.startsWith("image/")) {
    const image = imageSize(bytes);
    const actualMime = image.type === "jpg" ? "image/jpeg" : `image/${image.type}`;
    if (!image.width || !image.height || actualMime !== mimeType) throw new Error("图片实际格式与声明不符或无法读取尺寸");
    if (!metadata.some((item) => item.width === image.width && item.height === image.height)) {
      throw new Error("图片尺寸与结构化 metadata 不一致");
    }
    return { width: image.width, height: image.height };
  }
  const formats = { "audio/wav": WAVE, "audio/flac": FLAC, "audio/mpeg": MP3, "audio/ogg": OGG, "audio/mp4": MP4 };
  const format = formats[mimeType as keyof typeof formats];
  if (!format) throw new Error(`尚未接入的媒体输出格式 ${mimeType}`);
  const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: [format] });
  try {
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration(undefined, { skipLiveWait: true });
    if (!audio || !audio.codec || await input.getPrimaryVideoTrack() || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("媒体不是可识别的纯音频或时长无效");
    }
    if (!metadata.some((item) => item.sample_rate === audio.sampleRate && item.channels === audio.numberOfChannels
      && typeof item.duration_sec === "number" && Math.abs(item.duration_sec - duration) <= Math.max(0.1, 2 / audio.sampleRate))) {
      throw new Error("音频采样率、声道或时长与结构化 metadata 不一致");
    }
    return { durationSeconds: duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels };
  } finally { input.dispose(); }
}
