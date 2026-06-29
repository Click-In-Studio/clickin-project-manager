import { formatDuration, parseDuration } from "@/lib/duration";

type SceneDurationSource = {
  id: string;
  number: string;
  parentId: string | null;
  expectedDuration: string;
};

type ChapterDurationDisplay = {
  text: string;
  hasMissingDuration: boolean;
};

export function getChapterDurationDisplay(
  children: SceneDurationSource[]
): ChapterDurationDisplay {
  const missingSceneNumbers: string[] = [];
  let totalSeconds = 0;

  for (const child of children) {
    const expectedDuration = child.expectedDuration.trim();
    const seconds = expectedDuration ? parseDuration(expectedDuration) : null;
    if (seconds == null) {
      missingSceneNumbers.push(child.number.trim() || "未编号段落");
    } else {
      totalSeconds += seconds;
    }
  }

  if (missingSceneNumbers.length > 0) {
    return {
      text: `${missingSceneNumbers.join(", ")} 未设置预计时长`,
      hasMissingDuration: true,
    };
  }

  return {
    text: formatDuration(totalSeconds) || "—",
    hasMissingDuration: false,
  };
}
